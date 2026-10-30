import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_DIR = path.resolve(APP_DIR, "../..");

function envInt(name: string, fallback: number, min = 0): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) throw new Error(`${name} must be an integer ≥ ${min}, got "${raw}"`);
  return n;
}

function wsFromRpc(rpc: string): string {
  const u = new URL(rpc);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  // Solana convention: pubsub listens on RPC port + 1.
  if (u.port) u.port = String(Number(u.port) + 1);
  return u.toString();
}

function isLocalHost(url: string): boolean {
  const host = new URL(url).hostname;
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}

export type UploadStorage = "local" | "pinata" | "pump";

const rpcUrl = process.env.RPC_URL || "http://127.0.0.1:8899";
const localnet = isLocalHost(rpcUrl);
/** Copier's indexer defaults next to the keeper (8792). */
const port = envInt("PORT", 8790, 1);

/** Shared secret of `POST /internal/target-trades`; defaulted only against a localhost validator. */
export const LOCALNET_INGEST_TOKEN = "copier-localnet-ingest";
const ingestToken = process.env.INDEXER_INGEST_TOKEN || (localnet ? LOCALNET_INGEST_TOKEN : "");
if (!ingestToken) throw new Error("INDEXER_INGEST_TOKEN is required when RPC_URL is not a localhost validator");

const pinataJwt = process.env.PINATA_JWT || null;
function uploadStorage(): UploadStorage {
  const raw = (process.env.UPLOAD_STORAGE ?? "").trim().toLowerCase();
  if (raw === "") return pinataJwt ? "pinata" : localnet ? "local" : "pump";
  if (raw !== "local" && raw !== "pinata" && raw !== "pump") throw new Error(`UPLOAD_STORAGE must be local, pinata or pump, got "${raw}"`);
  if (raw === "pinata" && !pinataJwt) throw new Error("UPLOAD_STORAGE=pinata needs PINATA_JWT");
  return raw;
}

/** Seed KOLs of the localnet scripts (`.localnet/seed.json`), merged into the directory on localnet only. */
function localnetKols(): string | null {
  const explicit = process.env.LOCALNET_KOLS;
  if (explicit) return path.resolve(explicit);
  const file = path.join(REPO_DIR, ".localnet", "seed.json");
  return localnet && fs.existsSync(file) ? file : null;
}

const trustProxy = (process.env.TRUST_PROXY ?? "").trim();

export const config = {
  rpcUrl,
  wsUrl: process.env.WS_URL || wsFromRpc(rpcUrl),
  localnet,
  port,
  host: process.env.HOST || "0.0.0.0",
  publicUrl: (process.env.PUBLIC_URL || `http://127.0.0.1:${port}`).replace(/\/+$/, ""),
  dbPath: path.resolve(process.env.DB_PATH || path.join(APP_DIR, "data", "indexer.db")),
  filesDir: path.resolve(process.env.FILES_DIR || path.join(APP_DIR, "data", "files")),
  ingestToken,
  pinataJwt,
  pinataGateway: (process.env.PINATA_GATEWAY || "https://ipfs.io/ipfs").replace(/\/+$/, ""),
  uploadStorage: uploadStorage(),
  localnetKols: localnetKols(),
  /** Program signature poll (fills websocket gaps; its first run is the backfill). */
  pollMs: envInt("POLL_MS", localnet ? 2_000 : 10_000, 250),
  /** Own-coin price/mcap/supply + vault NAV samples. */
  snapshotMs: envInt("SNAPSHOT_MS", 15_000, 1_000),
  /** Full account refresh (copiers, positions, config). */
  refreshMs: envInt("REFRESH_MS", 60_000, 1_000),
  /** pump `distribute_creator_fees_v2` scan of every copier's sharing config. */
  feesPollMs: envInt("FEES_POLL_MS", localnet ? 5_000 : 30_000, 500),
  chainCheckMs: envInt("CHAIN_CHECK_MS", 30_000, 1_000),
  rateLimitPerMin: envInt("RATE_LIMIT_PER_MIN", 600),
  uploadLimitPerMin: envInt("UPLOAD_LIMIT_PER_MIN", 10),
  /** `true` (every hop), or a comma-separated list of trusted proxy addresses/CIDRs; unset = trust nothing. */
  trustProxy: trustProxy === "" || trustProxy === "false" ? false : trustProxy === "true" ? true : trustProxy,
  /** Slack/Discord-compatible webhook for operator alerts (fee routing changed / restored); unset = log only. */
  alertWebhookUrl: process.env.ALERT_WEBHOOK_URL || null,
  /** Background crawl of the wallet directory sources (+ avatar cache). `DIRECTORY_REFRESH=off` serves the snapshot. */
  directoryRefresh: process.env.DIRECTORY_REFRESH !== "off",
} as const;

export type Config = typeof config;
