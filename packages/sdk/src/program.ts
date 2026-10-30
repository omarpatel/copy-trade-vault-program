/**
 * The Copier program's IDL (synced from target/ by `pnpm --filter @copy-trade-vault/sdk sync-idl`), its account
 * decoders and event parser. Everything is normalized to plain JS: PublicKey for keys in accounts,
 * base58 strings in events, bigint for u64/i64, number for small ints, lower-case strings for enums.
 */
import { BN, EventParser, Program, utils, type IdlTypes, type Provider } from "@coral-xyz/anchor";
import { PublicKey, type Commitment, type Connection } from "@solana/web3.js";
import { COPIER_PROGRAM_ID, PUMP_AMM_PROGRAM_ID, PUMP_PROGRAM_ID } from "./constants";
import idlJson from "./idl/copy_vault.json";
import type { CopyVault as CopierIdl } from "./idl/copy_vault";
import { configPda, copierPda, positionPda } from "./pda";

export type { CopierIdl };
export const COPIER_IDL = idlJson as unknown as CopierIdl;

/** Address check at compile time: a re-synced IDL for another deployment fails the typecheck. */
const IDL_ADDRESS: CopierIdl["address"] = "9R8g8JtEqRAh5yZ4aXbf1mWcfgLq9kAo6fmx93MSK9k7";
if (IDL_ADDRESS !== COPIER_PROGRAM_ID.toBase58()) throw new Error("copier IDL address mismatch");

let cached: Program<CopierIdl> | undefined;

/**
 * An offline Anchor `Program` (camelCased IDL, coders, instruction builders). It never touches the
 * network: builders pass every account explicitly.
 */
export function copierProgram(): Program<CopierIdl> {
  cached ??= new Program<CopierIdl>(COPIER_IDL, {} as Provider);
  return cached;
}

type T = IdlTypes<CopierIdl>;

// ---------------------------------------------------------------------------------------------
// Normalized account types
// ---------------------------------------------------------------------------------------------

import type { InvalidationReason, CopierKind } from "./api";
export type VenueKind = "curve" | "pool";
export type TradeSide = "buy" | "sell";

export interface TradeDescriptor {
  program: PublicKey;
  disc: Uint8Array;
  side: TradeSide;
  venue: VenueKind;
  userIdx: number;
  baseMintIdx: number;
  venueIdx: number;
  minAccounts: number;
}

export interface ProgramParams {
  maxTradeBps: number;
  maxPositionBps: number;
  maxOpenPositions: number;
  minTradeLamports: bigint;
  minSignalLamports: bigint;
  signalMultipleBps: number;
  maxImpactBps: number;
  slippageBps: number;
  vaultFloorLamports: bigint;
  maxHoldSecs: bigint;
  keeperGraceSecs: bigint;
  /** Length of a copier's buy spend window. */
  spendWindowSecs: bigint;
  /** Max lamports `copier_buy` may spend per window, in bps of equity at the window's start. */
  maxWindowSpendBps: number;
}

export interface ConfigAccount {
  admin: PublicKey;
  pendingAdmin: PublicKey;
  keeper: PublicKey;
  /** `PublicKey.default` until `set_platform_mint`. */
  platformMint: PublicKey;
  params: ProgramParams;
  descriptors: TradeDescriptor[];
  bump: number;
  burnPoolBump: number;
  /** the platform token tokens the burn pool bought and burned. */
  platformBurned: bigint;
  /** Lamports the burn pool spent on those buys. */
  platformBurnSpent: bigint;
  /** Seconds between a `propose_*` and its earliest `execute_pending` (fixed at initialization). */
  timelockSecs: bigint;
  /** Id the next `propose_*` will use (its PendingChange PDA seed). */
  nextChangeId: bigint;
  /** Earliest `accept_admin` for `pendingAdmin`. */
  pendingAdminEta: bigint;
  /** Last keeper liveness proof (`keeper_heartbeat` or any keeper-signed trade / burn). */
  keeperHeartbeatTs: bigint;
  lastPlatformBurnTs: bigint;
  /** Live PendingChange id per kind (`CHANGE_KIND_INDEX`); `NO_CHANGE_ID` = none. */
  latestChangeIds: bigint[];
  /** Bit i set: `descriptors[i]` is proven (seeded, or a trade / burn through it succeeded). */
  descriptorsProven: number;
}

export interface CopierAccount {
  mint: PublicKey;
  launcher: PublicKey;
  kind: CopierKind;
  targets: PublicKey[];
  traderBps: number;
  /** Bit i set: targets[i] signed `verify_trader`. */
  verified: number;
  vaultBump: number;
  bump: number;
  createdAt: bigint;
  sharingConfig: PublicKey;
  accountedLamports: bigint;
  feesIn: bigint;
  capitalIn: bigint;
  openCost: bigint;
  openPositions: number;
  realizedPnl: bigint;
  hwm: bigint;
  buybackPool: bigint;
  platformSent: bigint;
  burned: bigint;
  buybackSpent: bigint;
  trades: bigint;
  lastKeeperTs: bigint;
  graduatedPool: PublicKey;
  platformPending: bigint;
  lastBuybackTs: bigint;
  /** Open positions per target index (parallel to `targets`, 16 slots). */
  targetPositions: number[];
  /** Start (unix s) of the current buy spend window. */
  windowStart: bigint;
  /** Lamports `copier_buy` spent in the current window (measured, rent included). */
  windowSpent: bigint;
  /** Equity at the window's start: the window cap's base. */
  windowEquity: bigint;
  /** Slot of the last permissionless `copier_sell` (one slice per slot). */
  lastPublicSellSlot: bigint;
}

export type ChangeKind = "keeper" | "params" | "descriptors" | "indexTargets";


/** `Config.latest_change_ids` index of each kind. */
export const CHANGE_KIND_INDEX: Record<ChangeKind, number> = { keeper: 0, params: 1, descriptors: 2, indexTargets: 3 };

export type PendingChangeStatus = "superseded" | "expired" | "queued" | "executable";

/**
 * Where a PendingChange stands at `nowTs` (program rules): `superseded` when it is no longer its
 * kind's live id (newer proposal, cancel, keeper pause, admin handover) — only `discard_pending`
 * closes it; `expired` past `expiresAt`; `queued` before `eta`; else `executable` (`execute_pending`).
 */
export function pendingChangeStatus(
  change: Pick<PendingChangeAccount, "id" | "kind" | "eta" | "expiresAt">,
  config: Pick<ConfigAccount, "latestChangeIds">,
  nowTs: bigint | number,
): PendingChangeStatus {
  if (config.latestChangeIds[CHANGE_KIND_INDEX[change.kind]] !== change.id) return "superseded";
  const now = BigInt(nowTs);
  if (now > change.expiresAt) return "expired";
  if (now < change.eta) return "queued";
  return "executable";
}

/** A timelocked admin change `["pending", id]`; only the payload field of its `kind` is meaningful. */
export interface PendingChangeAccount {
  id: bigint;
  kind: ChangeKind;
  proposer: PublicKey;
  proposedAt: bigint;
  /** Earliest execution (unix s). */
  eta: bigint;
  /** Last moment it may execute (`eta + EXECUTE_WINDOW_SECS`); later only `discard_pending` closes it. */
  expiresAt: bigint;
  keeper: PublicKey;
  params: ProgramParams;
  descriptors: TradeDescriptor[];
  /** The Index copier whose targets change (`indexTargets`). */
  copier: PublicKey;
  targets: PublicKey[];
  bump: number;
}

export interface PositionAccount {
  mint: PublicKey;
  tokenMint: PublicKey;
  target: PublicKey;
  tokens: bigint;
  cost: bigint;
  targetSnapshot: bigint;
  targetPeak: bigint;
  vaultPeak: bigint;
  openedAt: bigint;
  lastTradeTs: bigint;
  bump: number;
}

const big = (v: BN) => BigInt(v.toString());
const enumName = <K extends string>(v: object) => Object.keys(v)[0] as K;

function toParams(p: T["params"]): ProgramParams {
  return {
    maxTradeBps: p.maxTradeBps,
    maxPositionBps: p.maxPositionBps,
    maxOpenPositions: p.maxOpenPositions,
    minTradeLamports: big(p.minTradeLamports),
    minSignalLamports: big(p.minSignalLamports),
    signalMultipleBps: p.signalMultipleBps,
    maxImpactBps: p.maxImpactBps,
    slippageBps: p.slippageBps,
    vaultFloorLamports: big(p.vaultFloorLamports),
    maxHoldSecs: big(p.maxHoldSecs),
    keeperGraceSecs: big(p.keeperGraceSecs),
    spendWindowSecs: big(p.spendWindowSecs),
    maxWindowSpendBps: p.maxWindowSpendBps,
  };
}

/** `ProgramParams` in the shape the IDL coder encodes (`propose_params`). */
export function paramsToIdl(p: ProgramParams): T["params"] {
  return {
    maxTradeBps: p.maxTradeBps,
    maxPositionBps: p.maxPositionBps,
    maxOpenPositions: p.maxOpenPositions,
    minTradeLamports: new BN(p.minTradeLamports.toString()),
    minSignalLamports: new BN(p.minSignalLamports.toString()),
    signalMultipleBps: p.signalMultipleBps,
    maxImpactBps: p.maxImpactBps,
    slippageBps: p.slippageBps,
    vaultFloorLamports: new BN(p.vaultFloorLamports.toString()),
    maxHoldSecs: new BN(p.maxHoldSecs.toString()),
    keeperGraceSecs: new BN(p.keeperGraceSecs.toString()),
    spendWindowSecs: new BN(p.spendWindowSecs.toString()),
    maxWindowSpendBps: p.maxWindowSpendBps,
  };
}

function toDescriptor(d: T["tradeDescriptor"]): TradeDescriptor {
  return {
    program: d.program,
    disc: Uint8Array.from(d.disc),
    side: enumName<TradeSide>(d.side),
    venue: enumName<VenueKind>(d.venue),
    userIdx: d.userIdx,
    baseMintIdx: d.baseMintIdx,
    venueIdx: d.venueIdx,
    minAccounts: d.minAccounts,
  };
}

/** `TradeDescriptor` in the shape the IDL coder encodes (`propose_descriptors`). */
export function descriptorToIdl(d: TradeDescriptor): T["tradeDescriptor"] {
  return {
    program: d.program,
    disc: [...d.disc],
    side: d.side === "buy" ? { buy: {} } : { sell: {} },
    venue: d.venue === "curve" ? { curve: {} } : { pool: {} },
    userIdx: d.userIdx,
    baseMintIdx: d.baseMintIdx,
    venueIdx: d.venueIdx,
    minAccounts: d.minAccounts,
  } as T["tradeDescriptor"];
}

type Bytes = Buffer | Uint8Array;

export function decodeConfig(data: Bytes): ConfigAccount {
  const c = copierProgram().coder.accounts.decode<T["config"]>("config", Buffer.from(data));
  return {
    admin: c.admin,
    pendingAdmin: c.pendingAdmin,
    keeper: c.keeper,
    platformMint: c.platformMint,
    params: toParams(c.params),
    descriptors: c.descriptors.map(toDescriptor),
    bump: c.bump,
    burnPoolBump: c.burnPoolBump,
    platformBurned: big(c.platformBurned),
    platformBurnSpent: big(c.platformBurnSpent),
    timelockSecs: big(c.timelockSecs),
    nextChangeId: big(c.nextChangeId),
    pendingAdminEta: big(c.pendingAdminEta),
    keeperHeartbeatTs: big(c.keeperHeartbeatTs),
    lastPlatformBurnTs: big(c.lastPlatformBurnTs),
    latestChangeIds: c.latestChangeIds.map(big),
    descriptorsProven: c.descriptorsProven,
  };
}

export function decodeCopier(data: Bytes): CopierAccount {
  const m = copierProgram().coder.accounts.decode<T["copier"]>("copier", Buffer.from(data));
  return {
    mint: m.mint,
    launcher: m.launcher,
    kind: enumName<CopierKind>(m.kind),
    targets: m.targets,
    traderBps: m.traderBps,
    verified: m.verified,
    vaultBump: m.vaultBump,
    bump: m.bump,
    createdAt: big(m.createdAt),
    sharingConfig: m.sharingConfig,
    accountedLamports: big(m.accountedLamports),
    feesIn: big(m.feesIn),
    capitalIn: big(m.capitalIn),
    openCost: big(m.openCost),
    openPositions: m.openPositions,
    realizedPnl: big(m.realizedPnl),
    hwm: big(m.hwm),
    buybackPool: big(m.buybackPool),
    platformSent: big(m.platformSent),
    burned: big(m.burned),
    buybackSpent: big(m.buybackSpent),
    trades: big(m.trades),
    lastKeeperTs: big(m.lastKeeperTs),
    graduatedPool: m.graduatedPool,
    platformPending: big(m.platformPending),
    lastBuybackTs: big(m.lastBuybackTs),
    targetPositions: [...m.targetPositions],
    windowStart: big(m.windowStart),
    windowSpent: big(m.windowSpent),
    windowEquity: big(m.windowEquity),
    lastPublicSellSlot: big(m.lastPublicSellSlot),
  };
}

export function decodePosition(data: Bytes): PositionAccount {
  const p = copierProgram().coder.accounts.decode<T["position"]>("position", Buffer.from(data));
  return {
    mint: p.mint,
    tokenMint: p.tokenMint,
    target: p.target,
    tokens: big(p.tokens),
    cost: big(p.cost),
    targetSnapshot: big(p.targetSnapshot),
    targetPeak: big(p.targetPeak),
    vaultPeak: big(p.vaultPeak),
    openedAt: big(p.openedAt),
    lastTradeTs: big(p.lastTradeTs),
    bump: p.bump,
  };
}

export function decodePendingChange(data: Bytes): PendingChangeAccount {
  const c = copierProgram().coder.accounts.decode<T["pendingChange"]>("pendingChange", Buffer.from(data));
  return {
    id: big(c.id),
    kind: enumName<ChangeKind>(c.kind),
    proposer: c.proposer,
    proposedAt: big(c.proposedAt),
    eta: big(c.eta),
    expiresAt: big(c.expiresAt),
    keeper: c.keeper,
    params: toParams(c.params),
    descriptors: c.descriptors.map(toDescriptor),
    copier: c.copier,
    targets: c.targets,
    bump: c.bump,
  };
}

/**
 * Anchor account discriminators (sha256("account:<Name>")[..8]) for `getProgramAccounts` memcmp
 * filters. Constants so importing the SDK never depends on IDL contents (asserted against the IDL in tests).
 */
export const COPIER_ACCOUNT_DISC = {
  config: Uint8Array.from(Buffer.from("9b0caae01efacc82", "hex")),
  copier: Uint8Array.from(Buffer.from("bf6541629916ad06", "hex")),
  position: Uint8Array.from(Buffer.from("aabc8fe47a40f7d0", "hex")),
  pendingChange: Uint8Array.from(Buffer.from("e8b7b0c40fc37393", "hex")),
} as const;

// ---------------------------------------------------------------------------------------------
// Fetchers
// ---------------------------------------------------------------------------------------------

export async function fetchConfig(connection: Connection, commitment: Commitment = "confirmed"): Promise<ConfigAccount | null> {
  const info = await connection.getAccountInfo(configPda(), commitment);
  return info ? decodeConfig(info.data) : null;
}

export async function fetchCopier(connection: Connection, mint: PublicKey, commitment: Commitment = "confirmed"): Promise<CopierAccount | null> {
  const info = await connection.getAccountInfo(copierPda(mint), commitment);
  return info ? decodeCopier(info.data) : null;
}

export async function fetchPosition(
  connection: Connection,
  mint: PublicKey,
  tokenMint: PublicKey,
  commitment: Commitment = "confirmed",
): Promise<PositionAccount | null> {
  const info = await connection.getAccountInfo(positionPda(mint, tokenMint), commitment);
  return info ? decodePosition(info.data) : null;
}

/** Every copier on chain (address + decoded state). */
export async function fetchAllCopiers(
  connection: Connection,
  commitment: Commitment = "confirmed",
): Promise<{ address: PublicKey; account: CopierAccount }[]> {
  const raw = await connection.getProgramAccounts(COPIER_PROGRAM_ID, {
    commitment,
    filters: [{ memcmp: { offset: 0, bytes: utils.bytes.bs58.encode(COPIER_ACCOUNT_DISC.copier) } }],
  });
  return raw.map((r) => ({ address: r.pubkey, account: decodeCopier(r.account.data) }));
}

/** Open positions of one copier (Position.mint at offset 8). */
export async function fetchPositions(
  connection: Connection,
  mint: PublicKey,
  commitment: Commitment = "confirmed",
): Promise<{ address: PublicKey; account: PositionAccount }[]> {
  const raw = await connection.getProgramAccounts(COPIER_PROGRAM_ID, {
    commitment,
    filters: [
      { memcmp: { offset: 0, bytes: utils.bytes.bs58.encode(COPIER_ACCOUNT_DISC.position) } },
      { memcmp: { offset: 8, bytes: mint.toBase58() } },
    ],
  });
  return raw.map((r) => ({ address: r.pubkey, account: decodePosition(r.account.data) }));
}

/** The pending (proposed, not yet executed or cancelled) admin changes, oldest first. */
export async function fetchPendingChanges(
  connection: Connection,
  commitment: Commitment = "confirmed",
): Promise<{ address: PublicKey; account: PendingChangeAccount }[]> {
  const raw = await connection.getProgramAccounts(COPIER_PROGRAM_ID, {
    commitment,
    filters: [{ memcmp: { offset: 0, bytes: utils.bytes.bs58.encode(COPIER_ACCOUNT_DISC.pendingChange) } }],
  });
  return raw
    .map((r) => ({ address: r.pubkey, account: decodePendingChange(r.account.data) }))
    .sort((a, b) => (a.account.id < b.account.id ? -1 : a.account.id > b.account.id ? 1 : 0));
}

// ---------------------------------------------------------------------------------------------
// Equity
// ---------------------------------------------------------------------------------------------

/**
 * `Copier::free_sol` / `Copier::equity`: free SOL = vault lamports + wSOL − rent-exempt minimum −
 * buyback pool − pending the platform token share (floored at 0); equity = free SOL + open cost basis.
 */
export function copierEquity(p: {
  copier: Pick<CopierAccount, "buybackPool" | "platformPending" | "openCost">;
  vaultLamports: bigint;
  vaultWsol?: bigint;
  rentExempt: bigint;
}): { freeSol: bigint; equity: bigint } {
  const free = p.vaultLamports + (p.vaultWsol ?? 0n) - p.rentExempt - p.copier.buybackPool - p.copier.platformPending;
  const freeSol = free > 0n ? free : 0n;
  return { freeSol, equity: freeSol + p.copier.openCost };
}

// ---------------------------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------------------------

export interface CopierEventMap {
  CopierRegistered: { mint: string; launcher: string; kind: CopierKind; targets: string[]; traderBps: number; sharingConfig: string; ts: number };
  FeesSynced: { mint: string; lamports: bigint; total: bigint; ts: number };
  Deposited: { mint: string; from: string; lamports: bigint; ts: number };
  TraderVerified: { mint: string; target: string; verified: boolean; ts: number };
  CopierBuy: {
    mint: string;
    target: string;
    tokenMint: string;
    venue: VenueKind;
    solIn: bigint;
    tokensOut: bigint;
    targetBalance: bigint;
    signalLamports: bigint;
    equity: bigint;
    ts: number;
  };
  CopierSell: {
    mint: string;
    target: string;
    tokenMint: string;
    venue: VenueKind;
    tokensIn: bigint;
    solOut: bigint;
    costRemoved: bigint;
    pnl: bigint;
    realizedPnl: bigint;
    hwm: bigint;
    forced: boolean;
    ts: number;
  };
  ProfitSplit: { mint: string; excess: bigint; toBuyback: bigint; toPlatform: bigint; ts: number };
  BuybackBurned: { mint: string; solIn: bigint; tokensBurned: bigint; totalBurned: bigint; ts: number };
  PlatformBurned: { solIn: bigint; tokensBurned: bigint; ts: number };
  ParamsUpdated: {
    params: ProgramParams;
    admin: string;
    pendingAdmin: string;
    keeper: string;
    platformMint: string;
    descriptors: number;
    ts: number;
  };
  IndexTargetsSet: { mint: string; targets: string[] };
  ChangeProposed: { id: bigint; kind: ChangeKind; eta: number; expiresAt: number; ts: number };
  ChangeExecuted: { id: bigint; kind: ChangeKind; ts: number };
  ChangeCancelled: { id: bigint; kind: ChangeKind; ts: number };
  /** `keeper` = the keeper that was removed. */
  KeeperPaused: { keeper: string; ts: number };
  /** A queued change that can never execute anymore (a newer proposal, a keeper pause or an admin handover). */
  ChangeInvalidated: { id: bigint; kind: ChangeKind; reason: InvalidationReason; ts: number };
  /** A superseded or expired change closed by `discard_pending`. */
  ChangeDiscarded: { id: bigint; kind: ChangeKind; ts: number };
}

export type CopierEventName = keyof CopierEventMap;
export type CopierEvent = { [K in CopierEventName]: { name: K; data: CopierEventMap[K] } }[CopierEventName];

/** Integer fields kept as JS numbers (u8/u16 already are; timestamps `ts` / `eta` are narrowed from i64). */
function plain(value: unknown, key = ""): unknown {
  if (BN.isBN(value)) return key === "ts" || key === "eta" || key === "expiresAt" ? Number(value.toString()) : BigInt(value.toString());
  if (value instanceof PublicKey) return value.toBase58();
  if (Array.isArray(value)) return value.map((v) => plain(v));
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    // Anchor enum `{ variant: {} }` → "variant"
    if (entries.length === 1 && entries[0]![1] && typeof entries[0]![1] === "object" && Object.keys(entries[0]![1] as object).length === 0) {
      return entries[0]![0];
    }
    return Object.fromEntries(entries.map(([k, v]) => [k, plain(v, k)]));
  }
  return value;
}

let parser: EventParser | undefined;

/**
 * Copier events in `logs` (a transaction's `meta.logMessages`), in emission order. Only `Program data:`
 * lines inside the Copier program's invocations are decoded. Names are the program's (`CopierBuy`, …).
 */
export function parseCopierEvents(logs: string[]): CopierEvent[] {
  parser ??= new EventParser(COPIER_PROGRAM_ID, copierProgram().coder);
  const out: CopierEvent[] = [];
  for (const e of parser.parseLogs(logs)) {
    // The camel-cased IDL names events `copierBuy`; the contract uses the Rust names.
    const name = e.name.charAt(0).toUpperCase() + e.name.slice(1);
    out.push({ name, data: plain(e.data) } as CopierEvent);
  }
  return out;
}

/**
 * A human-readable message for a failed send / simulate: Anchor's `Error Message:` log, or the
 * Copier IDL message when the logs show the Copier program itself failing with a custom error
 * (pump's own codes overlap 6000+, so only Copier-attributed codes are mapped), else a short form.
 */
export function describeError(err: unknown): string {
  const fields = err && typeof err === "object" ? err : {};
  const logs = "logs" in fields && Array.isArray(fields.logs) ? fields.logs.map(String) : [];
  const msg = "message" in fields && typeof fields.message === "string" ? fields.message : String(err);
  const all = [msg, ...logs].join("\n");
  const anchorMsg = /Error Message: ([^\n]+?)\.?$/m.exec(all);
  if (anchorMsg) return anchorMsg[1]!;
  // The innermost failure is logged first; a CPI'd pump error then re-surfaces on Copier's line too.
  const firstFail = /Program (\w+) failed: (.+)/.exec(all);
  if (firstFail) {
    const custom = /custom program error: 0x([0-9a-f]+)/i.exec(firstFail[2]!);
    if (firstFail[1] === COPIER_PROGRAM_ID.toBase58() && custom) {
      const e = COPIER_IDL.errors.find((x) => x.code === parseInt(custom[1]!, 16));
      if (e) return e.msg;
    }
    const program = firstFail[1] === PUMP_PROGRAM_ID.toBase58() ? "pump" : firstFail[1] === PUMP_AMM_PROGRAM_ID.toBase58() ? "PumpSwap" : `${firstFail[1]!.slice(0, 4)}…`;
    return `${program} failed: ${firstFail[2]}`;
  }
  if (/User rejected/i.test(msg)) return "Transaction rejected in wallet";
  if (/insufficient (funds|lamports)|InsufficientFundsForFee/i.test(all)) return "Insufficient SOL balance";
  return msg.length > 160 ? `${msg.slice(0, 160)}…` : msg;
}
