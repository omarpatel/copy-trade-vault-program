/**
 * Checks the dev stack before `pnpm dev` starts indexer + keeper + web, and fails fast (exit 1) with the command
 * that fixes it: validator unreachable, pump programs not cloned, copier program not deployed, config not
 * initialized, keeper key missing or not the config's keeper, platform ALT missing, a service port taken.
 *
 * Env: CLUSTER / RPC_URL / KEYS_DIR (see common.ts), KEEPER_KEYPAIR (default: the one setup generated, localnet),
 *      PORT (indexer, 8790), STATUS_PORT (keeper, 8792).
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { COPIER_PROGRAM_ID, PUMP_AMM_PROGRAM_ID, PUMP_FEES_PROGRAM_ID, PUMP_PROGRAM_ID, configPda, decodeConfig } from "@copy-trade-vault/sdk";
import { CLUSTER, CONFIG_FILE, IS_LOCAL, ROOT, RPC_URL, STATE_DIR, readJson, rel, type ChainConfig } from "./common";

class PreflightError extends Error {
  constructor(
    problem: string,
    readonly fix: string,
  ) {
    super(problem);
  }
}

function fail(problem: string, fix: string): never {
  throw new PreflightError(problem, fix);
}

/** Something already accepts connections on localhost:port (IPv4 or IPv6, e.g. Next binds `::`). */
async function portInUse(port: number): Promise<boolean> {
  for (const host of ["127.0.0.1", "::1"]) {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    const sock = net.connect({ port, host });
    sock.setTimeout(1_000);
    sock.once("connect", () => resolve(true));
    sock.once("timeout", () => resolve(false));
    sock.once("error", () => resolve(false));
    const used = await promise;
    sock.destroy();
    if (used) return true;
  }
  return false;
}

async function run(): Promise<void> {
  const connection = new Connection(RPC_URL, "confirmed");
  const version = await connection.getVersion().catch(() => null);
  if (!version) {
    fail(`validator not reachable at ${RPC_URL}`, IS_LOCAL ? "start it: pnpm localnet   (fresh chain: pnpm reset:localnet)" : "check RPC_URL");
  }

  const [pump, amm, fees, program] = await connection.getMultipleAccountsInfo([
    PUMP_PROGRAM_ID,
    PUMP_AMM_PROGRAM_ID,
    PUMP_FEES_PROGRAM_ID,
    COPIER_PROGRAM_ID,
  ]);
  if (!pump?.executable || !amm?.executable || !fees?.executable) {
    fail("pump / pump_amm / pump_fees are not on this chain", IS_LOCAL ? "restart from a fresh ledger (clones mainnet): pnpm localnet start --reset" : "wrong cluster?");
  }
  if (!program?.executable) {
    fail(
      `program ${COPIER_PROGRAM_ID.toBase58()} is not deployed on ${RPC_URL}`,
      IS_LOCAL ? "anchor build (in WSL), then: pnpm localnet deploy" : "deploy the program first",
    );
  }

  const configInfo = await connection.getAccountInfo(configPda());
  const setup = IS_LOCAL ? "pnpm setup:localnet" : `CLUSTER=${CLUSTER} pnpm setup:cluster`;
  if (!configInfo) fail("copier config not initialized on this chain", setup);
  const config = decodeConfig(configInfo.data);

  const chain = readJson<ChainConfig>(CONFIG_FILE);
  if (!chain || chain.genesisHash !== (await connection.getGenesisHash())) fail(`${rel(CONFIG_FILE)} is missing or from another chain`, setup);
  const alt = await connection.getAddressLookupTable(new PublicKey(chain.alt));
  if (!alt.value) fail(`platform ALT ${chain.alt} missing`, setup);

  const keeperPath = path.resolve(ROOT, process.env.KEEPER_KEYPAIR?.trim() || chain.keeperKeypair || path.join(STATE_DIR, "keeper.json"));
  if (!fs.existsSync(keeperPath)) fail(`keeper keypair ${keeperPath} not found`, `${setup} (or set KEEPER_KEYPAIR)`);
  const keeper = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(keeperPath, "utf8")) as number[]));
  if (!keeper.publicKey.equals(config.keeper)) {
    fail(
      `${keeperPath} (${keeper.publicKey.toBase58()}) is not the config keeper (${config.keeper.toBase58()})`,
      "point KEEPER_KEYPAIR at the keeper key (or change the on-chain keeper with set_keeper)",
    );
  }
  const keeperBalance = await connection.getBalance(keeper.publicKey);
  if (keeperBalance < 100_000_000) fail(`keeper ${keeper.publicKey.toBase58()} has < 0.1 SOL for fees`, IS_LOCAL ? `${setup} (tops it up)` : "fund the keeper");

  const ports: [string, number][] = [
    ["indexer (PORT)", Number(process.env.PORT || 8790)],
    ["keeper status (STATUS_PORT)", Number(process.env.STATUS_PORT || 8792)],
  ];
  for (const [what, port] of ports) {
    if (await portInUse(port)) fail(`port ${port} for the ${what} is already in use`, "stop the process holding it (another `pnpm dev`?)");
  }
  const platformMint = config.platformMint.equals(PublicKey.default) ? "not set yet (pnpm seed:localnet)" : config.platformMint.toBase58();
  console.log(
    `✓ preflight: ${RPC_URL} (solana-core ${version["solana-core"]}), pump programs + copier program + config ready, ` +
      `keeper ${keeper.publicKey.toBase58()}, the platform token ${platformMint}, ports free`,
  );
}

// Exit through exitCode, not process.exit(): on Windows exiting while a probe socket is still closing aborts
// node (libuv `!(handle->flags & UV_HANDLE_CLOSING)`).
run().catch((err: unknown) => {
  const fix = err instanceof PreflightError ? err.fix : "see the error above";
  console.error(`\n✗ preflight: ${err instanceof Error ? err.message : String(err)}\n  → ${fix}\n`);
  process.exitCode = 1;
});
