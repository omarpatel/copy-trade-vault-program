/**
 * Live activity on a seeded localnet until Ctrl+C: the test KOLs buy and sell the plain pump.fun coins (on the
 * curve, and on PumpSwap once a coin graduated) — the target trades the keeper copies — while public wallets
 * trade the copier coins so creator fees keep flowing to the vaults. Every so often a new plain coin launches;
 * curves that complete are migrated (permissionless). Run `pnpm seed:localnet` first; run the keeper
 * (`pnpm dev`) alongside so copies, fee cranks, profits and burns happen.
 *
 * Env: RPC_URL (default http://127.0.0.1:8899), INDEXER_URL (for new coins' metadata),
 *      SIM_INTERVAL_MS (pause between actions, default 3000), SIM_DURATION_SECS (stop after; default: never),
 *      SIM_MAX_COINS (plain coins before launches stop, default 12).
 */
import { Connection, PublicKey, type Keypair } from "@solana/web3.js";
import { fmtSol } from "@copy-trade-vault/sdk";
import { setTimeout as sleep } from "node:timers/promises";
import {
  INDEXER_URL,
  RPC_URL,
  SEED_FILE,
  errorMessage,
  lamports,
  loadConfig,
  loadOrCreateKeypair,
  lookupTable,
  main,
  requireLocalnet,
  pick,
  rand,
  reachable,
  readJson,
  topUp,
  writeJson,
} from "./common";
import { Market } from "./market";
import { upload } from "./metadata";
import type { Glyph } from "./png";
import type { SeedFile } from "./seed";

const INTERVAL_MS = Number(process.env.SIM_INTERVAL_MS ?? 3_000);
const DURATION_SECS = Number(process.env.SIM_DURATION_SECS ?? 0);
const MAX_COINS = Number(process.env.SIM_MAX_COINS ?? 12);

const NEW_COINS: { name: string; symbol: string; glyph: Glyph; from: string; to: string }[] = [
  { name: "Hyperdrive", symbol: "HYPER", glyph: "bolt", from: "#22d3ee", to: "#7c3aed" },
  { name: "Sunfish", symbol: "SUNF", glyph: "orbit", from: "#fde047", to: "#f97316" },
  { name: "Glasshouse", symbol: "GLASS", glyph: "diamond", from: "#e0f2fe", to: "#0369a1" },
  { name: "Night Market", symbol: "NIGHT", glyph: "eye", from: "#312e81", to: "#db2777" },
  { name: "Pebble", symbol: "PEB", glyph: "ring", from: "#d6d3d1", to: "#57534e" },
  { name: "Tidal", symbol: "TIDE", glyph: "wave", from: "#5eead4", to: "#1e40af" },
  { name: "Pyramid Scheme", symbol: "PYRA", glyph: "prism", from: "#fcd34d", to: "#b45309" },
];

const short = (k: PublicKey | string) => k.toString().slice(0, 6);

main(async () => {
  requireLocalnet("simulate");
  const connection = new Connection(RPC_URL, "confirmed");
  const config = await loadConfig(connection);
  const seed = readJson<SeedFile>(SEED_FILE);
  if (!seed || seed.genesisHash !== config.genesisHash) throw new Error("no seed for this chain: run pnpm seed:localnet first");
  const market = new Market(connection, [await lookupTable(connection, config.alt)]);

  const kols = seed.kols.map((k) => ({ name: k.name, wallet: loadOrCreateKeypair(`seed/kols/${k.handle}`) }));
  const traders = seed.wallets.public.map((_, i) => loadOrCreateKeypair(`seed/public/${String(i + 1).padStart(2, "0")}`));
  const deployer = loadOrCreateKeypair("seed/deployer");
  const coins = () => seed.coins.map((c) => ({ ...c, key: new PublicKey(c.mint) }));
  const copiers = seed.copiers.map((m) => ({ symbol: m.symbol, key: new PublicKey(m.mint) }));

  /** Sells a random part (¼ … all) of what `wallet` holds of `mint`; null when it holds nothing. */
  const trim = async (wallet: Keypair, mint: PublicKey) => {
    const held = await market.tokenBalance(wallet.publicKey, mint);
    if (held === 0n) return null;
    const part = pick([4n, 2n, 1n]);
    return market.sell(wallet, mint, held / part);
  };

  const actions: { weight: number; run: () => Promise<string | null> }[] = [
    {
      // A KOL (target) trade on a plain coin: the signal copiers copy.
      weight: 45,
      run: async () => {
        const kol = pick(kols);
        const coin = pick(coins());
        if (Math.random() < 0.4) {
          const sell = await trim(kol.wallet, coin.key);
          if (sell) return `${kol.name} sold $${coin.symbol} on the ${sell.venue} (${sell.signature})`;
        }
        const buy = await market.buy(kol.wallet, coin.key, lamports(rand(0.2, 3)));
        return `${kol.name} bought ${fmtSol(buy.lamports)} SOL of $${coin.symbol} on the ${buy.venue} (${buy.signature})`;
      },
    },
    {
      // Public volume on the copier coins: creator fees for the vaults and the traders.
      weight: 45,
      run: async () => {
        const trader = pick(traders);
        const copier = pick(copiers);
        if (Math.random() < 0.4) {
          const sell = await trim(trader, copier.key);
          if (sell) return `${short(trader.publicKey)} sold $${copier.symbol} (${sell.signature})`;
        }
        const buy = await market.buy(trader, copier.key, lamports(rand(0.1, 3)));
        return `${short(trader.publicKey)} bought ${fmtSol(buy.lamports)} SOL of $${copier.symbol} (${buy.signature})`;
      },
    },
    {
      // Background volume on the plain coins.
      weight: 8,
      run: async () => {
        const trader = pick(traders);
        const coin = pick(coins());
        const buy = await market.buy(trader, coin.key, lamports(rand(0.1, 1.5)));
        return `${short(trader.publicKey)} bought $${coin.symbol} on the ${buy.venue} (${buy.signature})`;
      },
    },
    {
      // A new plain coin, while fewer than SIM_MAX_COINS exist and the indexer takes uploads.
      weight: 2,
      run: async () => {
        const unused = NEW_COINS.filter((c) => !seed.coins.some((s) => s.symbol === c.symbol));
        if (seed.coins.length >= MAX_COINS || unused.length === 0 || !(await reachable(`${INDEXER_URL}/api/health`))) return null;
        const plan = pick(unused);
        const meta = await upload({ name: plan.name, symbol: plan.symbol, description: `${plan.name}: a localnet test coin.`, design: plan });
        const { mint, signature } = await market.createCoin(deployer, { name: plan.name, symbol: plan.symbol, uri: meta.uri });
        seed.coins.push({ mint: mint.toBase58(), name: plan.name, symbol: plan.symbol, creator: deployer.publicKey.toBase58(), graduated: false });
        writeJson(SEED_FILE, seed);
        return `new coin $${plan.symbol} ${mint.toBase58()} (${signature})`;
      },
    },
  ];
  const totalWeight = actions.reduce((s, a) => s + a.weight, 0);

  const startedAt = Date.now();
  let stopping = false;
  process.on("SIGINT", () => {
    if (stopping) process.exit(130);
    stopping = true;
    console.log("\nstopping after the current action (Ctrl+C again to quit now)…");
  });
  console.log(`simulating on ${RPC_URL}: ${kols.length} KOLs, ${traders.length} public wallets, ${copiers.length} copiers, ${seed.coins.length} coins`);

  for (let tick = 0; !stopping; tick++) {
    if (DURATION_SECS > 0 && Date.now() - startedAt > DURATION_SECS * 1_000) break;
    try {
      // Keep everyone liquid (localnet faucet).
      if (tick % 50 === 0) {
        await Promise.all([
          ...kols.map((k) => topUp(connection, k.wallet.publicKey, 300, 50)),
          ...traders.map((t) => topUp(connection, t.publicKey, 150, 30)),
          topUp(connection, deployer.publicKey, 20, 5),
        ]);
      }
      // Curves that completed get migrated (anyone may).
      for (const coin of coins().filter((c) => !c.graduated)) {
        if ((await market.venue(coin.key)).kind === "complete") {
          const sig = await market.graduate(pick(traders), coin.key);
          seed.coins.find((c) => c.mint === coin.mint)!.graduated = true;
          writeJson(SEED_FILE, seed);
          console.log(`$${coin.symbol} graduated to PumpSwap (${sig})`);
        }
      }
      let roll = Math.random() * totalWeight;
      const action = actions.find((a) => (roll -= a.weight) < 0) ?? actions[0]!;
      const line = await action.run();
      if (line) console.log(`${new Date().toISOString().slice(11, 19)} ${line}`);
    } catch (err) {
      console.warn(`! ${errorMessage(err).split("\n")[0]}`);
    }
    await sleep(INTERVAL_MS * rand(0.5, 1.5));
  }
  console.log("simulation stopped");
});
