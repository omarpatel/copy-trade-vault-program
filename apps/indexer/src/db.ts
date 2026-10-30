import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";

/** Bumped when the schema changes incompatibly: older files are rebuilt from chain (everything here is derived). */
const SCHEMA_VERSION = 6;

/** Exact sum of a TEXT column holding u64/i64 decimals, as a decimal string. */
const SUM = (col: string) => `CAST(COALESCE(SUM(CAST(${col} AS INTEGER)), 0) AS TEXT)`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS txs (
  signature TEXT PRIMARY KEY,
  slot INTEGER NOT NULL,
  block_time INTEGER,
  failed INTEGER NOT NULL,
  events INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS copiers (
  mint TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  launcher TEXT NOT NULL,
  vault TEXT NOT NULL,
  targets TEXT NOT NULL,
  trader_bps INTEGER NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  sharing_config TEXT NOT NULL,
  registered_sig TEXT,
  accounted TEXT NOT NULL DEFAULT '0',
  fees_in TEXT NOT NULL DEFAULT '0',
  capital_in TEXT NOT NULL DEFAULT '0',
  open_cost TEXT NOT NULL DEFAULT '0',
  open_positions INTEGER NOT NULL DEFAULT 0,
  realized_pnl TEXT NOT NULL DEFAULT '0',
  hwm TEXT NOT NULL DEFAULT '0',
  buyback_pool TEXT NOT NULL DEFAULT '0',
  platform_sent TEXT NOT NULL DEFAULT '0',
  burned TEXT NOT NULL DEFAULT '0',
  buyback_spent TEXT NOT NULL DEFAULT '0',
  platform_pending TEXT NOT NULL DEFAULT '0',
  window_start INTEGER NOT NULL DEFAULT 0,
  window_spent TEXT NOT NULL DEFAULT '0',
  window_equity TEXT NOT NULL DEFAULT '0',
  trades INTEGER NOT NULL DEFAULT 0,
  last_keeper_ts INTEGER,
  graduated_pool TEXT,
  state_slot INTEGER NOT NULL DEFAULT 0,
  vault_lamports TEXT NOT NULL DEFAULT '0',
  wsol TEXT NOT NULL DEFAULT '0',
  free TEXT NOT NULL DEFAULT '0',
  equity TEXT NOT NULL DEFAULT '0',
  nav TEXT NOT NULL DEFAULT '0',
  positions_value TEXT NOT NULL DEFAULT '0',
  unrealized TEXT NOT NULL DEFAULT '0',
  name TEXT NOT NULL DEFAULT '',
  symbol TEXT NOT NULL DEFAULT '',
  uri TEXT NOT NULL DEFAULT '',
  image TEXT,
  description TEXT,
  twitter TEXT,
  telegram TEXT,
  website TEXT,
  meta_status TEXT NOT NULL DEFAULT 'pending',
  meta_attempts INTEGER NOT NULL DEFAULT 0,
  meta_next_at INTEGER NOT NULL DEFAULT 0,
  venue TEXT,
  pool TEXT,
  price REAL,
  mcap TEXT,
  supply TEXT,
  decimals INTEGER NOT NULL DEFAULT 6,
  curve_progress INTEGER,
  market_at INTEGER,
  fee_status TEXT NOT NULL DEFAULT 'unknown',
  fee_checked_at INTEGER NOT NULL DEFAULT 0,
  fee_detail TEXT,
  fee_shareholders TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS positions (
  copier TEXT NOT NULL,
  token_mint TEXT NOT NULL,
  target TEXT NOT NULL,
  venue TEXT,
  tokens TEXT NOT NULL,
  cost TEXT NOT NULL,
  target_snapshot TEXT NOT NULL DEFAULT '0',
  target_peak TEXT NOT NULL DEFAULT '0',
  vault_peak TEXT NOT NULL DEFAULT '0',
  opened_at INTEGER NOT NULL,
  last_trade_ts INTEGER NOT NULL DEFAULT 0,
  mark_price REAL,
  value TEXT,
  spot_value TEXT,
  state_slot INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (copier, token_mint)
);
CREATE TABLE IF NOT EXISTS trades (
  signature TEXT NOT NULL,
  event_index INTEGER NOT NULL,
  slot INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  copier TEXT NOT NULL,
  side TEXT NOT NULL,
  target TEXT NOT NULL,
  token_mint TEXT NOT NULL,
  venue TEXT NOT NULL,
  sol TEXT NOT NULL,
  tokens TEXT NOT NULL,
  cost_removed TEXT,
  pnl TEXT,
  realized_pnl TEXT,
  hwm TEXT,
  forced INTEGER NOT NULL DEFAULT 0,
  equity TEXT,
  signal TEXT,
  target_balance TEXT,
  target_sig TEXT,
  PRIMARY KEY (signature, event_index)
);
CREATE INDEX IF NOT EXISTS trades_copier ON trades(copier, slot);
CREATE INDEX IF NOT EXISTS trades_target_sig ON trades(target_sig);
CREATE INDEX IF NOT EXISTS trades_position ON trades(copier, token_mint, ts);
CREATE TABLE IF NOT EXISTS target_trades (
  copier TEXT NOT NULL,
  signature TEXT NOT NULL,
  target TEXT NOT NULL,
  slot INTEGER NOT NULL,
  block_time INTEGER,
  side TEXT NOT NULL,
  token_mint TEXT NOT NULL,
  token_delta TEXT NOT NULL,
  sol_delta TEXT NOT NULL,
  target_sol_before TEXT NOT NULL,
  price REAL,
  venue TEXT,
  status TEXT NOT NULL,
  reason TEXT,
  error TEXT,
  vault_sig TEXT,
  vault_sol_in TEXT,
  vault_tokens_in TEXT,
  detected_at INTEGER,
  decided_at INTEGER,
  source TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  PRIMARY KEY (copier, signature, token_mint)
);
CREATE INDEX IF NOT EXISTS target_trades_copier ON target_trades(copier, slot);
CREATE INDEX IF NOT EXISTS target_trades_target ON target_trades(target, slot);
CREATE INDEX IF NOT EXISTS target_trades_time ON target_trades(block_time);
CREATE TABLE IF NOT EXISTS distributions (
  signature TEXT NOT NULL,
  copier TEXT NOT NULL,
  slot INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  distributed TEXT NOT NULL,
  to_vault TEXT NOT NULL,
  to_targets TEXT NOT NULL,
  shares TEXT NOT NULL,
  PRIMARY KEY (signature, copier)
);
CREATE INDEX IF NOT EXISTS distributions_copier ON distributions(copier, slot);
CREATE TABLE IF NOT EXISTS target_earnings (
  signature TEXT NOT NULL,
  copier TEXT NOT NULL,
  target TEXT NOT NULL,
  ts INTEGER NOT NULL,
  lamports TEXT NOT NULL,
  PRIMARY KEY (signature, copier, target)
);
CREATE INDEX IF NOT EXISTS target_earnings_target ON target_earnings(target);
CREATE TABLE IF NOT EXISTS fee_syncs (
  signature TEXT NOT NULL,
  event_index INTEGER NOT NULL,
  slot INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  copier TEXT NOT NULL,
  lamports TEXT NOT NULL,
  total TEXT NOT NULL,
  PRIMARY KEY (signature, event_index)
);
CREATE INDEX IF NOT EXISTS fee_syncs_copier ON fee_syncs(copier, slot);
CREATE TABLE IF NOT EXISTS deposits (
  signature TEXT NOT NULL,
  event_index INTEGER NOT NULL,
  slot INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  copier TEXT NOT NULL,
  from_addr TEXT NOT NULL,
  lamports TEXT NOT NULL,
  PRIMARY KEY (signature, event_index)
);
CREATE INDEX IF NOT EXISTS deposits_copier ON deposits(copier, slot);
CREATE TABLE IF NOT EXISTS burns (
  signature TEXT NOT NULL,
  event_index INTEGER NOT NULL,
  slot INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  copier TEXT,
  mint TEXT NOT NULL,
  sol_in TEXT NOT NULL,
  tokens TEXT NOT NULL,
  total_burned TEXT,
  PRIMARY KEY (signature, event_index)
);
CREATE INDEX IF NOT EXISTS burns_time ON burns(slot);
CREATE INDEX IF NOT EXISTS burns_copier ON burns(copier, slot);
CREATE TABLE IF NOT EXISTS profit_splits (
  signature TEXT NOT NULL,
  event_index INTEGER NOT NULL,
  slot INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  copier TEXT NOT NULL,
  excess TEXT NOT NULL,
  to_buyback TEXT NOT NULL,
  to_platform TEXT NOT NULL,
  PRIMARY KEY (signature, event_index)
);
CREATE INDEX IF NOT EXISTS profit_splits_copier ON profit_splits(copier, slot);
CREATE TABLE IF NOT EXISTS snapshots (
  mint TEXT NOT NULL,
  ts INTEGER NOT NULL,
  price REAL,
  mcap TEXT,
  supply TEXT,
  nav TEXT NOT NULL,
  PRIMARY KEY (mint, ts)
);
CREATE TABLE IF NOT EXISTS candles (
  mint TEXT NOT NULL,
  t INTEGER NOT NULL,
  o REAL NOT NULL,
  h REAL NOT NULL,
  l REAL NOT NULL,
  c REAL NOT NULL,
  mcap TEXT,
  nav TEXT,
  PRIMARY KEY (mint, t)
);
CREATE TABLE IF NOT EXISTS admin_changes (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  proposer TEXT,
  proposed_at INTEGER NOT NULL,
  eta INTEGER NOT NULL,
  expires_at INTEGER,
  invalidated_reason TEXT,
  invalidated_at INTEGER,
  resolved_at INTEGER,
  propose_sig TEXT,
  resolve_sig TEXT,
  payload TEXT
);
CREATE INDEX IF NOT EXISTS admin_changes_status ON admin_changes(status, eta);
CREATE TABLE IF NOT EXISTS keeper_pauses (
  signature TEXT NOT NULL,
  event_index INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  keeper TEXT NOT NULL,
  PRIMARY KEY (signature, event_index)
);
CREATE TABLE IF NOT EXISTS tokens (
  mint TEXT PRIMARY KEY,
  program TEXT,
  decimals INTEGER,
  name TEXT,
  symbol TEXT,
  uri TEXT,
  image TEXT,
  meta_status TEXT NOT NULL DEFAULT 'pending',
  meta_attempts INTEGER NOT NULL DEFAULT 0,
  meta_next_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS directory_rows (
  source TEXT NOT NULL,
  address TEXT NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (source, address)
);
CREATE TABLE IF NOT EXISTS directory_runs (
  source TEXT PRIMARY KEY,
  last_ok_at INTEGER,
  last_try_at INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
CREATE TABLE IF NOT EXISTS directory_avatars (
  src TEXT PRIMARY KEY,
  file TEXT,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  fetched_at INTEGER NOT NULL,
  error TEXT
);
`;

/**
 * Every chain-derived table (all of them: a chain reset makes keeper reports meaningless too). The `directory_*` tables
 * (wallet directory crawl + avatar cache) are off-chain and survive wipes and schema bumps.
 */
const DATA_TABLES = [
  "sync_state",
  "txs",
  "copiers",
  "positions",
  "trades",
  "target_trades",
  "distributions",
  "target_earnings",
  "fee_syncs",
  "deposits",
  "burns",
  "profit_splits",
  "snapshots",
  "candles",
  "tokens",
  "admin_changes",
  "keeper_pauses",
] as const;

export type MetaStatus = "pending" | "ok" | "none";

export interface CopierRow {
  mint: string;
  kind: "single" | "index";
  launcher: string;
  vault: string;
  /** JSON string[] */
  targets: string;
  trader_bps: number;
  verified: number;
  created_at: number;
  sharing_config: string;
  registered_sig: string | null;
  accounted: string;
  fees_in: string;
  capital_in: string;
  open_cost: string;
  open_positions: number;
  realized_pnl: string;
  hwm: string;
  buyback_pool: string;
  platform_sent: string;
  burned: string;
  buyback_spent: string;
  platform_pending: string;
  window_start: number;
  window_spent: string;
  window_equity: string;
  trades: number;
  last_keeper_ts: number | null;
  graduated_pool: string | null;
  state_slot: number;
  vault_lamports: string;
  wsol: string;
  free: string;
  equity: string;
  nav: string;
  positions_value: string;
  unrealized: string;
  name: string;
  symbol: string;
  uri: string;
  image: string | null;
  description: string | null;
  twitter: string | null;
  telegram: string | null;
  website: string | null;
  meta_status: MetaStatus;
  meta_attempts: number;
  meta_next_at: number;
  venue: "curve" | "pool" | null;
  pool: string | null;
  price: number | null;
  mcap: string | null;
  supply: string | null;
  decimals: number;
  curve_progress: number | null;
  market_at: number | null;
  fee_status: "intact" | "changed" | "unknown";
  fee_checked_at: number;
  fee_detail: string | null;
  /** JSON {address, bps}[] */
  fee_shareholders: string;
}

/** Program `Copier` account fields copied into the row. */
export type CopierState = Pick<
  CopierRow,
  | "kind"
  | "launcher"
  | "targets"
  | "trader_bps"
  | "verified"
  | "created_at"
  | "sharing_config"
  | "accounted"
  | "fees_in"
  | "capital_in"
  | "open_cost"
  | "open_positions"
  | "realized_pnl"
  | "hwm"
  | "buyback_pool"
  | "platform_sent"
  | "burned"
  | "buyback_spent"
  | "platform_pending"
  | "window_start"
  | "window_spent"
  | "window_equity"
  | "trades"
  | "last_keeper_ts"
  | "graduated_pool"
>;

export type VaultBookRow = Pick<CopierRow, "vault_lamports" | "wsol" | "free" | "equity" | "nav" | "positions_value" | "unrealized">;
export type MarketRow = Pick<CopierRow, "venue" | "pool" | "price" | "mcap" | "supply" | "decimals" | "curve_progress" | "market_at">;

export interface PositionRow {
  copier: string;
  token_mint: string;
  target: string;
  /** Set by the market sampler. */
  venue: "curve" | "pool" | "unsupported" | null;
  tokens: string;
  cost: string;
  target_snapshot: string;
  target_peak: string;
  vault_peak: string;
  opened_at: number;
  last_trade_ts: number;
  mark_price: number | null;
  /** Exit value: the venue's sell quote for the whole position after price impact and fees (what NAV counts). */
  value: string | null;
  /** tokens × spot price (display only). */
  spot_value: string | null;
  state_slot: number;
}

export interface TradeRow {
  signature: string;
  event_index: number;
  slot: number;
  ts: number;
  copier: string;
  side: "buy" | "sell";
  target: string;
  token_mint: string;
  venue: "curve" | "pool";
  sol: string;
  tokens: string;
  cost_removed: string | null;
  pnl: string | null;
  realized_pnl: string | null;
  hwm: string | null;
  forced: number;
  equity: string | null;
  signal: string | null;
  target_balance: string | null;
  target_sig: string | null;
}

export interface TargetTradeRow {
  copier: string;
  signature: string;
  target: string;
  slot: number;
  block_time: number | null;
  side: string;
  token_mint: string;
  token_delta: string;
  sol_delta: string;
  target_sol_before: string;
  price: number | null;
  venue: string | null;
  status: string;
  reason: string | null;
  error: string | null;
  vault_sig: string | null;
  vault_sol_in: string | null;
  vault_tokens_in: string | null;
  detected_at: number | null;
  decided_at: number | null;
  source: "keeper" | "memo";
  received_at: number;
}

/** A target trade joined with the vault trade answering it (by memo, else by the keeper's vault signature). */
export interface CopyRow extends TargetTradeRow {
  t_signature: string | null;
  t_slot: number | null;
  t_ts: number | null;
  t_block_time: number | null;
  t_sol: string | null;
  t_tokens: string | null;
  t_pnl: string | null;
  t_forced: number | null;
}

export interface DistributionRow {
  signature: string;
  copier: string;
  slot: number;
  ts: number;
  distributed: string;
  to_vault: string;
  to_targets: string;
  /** JSON {address, bps, lamports, role}[] */
  shares: string;
}

export interface BurnRow {
  signature: string;
  event_index: number;
  slot: number;
  ts: number;
  kind: "coin" | "platform";
  copier: string | null;
  mint: string;
  sol_in: string;
  tokens: string;
  total_burned: string | null;
}

export interface FeeSyncRow {
  signature: string;
  event_index: number;
  slot: number;
  ts: number;
  copier: string;
  lamports: string;
  total: string;
}

export interface DepositRow {
  signature: string;
  event_index: number;
  slot: number;
  ts: number;
  copier: string;
  from_addr: string;
  lamports: string;
}

export interface ProfitSplitRow {
  signature: string;
  event_index: number;
  slot: number;
  ts: number;
  copier: string;
  excess: string;
  to_buyback: string;
  to_platform: string;
}

export interface TokenRow {
  mint: string;
  program: string | null;
  decimals: number | null;
  name: string | null;
  symbol: string | null;
  uri: string | null;
  image: string | null;
  meta_status: MetaStatus;
  meta_attempts: number;
  meta_next_at: number;
}

export interface CandleRow {
  mint: string;
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  mcap: string | null;
  nav: string | null;
}

export interface AdminChangeRow {
  id: number;
  kind: "keeper" | "params" | "descriptors" | "indexTargets";
  /** Stored lifecycle: "open" until a closing event (the API derives queued / executable / superseded / expired). */
  status: "open" | "executed" | "cancelled" | "discarded";
  proposer: string | null;
  proposed_at: number;
  eta: number;
  expires_at: number | null;
  invalidated_reason: "superseded" | "keeperPaused" | "adminChanged" | null;
  invalidated_at: number | null;
  resolved_at: number | null;
  propose_sig: string | null;
  resolve_sig: string | null;
  /** JSON `AdminChangePayload` (from the PendingChange account), null until read. */
  payload: string | null;
}

export interface DirectoryRunRow {
  source: string;
  last_ok_at: number | null;
  last_try_at: number;
  count: number;
  error: string | null;
}

export interface DirectoryAvatarRow {
  /** Upstream image URL. */
  src: string;
  /** Content-addressed file id under `files/avatars/` (`<id>-128.webp`, `<id>-256.webp`); null until cached. */
  file: string | null;
  status: "ok" | "failed";
  attempts: number;
  fetched_at: number;
  error: string | null;
}

export interface SnapshotRow {
  mint: string;
  ts: number;
  price: number | null;
  mcap: string | null;
  supply: string | null;
  nav: string;
}

/** Per-copier aggregates of copies and fee flows (one query for all list views). */
export interface CopierAggRow {
  copier: string;
  copies24h: number;
  skipped24h: number;
  last_copy_at: number | null;
  distributed: string;
  to_vault: string;
  to_targets: string;
  distributions: number;
  last_distributed_at: number | null;
}

type Params = SQLInputValue[] | Record<string, SQLInputValue>;

function rows<T>(stmt: StatementSync, params: Params = []): T[] {
  return (Array.isArray(params) ? stmt.all(...params) : stmt.all(params)) as unknown as T[];
}

function row<T>(stmt: StatementSync, params: Params = []): T | undefined {
  return (Array.isArray(params) ? stmt.get(...params) : stmt.get(params)) as unknown as T | undefined;
}

const COPY_SELECT = `
  SELECT tt.*, t.signature AS t_signature, t.slot AS t_slot, t.ts AS t_ts, x.block_time AS t_block_time,
         t.sol AS t_sol, t.tokens AS t_tokens, t.pnl AS t_pnl, t.forced AS t_forced
  FROM target_trades tt
  LEFT JOIN trades t ON t.rowid = (
    SELECT t2.rowid FROM trades t2
    WHERE t2.copier = tt.copier AND t2.token_mint = tt.token_mint
      AND (t2.target_sig = tt.signature OR (tt.vault_sig IS NOT NULL AND t2.signature = tt.vault_sig))
    ORDER BY t2.slot LIMIT 1)
  LEFT JOIN txs x ON x.signature = t.signature`;

const SQL = {
  getState: "SELECT value FROM sync_state WHERE key = ?",
  setState: "INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  deleteState: "DELETE FROM sync_state WHERE key = ?",
  hasTx: "SELECT 1 AS one FROM txs WHERE signature = ?",
  txSlot: "SELECT slot FROM txs WHERE signature = ?",
  txBlockTime: "SELECT block_time FROM txs WHERE signature = ?",
  insertTx: "INSERT OR IGNORE INTO txs (signature, slot, block_time, failed, events) VALUES (?, ?, ?, ?, ?)",
  counts: `SELECT (SELECT COUNT(*) FROM copiers) AS copiers, (SELECT COUNT(*) FROM txs) AS txs,
    (SELECT COUNT(*) FROM trades) AS trades, (SELECT COUNT(*) FROM target_trades) AS target_trades`,

  insertCopier: `INSERT INTO copiers (mint, kind, launcher, vault, targets, trader_bps, created_at, sharing_config, registered_sig)
    VALUES (:mint, :kind, :launcher, :vault, :targets, :trader_bps, :created_at, :sharing_config, :registered_sig)
    ON CONFLICT(mint) DO UPDATE SET registered_sig = COALESCE(copiers.registered_sig, excluded.registered_sig)`,
  copier: "SELECT * FROM copiers WHERE mint = ?",
  copiers: "SELECT * FROM copiers ORDER BY created_at DESC, mint",
  copiersTargeting: "SELECT m.* FROM copiers m WHERE EXISTS (SELECT 1 FROM json_each(m.targets) j WHERE j.value = ?) ORDER BY created_at DESC",
  setCopierState: `UPDATE copiers SET kind = :kind, launcher = :launcher, targets = :targets, trader_bps = :trader_bps,
    verified = :verified, created_at = :created_at, sharing_config = :sharing_config, accounted = :accounted,
    fees_in = :fees_in, capital_in = :capital_in, open_cost = :open_cost, open_positions = :open_positions,
    realized_pnl = :realized_pnl, hwm = :hwm, buyback_pool = :buyback_pool, platform_sent = :platform_sent,
    burned = :burned, buyback_spent = :buyback_spent, platform_pending = :platform_pending, trades = :trades, last_keeper_ts = :last_keeper_ts,
    window_start = :window_start, window_spent = :window_spent, window_equity = :window_equity,
    graduated_pool = :graduated_pool, state_slot = :state_slot
    WHERE mint = :mint AND state_slot <= :state_slot`,
  setVerified: "UPDATE copiers SET verified = ? WHERE mint = ?",
  setTargets: "UPDATE copiers SET targets = ? WHERE mint = ?",
  setBook: `UPDATE copiers SET vault_lamports = :vault_lamports, wsol = :wsol, free = :free, equity = :equity, nav = :nav,
    positions_value = :positions_value, unrealized = :unrealized WHERE mint = :mint`,
  setMarket: `UPDATE copiers SET venue = :venue, pool = :pool, price = :price, mcap = :mcap, supply = :supply,
    decimals = :decimals, curve_progress = :curve_progress, market_at = :market_at WHERE mint = :mint`,
  setCopierUri: "UPDATE copiers SET name = ?, symbol = ?, uri = ? WHERE mint = ?",
  setCopierMeta: `UPDATE copiers SET meta_status = 'ok', name = COALESCE(NULLIF(name, ''), :name, ''),
    symbol = COALESCE(NULLIF(symbol, ''), :symbol, ''), image = :image, description = :description,
    twitter = :twitter, telegram = :telegram, website = :website WHERE mint = :mint`,
  setCopierMetaStatus: "UPDATE copiers SET meta_status = ?, meta_attempts = ?, meta_next_at = ? WHERE mint = ?",
  copiersMetaDue: "SELECT * FROM copiers WHERE meta_status = 'pending' AND meta_next_at <= ?",
  setFeeRouting: "UPDATE copiers SET fee_status = ?, fee_checked_at = ?, fee_detail = ?, fee_shareholders = ? WHERE mint = ?",

  upsertPosition: `INSERT INTO positions (copier, token_mint, target, tokens, cost, target_snapshot, target_peak,
      vault_peak, opened_at, last_trade_ts, state_slot)
    VALUES (:copier, :token_mint, :target, :tokens, :cost, :target_snapshot, :target_peak, :vault_peak, :opened_at,
      :last_trade_ts, :state_slot)
    ON CONFLICT(copier, token_mint) DO UPDATE SET target = excluded.target,
      tokens = excluded.tokens, cost = excluded.cost, target_snapshot = excluded.target_snapshot,
      target_peak = excluded.target_peak, vault_peak = excluded.vault_peak, opened_at = excluded.opened_at,
      last_trade_ts = excluded.last_trade_ts, state_slot = excluded.state_slot
    WHERE excluded.state_slot >= positions.state_slot`,
  deletePosition: "DELETE FROM positions WHERE copier = ? AND token_mint = ? AND state_slot <= ?",
  positions: "SELECT * FROM positions WHERE copier = ? ORDER BY CAST(cost AS INTEGER) DESC",
  allPositions: "SELECT * FROM positions",
  setPositionMark: "UPDATE positions SET venue = ?, mark_price = ?, value = ?, spot_value = ? WHERE copier = ? AND token_mint = ?",

  insertTrade: `INSERT OR IGNORE INTO trades (signature, event_index, slot, ts, copier, side, target, token_mint, venue, sol, tokens,
      cost_removed, pnl, realized_pnl, hwm, forced, equity, signal, target_balance, target_sig)
    VALUES (:signature, :event_index, :slot, :ts, :copier, :side, :target, :token_mint, :venue, :sol, :tokens,
      :cost_removed, :pnl, :realized_pnl, :hwm, :forced, :equity, :signal, :target_balance, :target_sig)`,
  trade: "SELECT * FROM trades WHERE signature = ? AND event_index = ?",
  tradesOf: "SELECT * FROM trades WHERE copier = ? ORDER BY slot DESC, event_index DESC LIMIT ?",
  sellSpan: "SELECT MIN(ts) AS first, MAX(ts) AS last, COUNT(*) AS n FROM trades WHERE copier = ? AND side = 'sell'",
  /** Last sell per `bucket` seconds (SQLite returns the bare columns of the MAX row). */
  pnlHistory: `SELECT ts, realized_pnl, hwm, MAX(slot * 65536 + event_index) AS k FROM trades
    WHERE copier = ? AND side = 'sell' GROUP BY ts / CAST(? AS INTEGER) ORDER BY k`,
  positionTrades: `SELECT copier, token_mint, COUNT(*) FILTER (WHERE side = 'buy') AS buys, COUNT(*) FILTER (WHERE side = 'sell') AS sells,
      ${SUM("CASE WHEN side = 'sell' THEN pnl END")} AS realized, MAX(ts) AS last_ts
    FROM trades WHERE copier = ? AND token_mint = ? AND ts >= ?`,
  firstBuy: "SELECT * FROM trades WHERE copier = ? AND token_mint = ? AND side = 'buy' AND ts >= ? ORDER BY slot, event_index LIMIT 1",
  targetTradeStats: `SELECT target, COUNT(*) FILTER (WHERE side = 'buy' OR side = 'sell') AS copies,
      ${SUM("CASE WHEN side = 'sell' THEN pnl END")} AS realized, MAX(ts) AS last_ts
    FROM trades WHERE copier = ? GROUP BY target`,

  upsertTargetTrade: `INSERT INTO target_trades (copier, signature, target, slot, block_time, side, token_mint, token_delta, sol_delta,
      target_sol_before, price, venue, status, reason, error, vault_sig, vault_sol_in, vault_tokens_in, detected_at, decided_at,
      source, received_at)
    VALUES (:copier, :signature, :target, :slot, :block_time, :side, :token_mint, :token_delta, :sol_delta, :target_sol_before,
      :price, :venue, :status, :reason, :error, :vault_sig, :vault_sol_in, :vault_tokens_in, :detected_at, :decided_at,
      :source, :received_at)
    ON CONFLICT(copier, signature, token_mint) DO UPDATE SET target = excluded.target, slot = excluded.slot,
      block_time = COALESCE(excluded.block_time, target_trades.block_time), side = excluded.side,
      token_delta = excluded.token_delta, sol_delta = excluded.sol_delta,
      target_sol_before = excluded.target_sol_before, price = excluded.price, venue = COALESCE(excluded.venue, target_trades.venue),
      status = excluded.status, reason = excluded.reason, error = excluded.error,
      vault_sig = COALESCE(excluded.vault_sig, target_trades.vault_sig), vault_sol_in = excluded.vault_sol_in,
      vault_tokens_in = excluded.vault_tokens_in, detected_at = excluded.detected_at, decided_at = excluded.decided_at,
      source = excluded.source, received_at = excluded.received_at
    WHERE excluded.source = 'keeper' OR target_trades.source = 'memo'`,
  hasTargetTrade: "SELECT 1 AS one FROM target_trades WHERE copier = ? AND signature = ? AND token_mint = ?",
  copy: `${COPY_SELECT} WHERE tt.copier = ? AND tt.signature = ? AND tt.token_mint = ?`,
  copiesOf: `${COPY_SELECT} WHERE tt.copier = ? ORDER BY tt.slot DESC, tt.signature, tt.token_mint LIMIT ?`,
  copiesAll: `${COPY_SELECT} ORDER BY tt.slot DESC, tt.signature, tt.token_mint LIMIT ?`,
  copiesOfTarget: `${COPY_SELECT} WHERE tt.target = ? ORDER BY tt.slot DESC, tt.signature, tt.token_mint LIMIT ?`,
  recentLags: `SELECT tt.copier, tt.block_time AS target_time, tt.slot AS target_slot, x.block_time AS vault_time, t.slot AS vault_slot, t.ts AS vault_ts
    FROM trades t JOIN target_trades tt ON tt.copier = t.copier AND tt.signature = t.target_sig AND tt.token_mint = t.token_mint
    LEFT JOIN txs x ON x.signature = t.signature
    WHERE t.ts >= ? ORDER BY t.slot DESC LIMIT ?`,
  lagsOf: `SELECT tt.block_time AS target_time, tt.slot AS target_slot, x.block_time AS vault_time, t.slot AS vault_slot, t.ts AS vault_ts
    FROM trades t JOIN target_trades tt ON tt.copier = t.copier AND tt.signature = t.target_sig AND tt.token_mint = t.token_mint
    LEFT JOIN txs x ON x.signature = t.signature
    WHERE t.copier = ? ORDER BY t.slot DESC LIMIT ?`,
  /** node:sqlite binds JS numbers as REAL: buckets are cast so `t / bucket` is integer division. */
  spark: `SELECT MAX(t) AS t, nav FROM candles WHERE mint = ? AND t >= ? AND nav IS NOT NULL GROUP BY t / CAST(? AS INTEGER) ORDER BY t`,
  tradesMissingTargets: `SELECT t.* FROM trades t WHERE t.target_sig IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM target_trades tt WHERE tt.copier = t.copier AND tt.signature = t.target_sig AND tt.token_mint = t.token_mint)
    ORDER BY t.slot LIMIT ?`,
  targetStats: `SELECT COUNT(*) AS observed, COUNT(*) FILTER (WHERE status = 'copied') AS copied,
      COUNT(*) FILTER (WHERE status = 'skipped') AS skipped, COUNT(*) FILTER (WHERE status = 'failed') AS failed
    FROM target_trades WHERE target = ?`,
  skippedByTarget: `SELECT target, COUNT(*) AS skipped FROM target_trades WHERE copier = ? AND status = 'skipped' GROUP BY target`,

  insertDistribution: `INSERT OR IGNORE INTO distributions (signature, copier, slot, ts, distributed, to_vault, to_targets, shares)
    VALUES (:signature, :copier, :slot, :ts, :distributed, :to_vault, :to_targets, :shares)`,
  insertEarning: "INSERT OR IGNORE INTO target_earnings (signature, copier, target, ts, lamports) VALUES (?, ?, ?, ?, ?)",
  earningsOf: `SELECT e.copier, m.symbol, ${SUM("e.lamports")} AS lamports, COUNT(*) AS distributions
    FROM target_earnings e LEFT JOIN copiers m ON m.mint = e.copier WHERE e.target = ? GROUP BY e.copier ORDER BY m.created_at DESC`,
  earningsByTarget: `SELECT target, ${SUM("lamports")} AS lamports FROM target_earnings GROUP BY target`,
  insertFeeSync: `INSERT OR IGNORE INTO fee_syncs (signature, event_index, slot, ts, copier, lamports, total)
    VALUES (:signature, :event_index, :slot, :ts, :copier, :lamports, :total)`,
  insertDeposit: `INSERT OR IGNORE INTO deposits (signature, event_index, slot, ts, copier, from_addr, lamports)
    VALUES (:signature, :event_index, :slot, :ts, :copier, :from_addr, :lamports)`,
  depositsTotal: `SELECT ${SUM("lamports")} AS total FROM deposits WHERE copier = ?`,
  insertBurn: `INSERT OR IGNORE INTO burns (signature, event_index, slot, ts, kind, copier, mint, sol_in, tokens, total_burned)
    VALUES (:signature, :event_index, :slot, :ts, :kind, :copier, :mint, :sol_in, :tokens, :total_burned)`,
  insertProfitSplit: `INSERT OR IGNORE INTO profit_splits (signature, event_index, slot, ts, copier, excess, to_buyback, to_platform)
    VALUES (:signature, :event_index, :slot, :ts, :copier, :excess, :to_buyback, :to_platform)`,
  burnsTotals: `SELECT ${SUM("CASE WHEN kind = 'coin' THEN sol_in END")} AS coin_sol, ${SUM("CASE WHEN kind = 'platform' THEN sol_in END")} AS platform_sol
    FROM burns`,
  mintBurned: `SELECT ${SUM("tokens")} AS tokens, ${SUM("CASE WHEN kind = 'platform' THEN sol_in END")} AS platform_sol FROM burns WHERE mint = ?`,

  copierAggs: `SELECT m.mint AS copier,
      (SELECT COUNT(*) FROM target_trades tt WHERE tt.copier = m.mint AND tt.status = 'copied' AND COALESCE(tt.block_time, tt.received_at) >= :since) AS copies24h,
      (SELECT COUNT(*) FROM target_trades tt WHERE tt.copier = m.mint AND tt.status = 'skipped' AND COALESCE(tt.block_time, tt.received_at) >= :since) AS skipped24h,
      (SELECT MAX(t.ts) FROM trades t WHERE t.copier = m.mint AND t.target_sig IS NOT NULL) AS last_copy_at,
      (SELECT ${SUM("d.distributed")} FROM distributions d WHERE d.copier = m.mint) AS distributed,
      (SELECT ${SUM("d.to_vault")} FROM distributions d WHERE d.copier = m.mint) AS to_vault,
      (SELECT ${SUM("d.to_targets")} FROM distributions d WHERE d.copier = m.mint) AS to_targets,
      (SELECT COUNT(*) FROM distributions d WHERE d.copier = m.mint) AS distributions,
      (SELECT MAX(d.ts) FROM distributions d WHERE d.copier = m.mint) AS last_distributed_at
    FROM copiers m`,
  statusCounts24h: `SELECT COUNT(*) FILTER (WHERE status = 'copied') AS copied, COUNT(*) FILTER (WHERE status = 'skipped') AS skipped
    FROM target_trades WHERE COALESCE(block_time, received_at) >= ?`,

  insertSnapshot: "INSERT OR REPLACE INTO snapshots (mint, ts, price, mcap, supply, nav) VALUES (?, ?, ?, ?, ?, ?)",
  snapshotsSince: "SELECT * FROM snapshots WHERE mint = ? AND ts >= ? ORDER BY ts",
  priceAt: "SELECT price FROM snapshots WHERE mint = ? AND ts <= ? AND price IS NOT NULL ORDER BY ts DESC LIMIT 1",
  firstPriceAfter: "SELECT price FROM snapshots WHERE mint = ? AND ts >= ? AND price IS NOT NULL ORDER BY ts LIMIT 1",
  pruneSnapshots: "DELETE FROM snapshots WHERE ts < ?",
  candle: "SELECT * FROM candles WHERE mint = ? AND t = ?",
  upsertCandle: `INSERT INTO candles (mint, t, o, h, l, c, mcap, nav) VALUES (:mint, :t, :o, :h, :l, :c, :mcap, :nav)
    ON CONFLICT(mint, t) DO UPDATE SET o = excluded.o, h = excluded.h, l = excluded.l, c = excluded.c,
      mcap = excluded.mcap, nav = excluded.nav`,
  candlesSince: "SELECT * FROM candles WHERE mint = ? AND t >= ? ORDER BY t",
  unalignedCandles: "SELECT * FROM candles WHERE t < ? AND t % CAST(? AS INTEGER) != 0 ORDER BY mint, t LIMIT ?",
  deleteCandleRange: "DELETE FROM candles WHERE mint = ? AND t > ? AND t < ?",

  token: "SELECT * FROM tokens WHERE mint = ?",
  ensureToken: "INSERT OR IGNORE INTO tokens (mint) VALUES (?)",
  setTokenMint: "UPDATE tokens SET program = ?, decimals = ?, name = COALESCE(?, name), symbol = COALESCE(?, symbol), uri = COALESCE(?, uri) WHERE mint = ?",
  setTokenMeta: "UPDATE tokens SET image = ?, name = COALESCE(name, ?), symbol = COALESCE(symbol, ?), meta_status = 'ok' WHERE mint = ?",
  setTokenMetaStatus: "UPDATE tokens SET meta_status = ?, meta_attempts = ?, meta_next_at = ? WHERE mint = ?",
  tokensDue: "SELECT * FROM tokens WHERE meta_status = 'pending' AND meta_next_at <= ? LIMIT 50",

  proposeChange: `INSERT INTO admin_changes (id, kind, status, proposed_at, eta, expires_at, propose_sig)
    VALUES (:id, :kind, 'open', :proposed_at, :eta, :expires_at, :propose_sig)
    ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, proposed_at = excluded.proposed_at, eta = excluded.eta,
      expires_at = COALESCE(excluded.expires_at, admin_changes.expires_at),
      propose_sig = COALESCE(admin_changes.propose_sig, excluded.propose_sig)`,
  resolveChange: `INSERT INTO admin_changes (id, kind, status, proposed_at, eta, resolved_at, resolve_sig)
    VALUES (:id, :kind, :status, 0, 0, :resolved_at, :resolve_sig)
    ON CONFLICT(id) DO UPDATE SET status = excluded.status, resolved_at = excluded.resolved_at, resolve_sig = excluded.resolve_sig`,
  invalidateChange: `INSERT INTO admin_changes (id, kind, status, proposed_at, eta, invalidated_reason, invalidated_at)
    VALUES (:id, :kind, 'open', 0, 0, :reason, :ts)
    ON CONFLICT(id) DO UPDATE SET invalidated_reason = excluded.invalidated_reason, invalidated_at = excluded.invalidated_at`,
  /** From the PendingChange account (payload, proposer, schedule); status is left to the events. */
  upsertPendingAccount: `INSERT INTO admin_changes (id, kind, status, proposer, proposed_at, eta, expires_at, payload)
    VALUES (:id, :kind, 'open', :proposer, :proposed_at, :eta, :expires_at, :payload)
    ON CONFLICT(id) DO UPDATE SET proposer = excluded.proposer, payload = excluded.payload,
      proposed_at = excluded.proposed_at, eta = excluded.eta, expires_at = excluded.expires_at`,
  adminChange: "SELECT * FROM admin_changes WHERE id = ?",
  openChanges: "SELECT * FROM admin_changes WHERE status = 'open' ORDER BY eta, id",
  changeHistory: "SELECT * FROM admin_changes WHERE status != 'open' ORDER BY resolved_at DESC, id DESC LIMIT ?",
  insertKeeperPause: "INSERT OR IGNORE INTO keeper_pauses (signature, event_index, ts, keeper) VALUES (?, ?, ?, ?)",
  keeperPauses: "SELECT * FROM keeper_pauses ORDER BY ts DESC LIMIT ?",

  directoryRows: "SELECT data FROM directory_rows",
  deleteDirectorySource: "DELETE FROM directory_rows WHERE source = ?",
  insertDirectoryRow: "INSERT OR REPLACE INTO directory_rows (source, address, data) VALUES (?, ?, ?)",
  directoryRuns: "SELECT * FROM directory_runs",
  recordDirectoryRun: `INSERT INTO directory_runs (source, last_ok_at, last_try_at, count, error) VALUES (:source, :ok_at, :try_at, :count, :error)
    ON CONFLICT(source) DO UPDATE SET last_try_at = excluded.last_try_at, error = excluded.error,
      last_ok_at = COALESCE(excluded.last_ok_at, directory_runs.last_ok_at),
      count = CASE WHEN excluded.last_ok_at IS NULL THEN directory_runs.count ELSE excluded.count END`,
  directoryAvatars: "SELECT * FROM directory_avatars",
  upsertDirectoryAvatar: `INSERT INTO directory_avatars (src, file, status, attempts, fetched_at, error) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(src) DO UPDATE SET file = excluded.file, status = excluded.status, attempts = excluded.attempts,
      fetched_at = excluded.fetched_at, error = excluded.error`,
} as const;

/** SQLite persistence (node:sqlite, WAL). All writes are synchronous; callers group them with `tx`. */
export class Store {
  private readonly db: DatabaseSync;
  private readonly stmts: Record<keyof typeof SQL, StatementSync>;
  /** Bumped by every `wipe`, so derived caches can key on it. */
  generation = 0;

  constructor(file: string) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");
    const version = row<{ user_version: number }>(this.db.prepare("PRAGMA user_version"))?.user_version ?? 0;
    this.tx(() => {
      if (version !== SCHEMA_VERSION) {
        for (const t of DATA_TABLES) this.db.exec(`DROP TABLE IF EXISTS ${t}`);
      }
      this.db.exec(SCHEMA);
      this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    });
    const stmts: Partial<Record<keyof typeof SQL, StatementSync>> = {};
    for (const key of Object.keys(SQL) as (keyof typeof SQL)[]) stmts[key] = this.db.prepare(SQL[key]);
    this.stmts = stmts as Record<keyof typeof SQL, StatementSync>;
  }

  tx<T>(fn: () => T): T {
    if (this.db.isTransaction) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** Drops every chain-derived row (cluster genesis changed, e.g. a reset localnet). */
  wipe(): void {
    this.tx(() => {
      for (const t of DATA_TABLES) this.db.exec(`DELETE FROM ${t}`);
    });
    this.generation += 1;
  }

  close(): void {
    this.db.close();
  }

  // ---------------- sync state ----------------

  getState(key: string): string | null {
    return row<{ value: string }>(this.stmts.getState, [key])?.value ?? null;
  }

  setState(key: string, value: string): void {
    this.stmts.setState.run(key, value);
  }

  deleteState(key: string): void {
    this.stmts.deleteState.run(key);
  }

  hasTx(signature: string): boolean {
    return row(this.stmts.hasTx, [signature]) !== undefined;
  }

  txSlot(signature: string): number | null {
    return row<{ slot: number }>(this.stmts.txSlot, [signature])?.slot ?? null;
  }

  txBlockTime(signature: string): number | null {
    return row<{ block_time: number | null }>(this.stmts.txBlockTime, [signature])?.block_time ?? null;
  }

  markTx(signature: string, slot: number, blockTime: number | null, failed: boolean, eventCount: number): void {
    this.stmts.insertTx.run(signature, slot, blockTime, failed ? 1 : 0, eventCount);
  }

  counts(): Record<string, number> {
    return row<Record<string, number>>(this.stmts.counts) ?? {};
  }

  // ---------------- copiers ----------------

  insertCopier(r: Pick<CopierRow, "mint" | "kind" | "launcher" | "vault" | "targets" | "trader_bps" | "created_at" | "sharing_config" | "registered_sig">): void {
    this.stmts.insertCopier.run(r);
  }

  copier(mint: string): CopierRow | undefined {
    return row<CopierRow>(this.stmts.copier, [mint]);
  }

  copiers(): CopierRow[] {
    return rows<CopierRow>(this.stmts.copiers);
  }

  copiersTargeting(address: string): CopierRow[] {
    return rows<CopierRow>(this.stmts.copiersTargeting, [address]);
  }

  setCopierState(mint: string, slot: number, s: CopierState): boolean {
    return Number(this.stmts.setCopierState.run({ ...s, mint, state_slot: slot }).changes) > 0;
  }

  setVerified(mint: string, mask: number): void {
    this.stmts.setVerified.run(mask, mint);
  }

  setTargets(mint: string, targets: string[]): void {
    this.stmts.setTargets.run(JSON.stringify(targets), mint);
  }

  setBook(mint: string, b: VaultBookRow): void {
    this.stmts.setBook.run({ ...b, mint });
  }

  setMarket(mint: string, m: MarketRow): void {
    this.stmts.setMarket.run({ ...m, mint });
  }

  setCopierUri(mint: string, name: string, symbol: string, uri: string): void {
    this.stmts.setCopierUri.run(name, symbol, uri, mint);
  }

  setCopierMeta(
    mint: string,
    m: { name: string | null; symbol: string | null; image: string | null; description: string | null; twitter: string | null; telegram: string | null; website: string | null },
  ): void {
    this.stmts.setCopierMeta.run({ ...m, mint });
  }

  setCopierMetaStatus(mint: string, status: MetaStatus, attempts: number, nextAt: number): void {
    this.stmts.setCopierMetaStatus.run(status, attempts, nextAt, mint);
  }

  setFeeRouting(mint: string, r: { status: CopierRow["fee_status"]; checkedAt: number; detail: string | null; shareholders: { address: string; bps: number }[] }): void {
    this.stmts.setFeeRouting.run(r.status, r.checkedAt, r.detail, JSON.stringify(r.shareholders), mint);
  }

  copiersMetaDue(now: number): CopierRow[] {
    return rows<CopierRow>(this.stmts.copiersMetaDue, [now]);
  }

  // ---------------- positions ----------------

  upsertPosition(p: Omit<PositionRow, "mark_price" | "value" | "spot_value" | "venue">): void {
    this.stmts.upsertPosition.run({ ...p });
  }

  deletePosition(copier: string, tokenMint: string, slot: number): void {
    this.stmts.deletePosition.run(copier, tokenMint, slot);
  }

  positions(copier: string): PositionRow[] {
    return rows<PositionRow>(this.stmts.positions, [copier]);
  }

  allPositions(): PositionRow[] {
    return rows<PositionRow>(this.stmts.allPositions);
  }

  setPositionMark(
    copier: string,
    tokenMint: string,
    venue: PositionRow["venue"],
    price: number | null,
    value: string | null,
    spotValue: string | null,
  ): void {
    this.stmts.setPositionMark.run(venue, price, value, spotValue, copier, tokenMint);
  }

  // ---------------- vault trades ----------------

  insertTrade(t: TradeRow): boolean {
    return Number(this.stmts.insertTrade.run({ ...t }).changes) > 0;
  }

  trade(signature: string, eventIndex: number): TradeRow | undefined {
    return row<TradeRow>(this.stmts.trade, [signature, eventIndex]);
  }

  tradesOf(copier: string, limit: number): TradeRow[] {
    return rows<TradeRow>(this.stmts.tradesOf, [copier, limit]);
  }

  /**
   * `[ts, realized PnL, HWM]` after the copier's sells, oldest first, at most `maxPoints`: the last sell of each
   * `ceil(span / maxPoints)`-second bucket (every sell while they fit).
   */
  pnlHistory(copier: string, maxPoints: number): [number, string, string][] {
    const span = row<{ first: number | null; last: number | null; n: number }>(this.stmts.sellSpan, [copier]);
    if (!span || span.n === 0 || span.first === null || span.last === null) return [];
    const bucket = span.n <= maxPoints ? 1 : Math.max(1, Math.ceil((span.last - span.first + 1) / maxPoints));
    return rows<{ ts: number; realized_pnl: string | null; hwm: string | null }>(this.stmts.pnlHistory, [copier, bucket]).map((r) => [
      r.ts,
      r.realized_pnl ?? "0",
      r.hwm ?? "0",
    ]);
  }

  /** Buy/sell counts and realized PnL of the position opened at `openedAt`. */
  positionTrades(copier: string, tokenMint: string, openedAt: number): { buys: number; sells: number; realized: string; last_ts: number | null } {
    return row(this.stmts.positionTrades, [copier, tokenMint, openedAt]) ?? { buys: 0, sells: 0, realized: "0", last_ts: null };
  }

  firstBuy(copier: string, tokenMint: string, openedAt: number): TradeRow | undefined {
    return row<TradeRow>(this.stmts.firstBuy, [copier, tokenMint, openedAt]);
  }

  targetTradeStats(copier: string): { target: string; copies: number; realized: string; last_ts: number | null }[] {
    return rows(this.stmts.targetTradeStats, [copier]);
  }

  // ---------------- target trades / copies ----------------

  upsertTargetTrade(r: TargetTradeRow): void {
    this.stmts.upsertTargetTrade.run({ ...r });
  }

  hasTargetTrade(copier: string, signature: string, tokenMint: string): boolean {
    return row(this.stmts.hasTargetTrade, [copier, signature, tokenMint]) !== undefined;
  }

  /** One leg of a target tx (a tx can touch several mints: one row per mint). */
  copy(copier: string, signature: string, tokenMint: string): CopyRow | undefined {
    return row<CopyRow>(this.stmts.copy, [copier, signature, tokenMint]);
  }

  copies(copier: string | null, limit: number): CopyRow[] {
    return copier ? rows<CopyRow>(this.stmts.copiesOf, [copier, limit]) : rows<CopyRow>(this.stmts.copiesAll, [limit]);
  }

  copiesOfTarget(target: string, limit: number): CopyRow[] {
    return rows<CopyRow>(this.stmts.copiesOfTarget, [target, limit]);
  }

  /** Target/vault timing of the latest linked copies (all copiers since unix `since`, or one copier). */
  lags(
    scope: { copier: string } | { since: number },
    limit: number,
  ): { copier?: string; target_time: number | null; target_slot: number; vault_time: number | null; vault_slot: number; vault_ts: number }[] {
    return "copier" in scope ? rows(this.stmts.lagsOf, [scope.copier, limit]) : rows(this.stmts.recentLags, [scope.since, limit]);
  }

  /** Last 1m-candle NAV per `bucket` seconds since `since` (SQLite returns the bare `nav` of the MAX(t) row). */
  sparkPoints(mint: string, since: number, bucket: number): [number, number][] {
    return rows<{ t: number; nav: string }>(this.stmts.spark, [mint, since, bucket]).map((r) => [r.t, Number(r.nav)]);
  }

  /** Memo-linked vault trades whose target trade row is missing (keeper report lost or not sent yet). */
  tradesMissingTargets(limit: number): TradeRow[] {
    return rows<TradeRow>(this.stmts.tradesMissingTargets, [limit]);
  }

  targetStats(target: string): { observed: number; copied: number; skipped: number; failed: number } {
    return row(this.stmts.targetStats, [target]) ?? { observed: 0, copied: 0, skipped: 0, failed: 0 };
  }

  skippedByTarget(copier: string): Map<string, number> {
    return new Map(rows<{ target: string; skipped: number }>(this.stmts.skippedByTarget, [copier]).map((r) => [r.target, r.skipped]));
  }

  // ---------------- fees / deposits / burns / splits ----------------

  insertDistribution(d: DistributionRow, earnings: { target: string; lamports: string }[]): boolean {
    const inserted = Number(this.stmts.insertDistribution.run({ ...d }).changes) > 0;
    if (inserted) for (const e of earnings) this.stmts.insertEarning.run(d.signature, d.copier, e.target, d.ts, e.lamports);
    return inserted;
  }

  earningsOf(target: string): { copier: string; symbol: string | null; lamports: string; distributions: number }[] {
    return rows(this.stmts.earningsOf, [target]);
  }

  earningsByTarget(): Map<string, string> {
    return new Map(rows<{ target: string; lamports: string }>(this.stmts.earningsByTarget).map((r) => [r.target, r.lamports]));
  }

  insertFeeSync(r: FeeSyncRow): boolean {
    return Number(this.stmts.insertFeeSync.run({ ...r }).changes) > 0;
  }

  insertDeposit(r: DepositRow): boolean {
    return Number(this.stmts.insertDeposit.run({ ...r }).changes) > 0;
  }

  depositsTotal(copier: string): string {
    return row<{ total: string }>(this.stmts.depositsTotal, [copier])?.total ?? "0";
  }

  insertBurn(r: BurnRow): boolean {
    return Number(this.stmts.insertBurn.run({ ...r }).changes) > 0;
  }

  insertProfitSplit(r: ProfitSplitRow): boolean {
    return Number(this.stmts.insertProfitSplit.run({ ...r }).changes) > 0;
  }

  burnsTotals(): { coin_sol: string; platform_sol: string } {
    return row(this.stmts.burnsTotals) ?? { coin_sol: "0", platform_sol: "0" };
  }

  mintBurned(mint: string): { tokens: string; platform_sol: string } {
    return row(this.stmts.mintBurned, [mint]) ?? { tokens: "0", platform_sol: "0" };
  }

  burns(f: { copier?: string; kind?: "coin" | "platform"; limit: number }): BurnRow[] {
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    if (f.copier) {
      where.push("copier = ?");
      params.push(f.copier);
    }
    if (f.kind) {
      where.push("kind = ?");
      params.push(f.kind);
    }
    const sql = `SELECT * FROM burns ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY slot DESC, event_index DESC LIMIT ?`;
    return rows<BurnRow>(this.db.prepare(sql), [...params, f.limit]);
  }

  distributions(copier: string | null, limit: number): DistributionRow[] {
    const sql = `SELECT * FROM distributions ${copier ? "WHERE copier = ?" : ""} ORDER BY slot DESC LIMIT ?`;
    return rows<DistributionRow>(this.db.prepare(sql), copier ? [copier, limit] : [limit]);
  }

  feeSyncs(copier: string | null, limit: number): FeeSyncRow[] {
    const sql = `SELECT * FROM fee_syncs ${copier ? "WHERE copier = ?" : ""} ORDER BY slot DESC, event_index DESC LIMIT ?`;
    return rows<FeeSyncRow>(this.db.prepare(sql), copier ? [copier, limit] : [limit]);
  }

  deposits(copier: string | null, limit: number): DepositRow[] {
    const sql = `SELECT * FROM deposits ${copier ? "WHERE copier = ?" : ""} ORDER BY slot DESC, event_index DESC LIMIT ?`;
    return rows<DepositRow>(this.db.prepare(sql), copier ? [copier, limit] : [limit]);
  }

  profitSplits(copier: string | null, limit: number): ProfitSplitRow[] {
    const sql = `SELECT * FROM profit_splits ${copier ? "WHERE copier = ?" : ""} ORDER BY slot DESC, event_index DESC LIMIT ?`;
    return rows<ProfitSplitRow>(this.db.prepare(sql), copier ? [copier, limit] : [limit]);
  }

  copierAggs(since: number): Map<string, CopierAggRow> {
    return new Map(rows<CopierAggRow>(this.stmts.copierAggs, { since }).map((r) => [r.copier, r]));
  }

  statusCounts(since: number): { copied: number; skipped: number } {
    return row(this.stmts.statusCounts24h, [since]) ?? { copied: 0, skipped: 0 };
  }

  // ---------------- market series ----------------

  insertSnapshot(s: SnapshotRow): void {
    this.stmts.insertSnapshot.run(s.mint, s.ts, s.price, s.mcap, s.supply, s.nav);
  }

  snapshotsSince(mint: string, since: number): SnapshotRow[] {
    return rows<SnapshotRow>(this.stmts.snapshotsSince, [mint, since]);
  }

  /** The last price sampled at or before `ts`; else the first one after it (history shorter than the window). */
  priceNear(mint: string, ts: number): number | null {
    return (
      row<{ price: number }>(this.stmts.priceAt, [mint, ts])?.price ?? row<{ price: number }>(this.stmts.firstPriceAfter, [mint, ts])?.price ?? null
    );
  }

  pruneSnapshots(before: number): void {
    this.stmts.pruneSnapshots.run(before);
  }

  candle(mint: string, t: number): CandleRow | undefined {
    return row<CandleRow>(this.stmts.candle, [mint, t]);
  }

  upsertCandle(c: CandleRow): void {
    this.stmts.upsertCandle.run({ ...c });
  }

  candlesSince(mint: string, since: number): CandleRow[] {
    return rows<CandleRow>(this.stmts.candlesSince, [mint, since]);
  }

  /**
   * Retention for the 1-minute candles: every candle older than `before` is folded into one `bucket`-second candle
   * (o of the first minute, h/l over the bucket, c/mcap/nav of the last), stamped at the bucket start. At most
   * `maxRows` minute rows per call; returns how many it folded (call again while > 0 to drain a backlog).
   */
  compactCandles(before: number, bucket: number, maxRows = 50_000): number {
    const cutoff = before - (before % bucket);
    const raw = rows<CandleRow>(this.stmts.unalignedCandles, [cutoff, bucket, maxRows]);
    if (raw.length === 0) return 0;
    const groups = new Map<string, CandleRow[]>();
    for (const c of raw) {
      const key = `${c.mint}:${c.t - (c.t % bucket)}`;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = []));
      g.push(c);
    }
    this.tx(() => {
      for (const g of groups.values()) {
        const { mint } = g[0]!;
        const start = g[0]!.t - (g[0]!.t % bucket);
        const head = this.candle(mint, start);
        const all = head ? [head, ...g] : g;
        const last = all[all.length - 1]!;
        const merged: CandleRow = {
          mint,
          t: start,
          o: all[0]!.o,
          h: Math.max(...all.map((c) => c.h)),
          l: Math.min(...all.map((c) => c.l)),
          c: last.c,
          mcap: [...all].reverse().find((c) => c.mcap !== null)?.mcap ?? null,
          nav: [...all].reverse().find((c) => c.nav !== null)?.nav ?? null,
        };
        // Delete only the minutes folded here: a page cut by `maxRows` may stop mid-bucket, and the rest are folded
        // into this bucket candle (`head`) on the next call.
        this.stmts.deleteCandleRange.run(mint, start, g[g.length - 1]!.t + 1);
        this.upsertCandle(merged);
      }
    });
    return raw.length;
  }

  // ---------------- governance ----------------

  proposeChange(r: { id: number; kind: string; proposed_at: number; eta: number; expires_at: number | null; propose_sig: string | null }): void {
    this.stmts.proposeChange.run({ ...r });
  }

  resolveChange(r: { id: number; kind: string; status: "executed" | "cancelled" | "discarded"; resolved_at: number; resolve_sig: string }): void {
    this.stmts.resolveChange.run({ ...r });
  }

  invalidateChange(r: { id: number; kind: string; reason: NonNullable<AdminChangeRow["invalidated_reason"]>; ts: number }): void {
    this.stmts.invalidateChange.run({ ...r });
  }

  upsertPendingAccount(r: { id: number; kind: string; proposer: string; proposed_at: number; eta: number; expires_at: number; payload: string }): void {
    this.stmts.upsertPendingAccount.run({ ...r });
  }

  adminChange(id: number): AdminChangeRow | undefined {
    return row<AdminChangeRow>(this.stmts.adminChange, [id]);
  }

  /** Changes not closed by an execute / cancel / discard event (their status is derived at read time). */
  openChanges(): AdminChangeRow[] {
    return rows<AdminChangeRow>(this.stmts.openChanges);
  }

  changeHistory(limit: number): AdminChangeRow[] {
    return rows<AdminChangeRow>(this.stmts.changeHistory, [limit]);
  }

  insertKeeperPause(signature: string, eventIndex: number, ts: number, keeper: string): boolean {
    return Number(this.stmts.insertKeeperPause.run(signature, eventIndex, ts, keeper).changes) > 0;
  }

  keeperPauses(limit: number): { signature: string; event_index: number; ts: number; keeper: string }[] {
    return rows(this.stmts.keeperPauses, [limit]);
  }

  // ---------------- tokens ----------------

  token(mint: string): TokenRow | undefined {
    return row<TokenRow>(this.stmts.token, [mint]);
  }

  ensureToken(mint: string): void {
    this.stmts.ensureToken.run(mint);
  }

  setTokenMint(mint: string, program: string, decimals: number, meta: { name: string; symbol: string; uri: string } | null): void {
    this.stmts.setTokenMint.run(program, decimals, meta?.name || null, meta?.symbol || null, meta?.uri || null, mint);
  }

  setTokenMeta(mint: string, image: string | null, name: string | null, symbol: string | null): void {
    this.stmts.setTokenMeta.run(image, name, symbol, mint);
  }

  setTokenMetaStatus(mint: string, status: MetaStatus, attempts: number, nextAt: number): void {
    this.stmts.setTokenMetaStatus.run(status, attempts, nextAt, mint);
  }

  tokensDue(now: number): TokenRow[] {
    return rows<TokenRow>(this.stmts.tokensDue, [now]);
  }

  // ---------------- wallet directory (off-chain) ----------------

  /** Every stored source row (JSON `SourceWallet`). */
  directoryRows(): string[] {
    return rows<{ data: string }>(this.stmts.directoryRows).map((r) => r.data);
  }

  /** Atomically replaces one source's rows. */
  replaceDirectorySource(source: string, items: { address: string; data: string }[]): void {
    this.tx(() => {
      this.stmts.deleteDirectorySource.run(source);
      for (const it of items) this.stmts.insertDirectoryRow.run(source, it.address, it.data);
    });
  }

  directoryRuns(): DirectoryRunRow[] {
    return rows<DirectoryRunRow>(this.stmts.directoryRuns);
  }

  /** `okAt` null = failed attempt (keeps the last success and its count). */
  recordDirectoryRun(source: string, tryAt: number, okAt: number | null, count: number, error: string | null): void {
    this.stmts.recordDirectoryRun.run({ source, ok_at: okAt, try_at: tryAt, count, error });
  }

  directoryAvatars(): DirectoryAvatarRow[] {
    return rows<DirectoryAvatarRow>(this.stmts.directoryAvatars);
  }

  upsertDirectoryAvatar(r: DirectoryAvatarRow): void {
    this.stmts.upsertDirectoryAvatar.run(r.src, r.file, r.status, r.attempts, r.fetched_at, r.error);
  }
}
