import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TargetTradeIngest } from "@copy-trade-vault/sdk/api";

/**
 * The keeper's durable memory (node:sqlite, WAL):
 * - `seen`: target signatures already classified (dedup across ws / poll / gRPC paths and restarts),
 * - `cursors`: newest processed signature per polled address (backfill resumes there after a restart),
 * - `decisions`: every decision (copied / skipped / failed) per (copier, target signature), for `/status` and audits,
 * - `outbox`: indexer reports not yet accepted (survive indexer downtime and keeper restarts).
 */

const SEEN_TTL_SECS = 7 * 86_400;
const DECISION_TTL_SECS = 30 * 86_400;

export interface DecisionRow {
  copier: string;
  target: string;
  signature: string;
  side: string;
  tokenMint: string;
  status: string;
  reason: string | null;
  error: string | null;
  vaultSignature: string | null;
  solIn: string | null;
  tokensIn: string | null;
  detectedAt: number;
  decidedAt: number;
}

export interface OutboxItem {
  id: number;
  trade: TargetTradeIngest;
  attempts: number;
}

export class State {
  private readonly db: DatabaseSync;

  constructor(file: string) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS seen (signature TEXT PRIMARY KEY, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS cursors (key TEXT PRIMARY KEY, signature TEXT NOT NULL, slot INTEGER NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS decisions (
        copier TEXT NOT NULL, signature TEXT NOT NULL, target TEXT NOT NULL, side TEXT NOT NULL, token_mint TEXT NOT NULL,
        status TEXT NOT NULL, reason TEXT, error TEXT, vault_signature TEXT, sol_in TEXT, tokens_in TEXT,
        detected_at INTEGER NOT NULL, decided_at INTEGER NOT NULL,
        PRIMARY KEY (copier, signature, token_mint)
      );
      CREATE INDEX IF NOT EXISTS decisions_decided ON decisions (decided_at DESC);
      CREATE TABLE IF NOT EXISTS outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    this.prune();
  }

  /** Records `signature` as handled; false when it already was. */
  markSeen(signature: string): boolean {
    const r = this.db.prepare("INSERT OR IGNORE INTO seen (signature, at) VALUES (?, ?)").run(signature, Math.floor(Date.now() / 1000));
    return r.changes > 0;
  }

  hasSeen(signature: string): boolean {
    return this.db.prepare("SELECT 1 FROM seen WHERE signature = ?").get(signature) !== undefined;
  }

  cursor(key: string): { signature: string; slot: number } | null {
    const row = this.db.prepare("SELECT signature, slot FROM cursors WHERE key = ?").get(key);
    return row ? { signature: String(row.signature), slot: Number(row.slot) } : null;
  }

  deleteCursor(key: string): void {
    this.db.prepare("DELETE FROM cursors WHERE key = ?").run(key);
  }

  /** Moves the cursor forward only (an older slot never overwrites a newer one). */
  setCursor(key: string, signature: string, slot: number): void {
    this.db
      .prepare(
        `INSERT INTO cursors (key, signature, slot, at) VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET signature = excluded.signature, slot = excluded.slot, at = excluded.at
         WHERE excluded.slot >= cursors.slot`,
      )
      .run(key, signature, slot, Math.floor(Date.now() / 1000));
  }

  recordDecision(d: DecisionRow): void {
    this.db
      .prepare(
        `INSERT INTO decisions (copier, signature, target, side, token_mint, status, reason, error, vault_signature, sol_in, tokens_in, detected_at, decided_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(copier, signature, token_mint) DO UPDATE SET status = excluded.status, reason = excluded.reason,
           error = excluded.error, vault_signature = excluded.vault_signature, sol_in = excluded.sol_in,
           tokens_in = excluded.tokens_in, decided_at = excluded.decided_at`,
      )
      .run(d.copier, d.signature, d.target, d.side, d.tokenMint, d.status, d.reason, d.error, d.vaultSignature, d.solIn, d.tokensIn, d.detectedAt, d.decidedAt);
  }

  recentDecisions(limit: number): DecisionRow[] {
    const rows = this.db.prepare("SELECT * FROM decisions ORDER BY decided_at DESC LIMIT ?").all(limit);
    return rows.map((r) => ({
      copier: String(r.copier),
      target: String(r.target),
      signature: String(r.signature),
      side: String(r.side),
      tokenMint: String(r.token_mint),
      status: String(r.status),
      reason: r.reason === null ? null : String(r.reason),
      error: r.error === null ? null : String(r.error),
      vaultSignature: r.vault_signature === null ? null : String(r.vault_signature),
      solIn: r.sol_in === null ? null : String(r.sol_in),
      tokensIn: r.tokens_in === null ? null : String(r.tokens_in),
      detectedAt: Number(r.detected_at),
      decidedAt: Number(r.decided_at),
    }));
  }

  /** Decision counts by status since `sinceMs`. */
  decisionCounts(sinceMs: number): Record<string, number> {
    const rows = this.db.prepare("SELECT status, COUNT(*) AS n FROM decisions WHERE decided_at >= ? GROUP BY status").all(sinceMs);
    return Object.fromEntries(rows.map((r) => [String(r.status), Number(r.n)]));
  }

  enqueue(trades: TargetTradeIngest[]): void {
    const insert = this.db.prepare("INSERT INTO outbox (payload, next_at) VALUES (?, ?)");
    const now = Date.now();
    for (const t of trades) insert.run(JSON.stringify(t), now);
  }

  /** Items due for delivery, oldest first. */
  due(limit: number): OutboxItem[] {
    const rows = this.db.prepare("SELECT id, payload, attempts FROM outbox WHERE next_at <= ? ORDER BY id LIMIT ?").all(Date.now(), limit);
    return rows.map((r) => ({ id: Number(r.id), trade: JSON.parse(String(r.payload)), attempts: Number(r.attempts) }));
  }

  /** Removes delivered (or permanently rejected) items. */
  removeFromOutbox(ids: number[]): void {
    const del = this.db.prepare("DELETE FROM outbox WHERE id = ?");
    for (const id of ids) del.run(id);
  }

  /** Pushes `ids` back with exponential back-off (2 s … 5 min). */
  retryLater(ids: number[], attempts: number): void {
    const delay = Math.min(2_000 * 2 ** attempts, 300_000);
    const upd = this.db.prepare("UPDATE outbox SET attempts = attempts + 1, next_at = ? WHERE id = ?");
    for (const id of ids) upd.run(Date.now() + delay, id);
  }

  outboxSize(): number {
    return Number(this.db.prepare("SELECT COUNT(*) AS n FROM outbox").get()?.n ?? 0);
  }

  prune(): void {
    const now = Math.floor(Date.now() / 1000);
    this.db.prepare("DELETE FROM seen WHERE at < ?").run(now - SEEN_TTL_SECS);
    this.db.prepare("DELETE FROM decisions WHERE decided_at < ?").run((now - DECISION_TTL_SECS) * 1000);
  }

  /**
   * Binds the state to a cluster (genesis hash). A different cluster (localnet reset, devnet → mainnet) makes every
   * signature, cursor, decision and pending report meaningless: they are dropped. Returns true when that happened.
   */
  bindCluster(genesisHash: string): boolean {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'genesis'").get();
    const prev = row ? String(row.value) : null;
    if (prev === genesisHash) return false;
    if (prev !== null) this.db.exec("DELETE FROM seen; DELETE FROM cursors; DELETE FROM decisions; DELETE FROM outbox;");
    this.db.prepare("INSERT INTO meta (key, value) VALUES ('genesis', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(genesisHash);
    return prev !== null;
  }

  close(): void {
    this.db.close();
  }
}
