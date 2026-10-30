/**
 * Seeds a localnet with a working copy-vault economy through the real programs (run `pnpm setup:localnet` first):
 *
 *  1. six test KOL wallets (fictional names; never real people), funded;
 *  2. plain pump.fun coins the KOLs trade, one graduated to PumpSwap;
 *  3. one copier per KOL, launched with the real launch tx (create_v2 + fee sharing + register_copier, platform
 *     ALT) at different trader cuts, some with a dev buy, and seed capital `deposit`ed by its launcher (one copier
 *     gets none, so the fee-dust-only state below the vault floor is visible too);
 *  4. the platform token index copier over all test KOLs (register_index), `set_platform_mint`, 30 SOL `deposit`;
 *  5. target trades by the KOLs (the keeper copies them when it runs) and public trading on the copier coins so
 *     creator fees accrue, then one fee distribution crank per copier (sweep + distribute_creator_fees_v2 + sync).
 *
 * Writes `.localnet/seed.json` (KOL names for the indexer directory via LOCALNET_KOLS, copiers, coins, wallets,
 * signatures). Idempotent per chain: KOLs, coins and copiers already in seed.json for this genesis are kept, not
 * launched again; a seeded copier whose `capital_in` is still 0 gets its planned deposit; trading and the fee
 * crank run on every invocation. Wallets live in `.localnet/seed/` and are reused (topped up). Coin metadata
 * goes through the indexer's upload endpoint (started for the duration when not running).
 *
 * Env: RPC_URL (default http://127.0.0.1:8899), INDEXER_URL (default http://127.0.0.1:8790).
 */
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  buildDepositIx,
  buildDistributeFeesIxs,
  buildLaunchIndexIxs,
  buildLaunchIxs,
  buildSetPlatformMintIx,
  creatorVaultPda,
  fetchConfig,
  fetchCopier,
  fmtSol,
  copierShareholders,
  sharingConfigPda,
  vaultPda,
} from "@copy-trade-vault/sdk";
import path from "node:path";
import {
  SEED_FILE,
  lamports,
  loadConfig,
  loadOrCreateKeypair,
  lookupTable,
  main,
  requireLocalnet,
  pick,
  rand,
  readJson,
  send,
  topUp,
  writeJson,
  ROOT,
  RPC_URL,
  loadAdmin,
} from "./common";
import { Market } from "./market";
import { upload, withIndexer } from "./metadata";
import type { LogoDesign } from "./png";

// ---------------------------------------------------------------- plan

interface KolPlan {
  handle: string;
  name: string;
  avatar: LogoDesign;
  /** `seedSol`: the launcher's `deposit` right after the launch (0 = fee income only). */
  copier: { name: string; symbol: string; traderBps: number; devBuySol: number; seedSol: number; design: LogoDesign };
}

const KOLS: KolPlan[] = [
  {
    handle: "orcawhale",
    name: "Orca Whale",
    avatar: { from: "#0f172a", to: "#0ea5e9", glyph: "wave" },
    copier: { name: "Orca Copier", symbol: "cORCA", traderBps: 2_500, devBuySol: 1.5, seedSol: 8, design: { from: "#7ee8fa", to: "#1d4ed8", glyph: "wave" } },
  },
  {
    handle: "nightowl",
    name: "Night Owl",
    avatar: { from: "#1e1b4b", to: "#6d28d9", glyph: "eye" },
    copier: { name: "Night Owl Copier", symbol: "cOWL", traderBps: 1_000, devBuySol: 0, seedSol: 4, design: { from: "#c084fc", to: "#312e81", glyph: "eye" } },
  },
  {
    handle: "goldhands",
    name: "Gold Hands",
    avatar: { from: "#78350f", to: "#f59e0b", glyph: "ring" },
    copier: { name: "Gold Hands Copier", symbol: "cGOLD", traderBps: 500, devBuySol: 2, seedSol: 2, design: { from: "#f5c451", to: "#92400e", glyph: "ring" } },
  },
  {
    handle: "sigmascalper",
    name: "Sigma Scalper",
    avatar: { from: "#064e3b", to: "#10b981", glyph: "bolt" },
    copier: { name: "Sigma Copier", symbol: "cSIGMA", traderBps: 1_500, devBuySol: 0.5, seedSol: 6, design: { from: "#a3e635", to: "#065f46", glyph: "bolt" } },
  },
  {
    handle: "coldcarl",
    name: "Cold Wallet Carl",
    avatar: { from: "#334155", to: "#94a3b8", glyph: "diamond" },
    copier: { name: "Carl Copier", symbol: "cCARL", traderBps: 100, devBuySol: 0, seedSol: 0, design: { from: "#e2e8f0", to: "#0e7490", glyph: "diamond" } },
  },
  {
    handle: "apetheory",
    name: "Ape Theory",
    avatar: { from: "#7c2d12", to: "#f97316", glyph: "orbit" },
    copier: { name: "Ape Theory Copier", symbol: "cAPE", traderBps: 2_000, devBuySol: 1, seedSol: 3, design: { from: "#ff7a45", to: "#9f1239", glyph: "orbit" } },
  },
];

interface CoinPlan {
  name: string;
  symbol: string;
  design: LogoDesign;
  graduate?: boolean;
}

/** Plain pump.fun coins the KOLs trade (the target trades copiers copy). */
const COINS: CoinPlan[] = [
  { name: "Froggo", symbol: "FROG", design: { from: "#84cc16", to: "#166534", glyph: "eye" } },
  { name: "Gigabrain", symbol: "GIGA", design: { from: "#f472b6", to: "#7c3aed", glyph: "prism" }, graduate: true },
  { name: "Lumen", symbol: "LUMEN", design: { from: "#fde68a", to: "#ea580c", glyph: "orbit" } },
  { name: "Moonfish", symbol: "MFISH", design: { from: "#67e8f9", to: "#1e3a8a", glyph: "wave" } },
  { name: "Paper Plane", symbol: "PLANE", design: { from: "#f8fafc", to: "#64748b", glyph: "prism" } },
];

const PLATFORM_TOKEN = {
  name: "Index Vault",
  symbol: "INDEX",
  description:
    "The platform index: copies a basket of KOL wallets with 30 SOL of seed capital plus 100% of its own creator fees. " +
    "Profits buy back and burn the platform token.",
  design: { from: "#f5c451", to: "#0891b2", glyph: "split" } satisfies LogoDesign,
};
const PLATFORM_DEPOSIT_SOL = 30;
const PUBLIC_WALLETS = 8;
const LAUNCHERS = 3;

// ---------------------------------------------------------------- seed.json

export interface SeedKol {
  address: string;
  name: string;
  handle: string;
  avatar?: string;
}

export interface SeedCopier {
  mint: string;
  name: string;
  symbol: string;
  kind: "single" | "index";
  targets: string[];
  traderBps: number;
  launcher: string;
  vault: string;
  uri: string;
  launchSignature: string;
}

export interface SeedCoin {
  mint: string;
  name: string;
  symbol: string;
  creator: string;
  graduated: boolean;
}

export interface SeedFile {
  genesisHash: string;
  ranAt: string;
  rpcUrl: string;
  kols: SeedKol[];
  copiers: SeedCopier[];
  /** the platform token's mint (`config.platform_mint`). */
  platformToken: string | null;
  coins: SeedCoin[];
  wallets: { kols: string[]; launchers: string[]; public: string[]; deployer: string; whale: string };
  signatures: Record<string, string>;
}

// ---------------------------------------------------------------- run

main(async () => {
  requireLocalnet("seed");
  const connection = new Connection(RPC_URL, "confirmed");
  const config = await loadConfig(connection);
  const alt = await lookupTable(connection, config.alt);
  const market = new Market(connection, [alt]);
  const admin = loadAdmin();

  const previous = readJson<SeedFile>(SEED_FILE);
  const sameChain = previous?.genesisHash === config.genesisHash;
  const seed: SeedFile = {
    genesisHash: config.genesisHash,
    ranAt: new Date().toISOString(),
    rpcUrl: RPC_URL,
    kols: sameChain ? previous.kols : [],
    copiers: sameChain ? previous.copiers : [],
    platformToken: sameChain ? previous.platformToken : null,
    coins: sameChain ? previous.coins : [],
    wallets: { kols: [], launchers: [], public: [], deployer: "", whale: "" },
    signatures: sameChain ? previous.signatures : {},
  };
  const save = () => writeJson(SEED_FILE, seed);

  // Wallets.
  console.log("funding wallets…");
  const kols = KOLS.map((k) => loadOrCreateKeypair(`seed/kols/${k.handle}`));
  const launchers = Array.from({ length: LAUNCHERS }, (_, i) => loadOrCreateKeypair(`seed/launchers/${String(i + 1).padStart(2, "0")}`));
  const traders = Array.from({ length: PUBLIC_WALLETS }, (_, i) => loadOrCreateKeypair(`seed/public/${String(i + 1).padStart(2, "0")}`));
  const deployer = loadOrCreateKeypair("seed/deployer");
  const whale = loadOrCreateKeypair("seed/whale");
  await Promise.all([
    ...kols.map((k) => topUp(connection, k.publicKey, 300)),
    ...launchers.map((k) => topUp(connection, k.publicKey, 40, 25)),
    ...traders.map((k) => topUp(connection, k.publicKey, 150)),
    topUp(connection, deployer.publicKey, 20),
    topUp(connection, whale.publicKey, 200, 150),
    topUp(connection, admin.publicKey, 100, PLATFORM_DEPOSIT_SOL + 20),
  ]);
  seed.wallets = {
    kols: kols.map((k) => k.publicKey.toBase58()),
    launchers: launchers.map((k) => k.publicKey.toBase58()),
    public: traders.map((k) => k.publicKey.toBase58()),
    deployer: deployer.publicKey.toBase58(),
    whale: whale.publicKey.toBase58(),
  };

  await withIndexer(async () => {
    // 1. KOL directory entries (avatars through the same upload endpoint).
    for (const [i, plan] of KOLS.entries()) {
      const address = kols[i]!.publicKey.toBase58();
      if (seed.kols.some((k) => k.address === address)) continue;
      const avatar = await upload({ name: plan.name, symbol: plan.handle.slice(0, 10).toUpperCase(), design: plan.avatar });
      seed.kols.push({ address, name: plan.name, handle: plan.handle, avatar: avatar.image });
    }
    save();

    // 2. Plain coins + early public buys; one graduates to PumpSwap.
    const coins: { plan: CoinPlan; mint: PublicKey }[] = [];
    for (const plan of COINS.filter((c) => !seed.coins.some((s) => s.symbol === c.symbol))) {
      const meta = await upload({ name: plan.name, symbol: plan.symbol, description: `${plan.name}: a localnet test coin.`, design: plan.design });
      const { mint, signature } = await market.createCoin(deployer, { name: plan.name, symbol: plan.symbol, uri: meta.uri });
      coins.push({ plan, mint });
      for (const trader of traders.slice(0, 3)) await market.buy(trader, mint, lamports(rand(0.3, 2)));
      seed.coins.push({ mint: mint.toBase58(), name: plan.name, symbol: plan.symbol, creator: deployer.publicKey.toBase58(), graduated: false });
      console.log(`coin $${plan.symbol} ${mint.toBase58()} (${signature})`);
    }
    for (const { plan, mint } of coins.filter((c) => c.plan.graduate)) {
      const signature = await market.graduate(whale, mint);
      seed.coins.find((c) => c.mint === mint.toBase58())!.graduated = true;
      seed.signatures[`migrate:${plan.symbol}`] = signature;
      const buy = await market.buy(pick(traders), mint, lamports(1));
      console.log(`coin $${plan.symbol} graduated to PumpSwap (${signature}); first pool buy ${buy.signature}`);
    }
    save();

    // 3. One copier per KOL (once per chain), seeded by its launcher.
    for (const [i, plan] of KOLS.entries()) {
      const launcher = launchers[i % launchers.length]!;
      const target = kols[i]!.publicKey;
      if (seed.copiers.some((m) => m.symbol === plan.copier.symbol)) continue;
      const mint = Keypair.generate();
      const meta = await upload({
        name: plan.copier.name,
        symbol: plan.copier.symbol,
        description: `Copy-trades ${plan.name} (@${plan.handle}) with this coin's creator fees. ${plan.copier.traderBps / 100}% of fees go to the trader.`,
        design: plan.copier.design,
      });
      const ixs = buildLaunchIxs({
        launcher: launcher.publicKey,
        mint: mint.publicKey,
        name: plan.copier.name,
        symbol: plan.copier.symbol,
        uri: meta.uri,
        target,
        traderBps: plan.copier.traderBps,
      });
      const signature = await send(connection, launcher, ixs, [mint], { lookupTables: [alt], label: `launch ${plan.copier.symbol}` });
      if (plan.copier.devBuySol > 0) await market.buy(launcher, mint.publicKey, lamports(plan.copier.devBuySol));
      seed.copiers.push({
        mint: mint.publicKey.toBase58(),
        name: plan.copier.name,
        symbol: plan.copier.symbol,
        kind: "single",
        targets: [target.toBase58()],
        traderBps: plan.copier.traderBps,
        launcher: launcher.publicKey.toBase58(),
        vault: vaultPda(mint.publicKey).toBase58(),
        uri: meta.uri,
        launchSignature: signature,
      });
      seed.signatures[`launch:${plan.copier.symbol}`] ??= signature;
      save();
      console.log(`copier $${plan.copier.symbol} → ${plan.name} (${plan.copier.traderBps / 100}% to the trader): ${mint.publicKey.toBase58()} (${signature})`);
    }

    // 3b. Seed capital: each KOL copier's launcher deposits its planned amount once (`capital_in` still 0), also for
    //     copiers launched by an earlier run on this chain. Without it a vault holds only fee dust below the floor.
    for (const plan of KOLS) {
      const entry = seed.copiers.find((m) => m.symbol === plan.copier.symbol);
      if (!entry || plan.copier.seedSol <= 0) continue;
      const mint = new PublicKey(entry.mint);
      const copier = await fetchCopier(connection, mint);
      if (!copier) throw new Error(`copier $${plan.copier.symbol} ${entry.mint} not found on chain`);
      if (copier.capitalIn > 0n) continue;
      const launcher = launchers.find((l) => l.publicKey.toBase58() === entry.launcher);
      if (!launcher) throw new Error(`launcher ${entry.launcher} of $${plan.copier.symbol} is not a .localnet/seed/launchers key`);
      const signature = await send(
        connection,
        launcher,
        buildDepositIx({ depositor: launcher.publicKey, mint, lamports: lamports(plan.copier.seedSol) }),
        [],
        { label: `deposit ${plan.copier.symbol}` },
      );
      seed.signatures[`deposit:${plan.copier.symbol}`] = signature;
      save();
      console.log(`$${plan.copier.symbol}: launcher deposited ${plan.copier.seedSol} SOL seed capital (${signature})`);
    }

    // 4. the platform token: index over every test KOL, set as the platform coin, seeded with 30 SOL.
    const onChain = await fetchConfig(connection);
    if (!onChain) throw new Error("config missing: run pnpm setup:localnet");
    if (onChain.platformMint.equals(PublicKey.default)) {
      const mint = Keypair.generate();
      const meta = await upload(PLATFORM_TOKEN);
      const targets = kols.map((k) => k.publicKey);
      const launch = await send(
        connection,
        admin,
        buildLaunchIndexIxs({ admin: admin.publicKey, mint: mint.publicKey, name: PLATFORM_TOKEN.name, symbol: PLATFORM_TOKEN.symbol, uri: meta.uri, targets }),
        [mint],
        { lookupTables: [alt], label: "launch the platform token" },
      );
      const setMint = await send(connection, admin, buildSetPlatformMintIx({ admin: admin.publicKey, mint: mint.publicKey }), [], { label: "set_platform_mint" });
      const deposit = await send(
        connection,
        admin,
        buildDepositIx({ depositor: admin.publicKey, mint: mint.publicKey, lamports: lamports(PLATFORM_DEPOSIT_SOL) }),
        [],
        { label: "deposit" },
      );
      seed.platformToken = mint.publicKey.toBase58();
      seed.copiers.push({
        mint: mint.publicKey.toBase58(),
        name: PLATFORM_TOKEN.name,
        symbol: PLATFORM_TOKEN.symbol,
        kind: "index",
        targets: targets.map((t) => t.toBase58()),
        traderBps: 0,
        launcher: admin.publicKey.toBase58(),
        vault: vaultPda(mint.publicKey).toBase58(),
        uri: meta.uri,
        launchSignature: launch,
      });
      Object.assign(seed.signatures, { "launch:index": launch, setPlatformMint: setMint, "deposit:index": deposit });
      save();
      console.log(`the platform token ${mint.publicKey.toBase58()}: index over ${targets.length} KOLs (${launch}), set_platform_mint (${setMint}), ${PLATFORM_DEPOSIT_SOL} SOL deposit (${deposit})`);
    } else {
      seed.platformToken ??= onChain.platformMint.toBase58();
      console.log(`the platform token already set: ${onChain.platformMint.toBase58()}`);
    }
  });

  // 5a. Target trades: each KOL buys a couple of coins, some trim (the keeper copies these when it runs).
  const liveCoins = seed.coins.map((c) => ({ symbol: c.symbol, mint: new PublicKey(c.mint) }));
  for (const [i, kol] of kols.entries()) {
    const name = KOLS[i]!.name;
    const home = liveCoins[i % liveCoins.length]!;
    for (const coin of [home, pick(liveCoins)]) {
      const buy = await market.buy(kol, coin.mint, lamports(rand(0.5, 3)));
      seed.signatures[`target:${KOLS[i]!.handle}`] ??= buy.signature;
      console.log(`${name} bought ${fmtSol(buy.lamports)} SOL of $${coin.symbol} on the ${buy.venue} (${buy.signature})`);
    }
    if (i % 2 === 1) {
      const sell = await market.sell(kol, home.mint, (await market.tokenBalance(kol.publicKey, home.mint)) / 3n);
      console.log(`${name} sold a third of $${home.symbol} (${sell.signature})`);
    }
  }

  // 5b. Public trading on every copier coin (three wallets each, some take profit): creator fees accrue.
  let publicTrades = 0;
  for (const m of seed.copiers) {
    const mint = new PublicKey(m.mint);
    const buyers = [...traders].sort(() => Math.random() - 0.5).slice(0, 3);
    for (const trader of buyers) {
      await market.buy(trader, mint, lamports(rand(0.5, 4)));
      publicTrades++;
      if (Math.random() < 0.35) {
        await market.sell(trader, mint, (await market.tokenBalance(trader.publicKey, mint)) / 2n);
        publicTrades++;
      }
    }
  }
  console.log(`${publicTrades} public trades on the copier coins`);

  // 5c. One fee distribution per copier with fees pending (permissionless; a running keeper cranks these every
  //     minute, in which case they are already paid out).
  const cranker = traders[0]!;
  const rentExempt = BigInt(await connection.getMinimumBalanceForRentExemption(0));
  /** Below this, pending creator fees are rounding dust (matches the keeper's DISTRIBUTE_MIN_LAMPORTS default). */
  const DISTRIBUTE_MIN_LAMPORTS = 1_000_000n;
  for (const m of seed.copiers) {
    const mint = new PublicKey(m.mint);
    const copier = await fetchCopier(connection, mint);
    if (!copier) throw new Error(`copier ${m.symbol} not found on chain`);
    const venue = await market.venue(mint);
    const creatorVault = BigInt(await connection.getBalance(creatorVaultPda(sharingConfigPda(mint))));
    const swept = creatorVault > rentExempt ? creatorVault - rentExempt : 0n;
    const pending = venue.kind === "curve" ? venue.curve.creatorFee + swept : swept;
    // pump leaves bps rounding dust (≈1 lamport) behind after a distribution; same threshold as the keeper's crank.
    if (venue.kind !== "pool" && pending < DISTRIBUTE_MIN_LAMPORTS) {
      console.log(`$${m.symbol}: no creator fees pending (already distributed by the keeper); vault fees booked ${fmtSol(copier.feesIn)} SOL`);
      continue;
    }
    const signature = await send(
      connection,
      cranker,
      buildDistributeFeesIxs({ payer: cranker.publicKey, mint, graduated: venue.kind === "pool", shareholders: copierShareholders(copier) }),
      [],
      { lookupTables: [alt], label: `distribute ${m.symbol}` },
    );
    const after = await fetchCopier(connection, mint);
    seed.signatures[`distribute:${m.symbol}`] = signature;
    console.log(
      `$${m.symbol}: distributed ${fmtSol(pending)} SOL of creator fees, vault booked +${fmtSol((after?.feesIn ?? 0n) - copier.feesIn)} SOL (${signature})`,
    );
  }
  save();

  console.log(`\nseeded ${seed.copiers.length} copiers, ${seed.coins.length} coins, the platform token ${seed.platformToken}`);
  for (const m of seed.copiers) {
    console.log(`  $${m.symbol.padEnd(7)} ${m.mint}  ${m.kind === "index" ? `index of ${m.targets.length}` : `${m.traderBps / 100}% → ${m.targets[0]}`}`);
  }
  console.log(`wrote ${path.relative(ROOT, SEED_FILE)} · vault balances update as the keeper runs (pnpm dev) · live activity: pnpm simulate:localnet`);
});
