import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  type MessageV0,
  type Signer,
  type TransactionInstruction,
} from "@solana/web3.js";
import { describeError } from "@copy-trade-vault/sdk";
import fs from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export type Cluster = "localnet" | "devnet" | "mainnet-beta";
const CLUSTERS: Record<Cluster, { rpc: string; dir: string }> = {
  localnet: { rpc: "http://127.0.0.1:8899", dir: ".localnet" },
  devnet: { rpc: "https://api.devnet.solana.com", dir: ".devnet" },
  "mainnet-beta": { rpc: "https://api.mainnet-beta.solana.com", dir: ".mainnet" },
};
const clusterEnv = process.env.CLUSTER ?? "localnet";
if (!(clusterEnv in CLUSTERS)) throw new Error(`CLUSTER must be one of ${Object.keys(CLUSTERS).join(", ")} (got ${clusterEnv})`);
/** CLUSTER (default localnet): picks the default RPC and the state directory. */
export const CLUSTER = clusterEnv as Cluster;
/** Keys and state of this cluster: KEYS_DIR, else `.localnet/`, `.devnet/` or `.mainnet/` (all gitignored). */
export const STATE_DIR = path.resolve(ROOT, process.env.KEYS_DIR ?? CLUSTERS[CLUSTER].dir);
export const RPC_URL = process.env.RPC_URL ?? CLUSTERS[CLUSTER].rpc;
/** Solana's convention: websocket on the RPC port + 1 (hosted RPCs serve both on one port). */
export const WS_URL =
  process.env.WS_URL ??
  (CLUSTER === "localnet"
    ? RPC_URL.replace(/^http/, "ws").replace(/:(\d+)(\/|$)/, (_, port: string, rest: string) => `:${Number(port) + 1}${rest}`)
    : RPC_URL.replace(/^http/, "ws"));
export const INDEXER_URL = (process.env.INDEXER_URL ?? "http://127.0.0.1:8790").replace(/\/+$/, "");
/** The indexer's localnet default (apps/indexer): keeper and simulate report with the same token. */
export const INGEST_TOKEN = process.env.INDEXER_INGEST_TOKEN ?? "copier-localnet-ingest";
/** Faucet airdrops and generated keys are allowed (localnet only). */
export const IS_LOCAL = CLUSTER === "localnet";
export const CONFIG_FILE = path.join(STATE_DIR, "config.json");
export const SEED_FILE = path.join(STATE_DIR, "seed.json");

export const sol = (lamports: number | bigint) => Number(lamports) / LAMPORTS_PER_SOL;
export const lamports = (solAmount: number) => BigInt(Math.round(solAmount * LAMPORTS_PER_SOL));
export const rel = (file: string) => path.relative(ROOT, file).replaceAll("\\", "/");

export function readKeypair(file: string): Keypair {
  if (!fs.existsSync(file)) throw new Error(`keypair ${file} not found`);
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf8")) as number[]));
}

/** `<STATE_DIR>/<name>.json` (e.g. `admin`, `seed/kols/orca`), generated on first use. Secrets stay in the file. */
export function loadOrCreateKeypair(name: string): Keypair {
  const file = path.join(STATE_DIR, `${name}.json`);
  if (fs.existsSync(file)) return readKeypair(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const kp = Keypair.generate();
  fs.writeFileSync(file, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
  return kp;
}

/**
 * The admin (config admin = program upgrade authority): ADMIN_KEYPAIR, else `<STATE_DIR>/admin.json`. Generated only
 * on localnet; on real clusters the key must already exist (it deployed the program).
 */
export function loadAdmin(): Keypair {
  const file = process.env.ADMIN_KEYPAIR ? path.resolve(ROOT, process.env.ADMIN_KEYPAIR) : path.join(STATE_DIR, "admin.json");
  if (IS_LOCAL && !process.env.ADMIN_KEYPAIR) return loadOrCreateKeypair("admin");
  return readKeypair(file);
}

/** Refuses to run a localnet-only script (faucet airdrops, generated wallets) against a real cluster. */
export function requireLocalnet(script: string): void {
  if (!IS_LOCAL) throw new Error(`${script} only runs on localnet (CLUSTER=${CLUSTER})`);
}

export function readJson<T>(file: string): T | null {
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as T) : null;
}

export function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** `<STATE_DIR>/config.json`, written by setup.ts. */
export interface ChainConfig {
  cluster: Cluster;
  rpcUrl: string;
  wsUrl: string;
  genesisHash: string;
  programId: string;
  config: string;
  admin: string;
  keeper: string;
  /** Repo-relative path of the keeper keypair setup generated (localnet only; null when KEEPER_PUBKEY was given). */
  keeperKeypair: string | null;
  /** Platform address lookup table (frozen). */
  alt: string;
  indexerUrl: string;
  /** Localnet's default ingest token; null on real clusters (a secret that lives only in indexer/keeper env). */
  ingestToken: string | null;
}

/** The setup of the chain `connection` talks to, or a clear error naming the command that creates it. */
export async function loadConfig(connection: Connection): Promise<ChainConfig> {
  const config = readJson<ChainConfig>(CONFIG_FILE);
  const genesis = await connection.getGenesisHash();
  if (!config || config.genesisHash !== genesis) {
    throw new Error(`${rel(CONFIG_FILE)} does not describe this chain (genesis ${genesis}): run CLUSTER=${CLUSTER} pnpm setup:localnet`);
  }
  return config;
}

export async function lookupTable(connection: Connection, address: PublicKey | string): Promise<AddressLookupTableAccount> {
  const alt = (await connection.getAddressLookupTable(new PublicKey(address))).value;
  if (!alt) throw new Error(`address lookup table ${address.toString()} not found`);
  return alt;
}

/** Faucet airdrop in ≤ 500 SOL requests (localnet only), confirmed. */
export async function airdrop(connection: Connection, to: PublicKey, solAmount: number): Promise<void> {
  for (let left = solAmount; left > 0; left -= 500) {
    const sig = await connection.requestAirdrop(to, Math.round(Math.min(left, 500) * LAMPORTS_PER_SOL));
    const bh = await connection.getLatestBlockhash("confirmed");
    await connection.confirmTransaction({ signature: sig, ...bh }, "confirmed");
  }
}

/** Tops `to` up to `targetSol` when it holds less than `minSol` (default: half the target). */
export async function topUp(connection: Connection, to: PublicKey, targetSol: number, minSol = targetSol / 2): Promise<void> {
  const balance = sol(await connection.getBalance(to, "confirmed"));
  if (balance < minSol) await airdrop(connection, to, Math.ceil(targetSol - balance));
}

export class TxError extends Error {
  constructor(
    message: string,
    readonly logs: string[],
  ) {
    super(message);
  }
}

/** Last program log lines of a failed transaction (the error and what led to it). */
const tailLogs = (logs: string[] | null | undefined) => (logs ?? []).slice(-12).join("\n    ");

export interface SendOptions {
  lookupTables?: AddressLookupTableAccount[];
  /** Compute unit limit; default: simulated × 1.2 (+ 10k headroom). */
  computeUnits?: number;
  label?: string;
}

/** Priority fee (µlamports per CU) on every transaction: PRIORITY_MICROLAMPORTS, default 0 on localnet, 50k elsewhere. */
export const PRIORITY_MICROLAMPORTS = Number(process.env.PRIORITY_MICROLAMPORTS ?? (IS_LOCAL ? 0 : 50_000));
/** Solana's packet limit for a serialized transaction. */
export const MAX_TX_BYTES = 1_232;

function compileMessage(
  payer: PublicKey,
  instructions: TransactionInstruction[],
  units: number,
  blockhash: string,
  lookupTables: AddressLookupTableAccount[],
): MessageV0 {
  const budget = [ComputeBudgetProgram.setComputeUnitLimit({ units })];
  if (PRIORITY_MICROLAMPORTS > 0) budget.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_MICROLAMPORTS }));
  return new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions: [...budget, ...instructions.filter((ix) => !ix.programId.equals(ComputeBudgetProgram.programId))],
  }).compileToV0Message(lookupTables);
}

/** Wire size of a signed v0 transaction carrying `message` (web3.js throws instead of serializing oversized ones). */
function v0TxBytes(message: MessageV0): number {
  const len = (n: number) => (n < 0x80 ? 1 : n < 0x4000 ? 2 : 3);
  const sigs = message.header.numRequiredSignatures;
  const keys = message.staticAccountKeys.length;
  const ixs = message.compiledInstructions.reduce(
    (sum, ix) => sum + 1 + len(ix.accountKeyIndexes.length) + ix.accountKeyIndexes.length + len(ix.data.length) + ix.data.length,
    0,
  );
  const lookups = message.addressTableLookups.reduce(
    (sum, l) => sum + 32 + len(l.writableIndexes.length) + l.writableIndexes.length + len(l.readonlyIndexes.length) + l.readonlyIndexes.length,
    0,
  );
  return (
    len(sigs) + 64 * sigs + 1 + 3 + len(keys) + 32 * keys + 32 + len(message.compiledInstructions.length) + ixs +
    len(message.addressTableLookups.length) + lookups
  );
}

function buildTx(
  payer: Signer,
  instructions: TransactionInstruction[],
  signers: Signer[],
  units: number,
  blockhash: string,
  lookupTables: AddressLookupTableAccount[],
): VersionedTransaction {
  const tx = new VersionedTransaction(compileMessage(payer.publicKey, instructions, units, blockhash, lookupTables));
  tx.sign([payer, ...signers]);
  return tx;
}

export interface Simulation {
  /** Serialized size (bytes) of the signed transaction; > MAX_TX_BYTES cannot be sent. */
  bytes: number;
  unitsConsumed: number;
  /** null when the simulation succeeded. */
  err: unknown;
  /** Human-readable failure (program error name/message, or the size problem); null on success. */
  reason: string | null;
  logs: string[];
}

/**
 * Simulates `instructions` as one v0 transaction against the cluster (nothing is sent). `payer` may be a bare public
 * key: the transaction then goes unsigned (signatures are not verified in a simulation), e.g. a funded stand-in.
 */
export async function simulate(
  connection: Connection,
  payer: Signer | PublicKey,
  instructions: TransactionInstruction[],
  extraSigners: Signer[] = [],
  lookupTables: AddressLookupTableAccount[] = [],
): Promise<Simulation> {
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const payerKey = payer instanceof PublicKey ? payer : payer.publicKey;
  const message = compileMessage(payerKey, instructions, 1_400_000, blockhash, lookupTables);
  const bytes = v0TxBytes(message);
  if (bytes > MAX_TX_BYTES) {
    const reason = `transaction too large (${bytes} > ${MAX_TX_BYTES} bytes)`;
    return { bytes, unitsConsumed: 0, err: reason, reason, logs: [] };
  }
  const tx = payer instanceof PublicKey ? new VersionedTransaction(message) : buildTx(payer, instructions, extraSigners, 1_400_000, blockhash, lookupTables);
  const sim = await connection.simulateTransaction(tx, { sigVerify: false, commitment: "confirmed" });
  const logs = sim.value.logs ?? [];
  const reason = sim.value.err ? describeError({ message: JSON.stringify(sim.value.err), logs }) : null;
  return { bytes, unitsConsumed: sim.value.unitsConsumed ?? 0, err: sim.value.err, reason, logs };
}

/**
 * Builds a v0 transaction (`payer` first signer), sizes its compute limit from a simulation, adds the priority fee,
 * sends it and re-broadcasts every 2 s until it is confirmed or its blockhash expires. Throws `TxError` with the
 * program logs when the simulation or execution fails.
 */
export async function send(
  connection: Connection,
  payer: Signer,
  instructions: TransactionInstruction[],
  extraSigners: Signer[] = [],
  options: SendOptions = {},
): Promise<string> {
  const label = options.label ?? "transaction";
  const lookupTables = options.lookupTables ?? [];
  let units = options.computeUnits;
  if (units === undefined) {
    const sim = await simulate(connection, payer, instructions, extraSigners, lookupTables);
    if (sim.reason) throw new TxError(`${label} simulation failed: ${sim.reason}\n    ${tailLogs(sim.logs)}`, sim.logs);
    units = Math.min(1_400_000, Math.ceil(sim.unitsConsumed * 1.2) + 10_000);
  }
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const raw = buildTx(payer, instructions, extraSigners, units, blockhash, lookupTables).serialize();
  const signature = await connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 });
  const confirmation = connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  let done = false;
  const rebroadcast = (async () => {
    while (!done) {
      await sleep(2_000);
      if (!done) await connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => undefined);
    }
  })();
  const result = await confirmation.finally(() => (done = true));
  await rebroadcast;
  if (result.value.err) {
    const info = await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    const logs = info?.meta?.logMessages ?? [];
    const reason = describeError({ message: JSON.stringify(result.value.err), logs });
    throw new TxError(`${label} failed (${signature}): ${reason}\n    ${tailLogs(logs)}`, logs);
  }
  return signature;
}

/** True when `url` answers HTTP (any status) within 2 s. */
export async function reachable(url: string): Promise<boolean> {
  return fetch(url, { signal: AbortSignal.timeout(2_000) }).then(
    () => true,
    () => false,
  );
}

export const pick = <T>(items: readonly T[]): T => items[Math.floor(Math.random() * items.length)]!;
export const rand = (min: number, max: number) => min + Math.random() * (max - min);
export const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function main(run: () => Promise<void>): void {
  run().catch((err: unknown) => {
    console.error(`\n✗ ${errorMessage(err)}`);
    // Not process.exit(): on Windows exiting while an HTTP socket is still closing aborts node (libuv assertion).
    process.exitCode = 1;
  });
}
