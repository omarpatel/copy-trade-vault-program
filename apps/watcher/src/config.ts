import { Keypair, PublicKey, type Commitment } from "@solana/web3.js";
import bs58 from "bs58";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** The localnet ingest token the indexer accepts when `INDEXER_INGEST_TOKEN` is unset (localnet only). */
export const LOCALNET_INGEST_TOKEN = "copier-localnet-ingest";

export interface KeeperConfig {
  rpcUrl: string;
  /** JSON-RPC websocket (`WS_URL`; default derived from `RPC_URL`: https → wss, explicit port + 1). */
  wsUrl: string;
  /** Yellowstone gRPC endpoint (`GRPC_URL`) and its x-token (`GRPC_TOKEN`); null = websocket detection only. */
  grpc: { url: string; token: string | undefined } | null;
  /**
   * Where the keeper key comes from: `KEEPER_SECRET_KEY` (64-byte JSON array or base58, parsed at startup; for hosts
   * that inject secrets as variables) or a keypair file `KEEPER_KEYPAIR` (localnet default `.localnet/keeper.json`,
   * re-read until it exists).
   */
  key: KeySource;
  /** Indexer base URL (`INDEXER_URL`) and the bearer for `POST /internal/target-trades`. */
  indexerUrl: string;
  ingestToken: string | null;
  /** Jito block engine (`JITO_URL`, e.g. https://mainnet.block-engine.jito.wtf) and tip; null = plain RPC send. */
  jito: { url: string; tipLamports: number } | null;
  /** µlamports per CU: market estimate clamped to [floor (`PRIORITY_MICROLAMPORTS`), cap (`MAX_PRIORITY_MICROLAMPORTS`)]. */
  priority: { floor: number; cap: number };
  statusPort: number;
  statusHost: string;
  /** SQLite state file (`KEEPER_DB`). */
  dbFile: string;
  /** Commitment for reads, subscriptions and confirmation (`COMMITMENT`, default `confirmed`). */
  commitment: Commitment;
  /** Decide and report, never send (`DRY_RUN=1`). */
  dryRun: boolean;
  /** Copier accounts refresh (`COPIER_REFRESH_MS`, default 30 s). */
  copierRefreshMs: number;
  /** Per-copier crank cadence (`CRANK_MS`, default 60 s). */
  crankMs: number;
  /** Signature poll of every target wallet + tracked token accounts (`POLL_MS`); fast when the websocket is down (`POLL_FALLBACK_MS`). */
  pollMs: number;
  pollFallbackMs: number;
  /** Concurrent `getTransaction` fetches (`FETCH_CONCURRENCY`). */
  fetchConcurrency: number;
  /** Buys seen later than this after the target's block time are skipped as `stale_signal` (`MAX_SIGNAL_AGE_SECS`). */
  maxSignalAgeSecs: number;
  /** Conviction = clamp(k × target_spent / target_sol_before, floor, 1) (`CONVICTION_K`, `CONVICTION_FLOOR_BPS`). */
  convictionK: number;
  convictionFloorBps: number;
  /** A venue whose real SOL reserves are below this is `token_dead` (`DEAD_QUOTE_LAMPORTS`). */
  deadQuoteLamports: bigint;
  /** A repeat buy of a mint the vault bought less than this ago is skipped as `reentry_cooldown` (`REENTRY_COOLDOWN_SECS`). */
  reentryCooldownSecs: number;
  /** Crank thresholds (SPEC §4): buyback/burn pools ≥ 0.05 SOL; distribute when the vault would gain ≥ `DISTRIBUTE_MIN_LAMPORTS`. */
  buybackMinLamports: bigint;
  distributeMinLamports: bigint;
  /** Address lookup table for v0 sends (`COPIER_ALT`; localnet default from `.localnet/config.json`). */
  alt: PublicKey | null;
}

/** The websocket endpoint of an RPC URL: https → wss, an explicit port + 1 (validator convention, 8899 → 8900). */
export function wsUrlOf(rpcUrl: string): string {
  const u = new URL(rpcUrl);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  if (u.port) u.port = String(Number(u.port) + 1);
  return u.toString();
}

export function isLocalRpc(rpcUrl: string): boolean {
  const host = new URL(rpcUrl).hostname;
  return host === "127.0.0.1" || host === "localhost" || host === "0.0.0.0" || host === "[::1]";
}

type Env = Record<string, string | undefined>;

function str(env: Env, name: string): string | undefined {
  const v = env[name]?.trim();
  return v ? v : undefined;
}

function int(env: Env, name: string, fallback: number, lo: number, hi: number): number {
  const raw = str(env, name);
  if (raw === undefined) return fallback;
  const v = Number(raw);
  if (!Number.isInteger(v) || v < lo || v > hi) throw new Error(`${name} must be an integer in [${lo}, ${hi}], got "${raw}"`);
  return v;
}

function num(env: Env, name: string, fallback: number, lo: number, hi: number): number {
  const raw = str(env, name);
  if (raw === undefined) return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < lo || v > hi) throw new Error(`${name} must be a number in [${lo}, ${hi}], got "${raw}"`);
  return v;
}

function flag(env: Env, name: string): boolean {
  const v = (env[name] ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/** `.localnet/config.json` written by `pnpm setup:localnet` (null when absent or unreadable). */
function localnetConfig(): { alt?: string; indexerUrl?: string; ingestToken?: string; keeperKeypair?: string } | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, ".localnet", "config.json"), "utf8"));
  } catch {
    return null;
  }
}

const COMMITMENTS: Record<string, true> = { processed: true, confirmed: true, finalized: true };

export function loadConfig(env: Env = process.env): KeeperConfig {
  const rpcUrl = str(env, "RPC_URL") ?? "http://127.0.0.1:8899";
  try {
    new URL(rpcUrl);
  } catch {
    throw new Error(`RPC_URL must be an http(s) URL, got "${rpcUrl}"`);
  }
  const local = isLocalRpc(rpcUrl);
  const ln = local ? localnetConfig() : null;
  const key = keySource(env, local ? ln?.keeperKeypair ?? ".localnet/keeper.json" : undefined);

  const indexerUrl = (str(env, "INDEXER_URL") ?? (local ? ln?.indexerUrl ?? "http://127.0.0.1:8790" : undefined))?.replace(/\/+$/, "");
  if (!indexerUrl) throw new Error("INDEXER_URL is required off localnet");
  const ingestToken = str(env, "INDEXER_INGEST_TOKEN") ?? (local ? ln?.ingestToken ?? LOCALNET_INGEST_TOKEN : null);

  const priorityFloor = int(env, "PRIORITY_MICROLAMPORTS", local ? 0 : 10_000, 0, 1_000_000_000);
  const priorityCap = int(env, "MAX_PRIORITY_MICROLAMPORTS", Math.max(priorityFloor, local ? 0 : 2_000_000), 0, 1_000_000_000);
  if (priorityCap < priorityFloor) {
    throw new Error(`MAX_PRIORITY_MICROLAMPORTS (${priorityCap}) must be ≥ PRIORITY_MICROLAMPORTS (${priorityFloor})`);
  }

  const jitoUrl = str(env, "JITO_URL")?.replace(/\/+$/, "");
  const grpcUrl = str(env, "GRPC_URL");
  const commitment = (str(env, "COMMITMENT") ?? "confirmed") as Commitment;
  if (!COMMITMENTS[commitment]) throw new Error(`COMMITMENT must be processed|confirmed|finalized, got "${commitment}"`);

  const altRaw = str(env, "COPIER_ALT") ?? (local ? ln?.alt : undefined);
  let alt: PublicKey | null = null;
  if (altRaw) {
    try {
      alt = new PublicKey(altRaw);
    } catch {
      throw new Error(`COPIER_ALT must be a base58 public key, got "${altRaw}"`);
    }
  }

  return {
    rpcUrl,
    wsUrl: str(env, "WS_URL") ?? wsUrlOf(rpcUrl),
    grpc: grpcUrl ? { url: grpcUrl, token: str(env, "GRPC_TOKEN") } : null,
    key,
    indexerUrl,
    ingestToken,
    jito: jitoUrl ? { url: jitoUrl, tipLamports: int(env, "JITO_TIP_LAMPORTS", 1_000_000, 1_000, 100_000_000) } : null,
    priority: { floor: priorityFloor, cap: priorityCap },
    // PaaS hosts (Railway, Render, …) assign PORT; STATUS_PORT wins when both are set.
    statusPort: int(env, "STATUS_PORT", int(env, "PORT", 8792, 0, 65_535), 0, 65_535),
    statusHost: str(env, "STATUS_HOST") ?? (env.PORT ? "0.0.0.0" : "127.0.0.1"),
    dbFile: path.resolve(REPO_ROOT, str(env, "KEEPER_DB") ?? (local ? "apps/watcher/.keeper-localnet.db" : "apps/watcher/.keeper.db")),
    commitment,
    dryRun: flag(env, "DRY_RUN"),
    copierRefreshMs: int(env, "COPIER_REFRESH_MS", 30_000, 1_000, 3_600_000),
    crankMs: int(env, "CRANK_MS", 60_000, 5_000, 3_600_000),
    pollMs: int(env, "POLL_MS", 15_000, 500, 3_600_000),
    pollFallbackMs: int(env, "POLL_FALLBACK_MS", 3_000, 250, 3_600_000),
    fetchConcurrency: int(env, "FETCH_CONCURRENCY", 4, 1, 64),
    maxSignalAgeSecs: int(env, "MAX_SIGNAL_AGE_SECS", 90, 5, 86_400),
    convictionK: num(env, "CONVICTION_K", 4, 0, 1_000),
    convictionFloorBps: int(env, "CONVICTION_FLOOR_BPS", 2_500, 0, 10_000),
    deadQuoteLamports: BigInt(int(env, "DEAD_QUOTE_LAMPORTS", 200_000_000, 0, Number.MAX_SAFE_INTEGER)),
    reentryCooldownSecs: int(env, "REENTRY_COOLDOWN_SECS", 120, 0, 86_400),
    buybackMinLamports: BigInt(int(env, "BUYBACK_MIN_LAMPORTS", 50_000_000, 1, Number.MAX_SAFE_INTEGER)),
    distributeMinLamports: BigInt(int(env, "DISTRIBUTE_MIN_LAMPORTS", 1_000_000, 1, Number.MAX_SAFE_INTEGER)),
    alt,
  };
}

/** The keeper key: parsed from env, or a keypair file. */
export type KeySource = { kind: "env"; keypair: Keypair } | { kind: "file"; path: string };

function keySource(env: Env, defaultPath: string | undefined): KeySource {
  const secret = str(env, "KEEPER_SECRET_KEY");
  const file = str(env, "KEEPER_KEYPAIR");
  if (secret && file) throw new Error("set only one of KEEPER_SECRET_KEY and KEEPER_KEYPAIR");
  if (secret) return { kind: "env", keypair: parseSecretKey(secret, "KEEPER_SECRET_KEY") };
  const p = file ?? defaultPath;
  if (!p) throw new Error("KEEPER_SECRET_KEY (secret key) or KEEPER_KEYPAIR (path to the keypair JSON) is required off localnet");
  return { kind: "file", path: path.resolve(REPO_ROOT, p) };
}

/**
 * A 64-byte ed25519 secret key as a JSON byte array (`solana-keygen` file contents) or base58 (wallet export).
 * Error messages name `what` and never include the input.
 */
export function parseSecretKey(raw: string, what: string): Keypair {
  const text = raw.trim();
  let bytes: Uint8Array;
  if (text.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`${what} is not valid JSON`);
    }
    if (!Array.isArray(parsed) || parsed.length !== 64 || !parsed.every((b) => Number.isInteger(b) && b >= 0 && b < 256)) {
      throw new Error(`${what} must be a JSON array of 64 bytes`);
    }
    bytes = Uint8Array.from(parsed as number[]);
  } else {
    try {
      bytes = bs58.decode(text);
    } catch {
      throw new Error(`${what} must be a JSON array of 64 bytes or a base58 secret key`);
    }
    if (bytes.length !== 64) throw new Error(`${what} must decode to 64 bytes (base58), got ${bytes.length}`);
  }
  try {
    return Keypair.fromSecretKey(bytes);
  } catch {
    throw new Error(`${what} is not a valid ed25519 secret key (public half does not match)`);
  }
}

/** The keeper keypair, or null when the file does not exist yet (localnet before `pnpm setup:localnet`). */
export function loadKeypair(file: string): Keypair | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`cannot read keeper keypair ${file}: ${(err as Error).message}`);
  }
  return parseSecretKey(raw, `keeper keypair ${file}`);
}
