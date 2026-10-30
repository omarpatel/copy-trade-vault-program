/**
 * Indexer HTTP/WS contract (`apps/indexer`, documented route by route in `apps/indexer/API.md`).
 *
 * Conventions:
 * - Lamport amounts and raw token amounts (u64/i64) are decimal strings (`LamportStr`, `TokenStr`); signed values
 *   carry a leading `-`.
 * - Timestamps are unix seconds unless the field name ends in `Ms` (milliseconds).
 * - Prices are `number`s in lamports per whole token (10^decimals base units; pump coins have 6 decimals).
 * - Basis points are integers (10000 = 100%); `…Bps` ratios can be negative (losses).
 */

export type LamportStr = string;
export type TokenStr = string;

export type CopierKind = "single" | "index";
export type Venue = "curve" | "pool";
export type VenueOrUnsupported = Venue | "unsupported";

/** A target wallet as shown next to a copier (directory data when the wallet is a known KOL / top trader). */
export interface TraderRef {
  address: string;
  name: string | null;
  /** X handle without `@`. */
  handle: string | null;
  /** `https://x.com/<handle>`, null without a handle. */
  xUrl: string | null;
  /** Display name from the source profile when it differs from `name`. */
  displayName: string | null;
  /** The indexer's cached 128 px WebP of the wallet's profile picture (`/files/avatars/…`), null until cached. */
  avatar: string | null;
  /** Largest follower count a source reports (`followersOn` says which platform). */
  followers: number | null;
  followersOn: FollowerPlatform | null;
  /** Directory sources listing the wallet (empty outside the directory). */
  sources: DirectorySource[];
  /** The target signed `verify_trader` for this copier (always false where the context has no copier). */
  verified: boolean;
}

/** Off-chain metadata of a pump coin (its metadata JSON at `uri`; empty strings until the mint is read). */
export interface CoinInfo {
  name: string;
  symbol: string;
  uri: string;
  image: string | null;
  description: string | null;
  twitter: string | null;
  telegram: string | null;
  website: string | null;
}

/** The coin's live market, sampled from its bonding curve (or canonical PumpSwap pool after graduation) every 15s. */
export interface CoinMarket {
  /** null until the venue account was first read. */
  venue: Venue | null;
  graduated: boolean;
  /** Canonical PumpSwap pool once graduated. */
  pool: string | null;
  priceLamports: number | null;
  marketCapLamports: LamportStr | null;
  /** Live mint supply (base units): buyback burns lower it. */
  supply: TokenStr | null;
  decimals: number;
  /** Bonding-curve progress toward graduation (10000 once graduated); null when unknown. */
  curveProgressBps: number | null;
  /** Price change against the sample closest to 24h ago; null without history. */
  change24hBps: number | null;
  /** Unix seconds of the sample. */
  updatedAt: number | null;
}

export interface CopierSummary {
  mint: string;
  kind: CopierKind;
  launcher: string;
  vault: string;
  /** Targets in program order (index i ↔ `target_idx` i). */
  targets: TraderRef[];
  /** Target cut of creator fees (100–2500; 0 on index copiers). */
  traderBps: number;
  /** Bit i = targets[i] signed `verify_trader`. */
  verifiedMask: number;
  createdAt: number;
  /** This is the platform token index copier (`config.platform_mint`). */
  isPlatformToken: boolean;
  name: string;
  symbol: string;
  image: string | null;
  market: CoinMarket;

  /** Program equity: free SOL (lamports − rent − buyback pool) + wSOL + open cost basis. */
  equityLamports: LamportStr;
  /**
   * NAV: free SOL + wSOL + every open position at exit value (its venue's sell quote for the whole position after
   * price impact and venue fees; cost basis where unpriced). What the vault could realize now, not spot × tokens.
   */
  navLamports: LamportStr;
  freeLamports: LamportStr;
  openCostLamports: LamportStr;
  /** Σ positions at exit value (cost basis where unpriced). */
  positionsValueLamports: LamportStr;
  /** Σ (exit value − cost) over priced positions. */
  unrealizedLamports: LamportStr;
  feesInLamports: LamportStr;
  capitalInLamports: LamportStr;
  realizedPnlLamports: LamportStr;
  hwmLamports: LamportStr;
  /** realized + unrealized. */
  pnlLamports: LamportStr;
  /** pnl ÷ (feesIn + capitalIn) in bps; null while nothing came in. */
  pnlBps: number | null;
  buybackPoolLamports: LamportStr;
  buybackSpentLamports: LamportStr;
  /** Own-coin tokens bought back and burned. */
  burnedTokens: TokenStr;
  /** burnedTokens ÷ initial supply (1e9 tokens) in bps. */
  burnedBps: number;
  /** SOL sent to the platform token burn pool (the 25% profit share). */
  platformSentLamports: LamportStr;
  /** Fee share paid to the target(s) by pump's `distribute_creator_fees_v2`. */
  targetEarnedLamports: LamportStr;
  trades: number;
  openPositions: number;
  copies24h: number;
  skipped24h: number;
  /** Median copy lag over the last 50 copies (vault block time − target block time). */
  lagP50Ms: number | null;
  lastCopyAt: number | null;
  /** NAV over the last 7 days, ≤ 48 evenly spaced points (oldest first), lamports as numbers for charting. */
  spark: number[];
  /** Creator-fee routing re-verified against chain (every refresh): pump.fun's admin can rewrite it (CTO). */
  feeRouting: FeeRouting;
}

export type FeeRoutingStatus = "intact" | "changed" | "unknown";

/**
 * `register_copier`'s fee-routing checks re-run on current chain state: the canonical sharing config is v2, Active,
 * admin-revoked and holds exactly the registered split (single: [target X, vault 10000−X]; index: [vault 10000]); the
 * bonding curve creator and (after graduation) the pool's coin_creator are the sharing config.
 * "unknown": not verified yet or the accounts could not be read.
 */
export interface FeeRouting {
  status: FeeRoutingStatus;
  /** Unix seconds of the last successful verification (0 = never). */
  checkedAt: number;
  /** What differs from the registered routing ("; "-separated), null when intact / unknown. */
  detail: string | null;
  /** Shareholders the sharing config holds now (empty when unreadable). */
  shareholders: { address: string; bps: number }[];
}

/** `Config.params` (admin-set within the program's hard caps). */
export interface ParamsSnapshot {
  maxTradeBps: number;
  maxPositionBps: number;
  maxOpenPositions: number;
  minTradeLamports: LamportStr;
  minSignalLamports: LamportStr;
  signalMultipleBps: number;
  maxImpactBps: number;
  slippageBps: number;
  vaultFloorLamports: LamportStr;
  maxHoldSecs: number;
  keeperGraceSecs: number;
  /** Length of a copier's buy spend window. */
  spendWindowSecs: number;
  /** Max lamports `copier_buy` may spend per window, in bps of equity at the window's start. */
  maxWindowSpendBps: number;
}

export interface CopierTarget extends TraderRef {
  index: number;
  openPositions: number;
  realizedPnlLamports: LamportStr;
  copies: number;
  skipped: number;
  lastTradeAt: number | null;
}

export interface FeeBreakdown {
  /** Total creator fees distributed by pump (vault + targets). */
  distributedLamports: LamportStr;
  toVaultLamports: LamportStr;
  toTargetsLamports: LamportStr;
  /** Program-booked fee income (`fees_in`, includes any SOL sent straight to the vault). */
  feesInLamports: LamportStr;
  distributions: number;
  lastDistributedAt: number | null;
}

export interface CopierDetail extends Omit<CopierSummary, "targets"> {
  targets: CopierTarget[];
  sharingConfig: string;
  graduatedPool: string | null;
  lastKeeperTs: number | null;
  /** Current program-wide params and keeper (null until the config account was read). */
  params: ParamsSnapshot | null;
  keeper: string | null;
  coin: CoinInfo;
  fees: FeeBreakdown;
  /** Vault wSOL balance. */
  wsolLamports: LamportStr;
  /** the platform token burn pool lamports above its rent, waiting to buy + burn the platform token (same for every copier; null until read). */
  burnPoolLamports: LamportStr | null;
  /** hwm − realized PnL (> 0: losses to win back before profits split again). */
  hwmGapLamports: LamportStr;
  /** Realized PnL and HWM after every vault sell (oldest first). */
  pnlHistory: PnlPoint[];
  /** The per-window buy budget (`copier_buy` reverts with `SpendWindowExceeded` above it). */
  spendWindow: SpendWindow;
}

/**
 * A copier's current buy spend window: `spent ≤ max_window_spend_bps × equity at the window start`. A new window starts
 * on the first buy at least `spend_window_secs` after `startedAt` (equity re-based then).
 */
export interface SpendWindow {
  /** Unix seconds of the window start (0 before the first buy). */
  startedAt: number;
  /** Unix seconds from which the next buy opens a fresh window (null until params were read). */
  resetsAt: number | null;
  spentLamports: LamportStr;
  /** Equity the cap is computed from. */
  equityLamports: LamportStr;
  /** `equity × max_window_spend_bps`; null until params were read. */
  capLamports: LamportStr | null;
  /** cap − spent (≥ 0); null until params were read. */
  remainingLamports: LamportStr | null;
}

/** [unix seconds, realized PnL lamports, HWM lamports] after a `CopierSell`. */
export type PnlPoint = [number, LamportStr, LamportStr];

export interface CoinRef {
  mint: string;
  name: string | null;
  symbol: string | null;
  image: string | null;
}

export interface Position {
  copier: string;
  tokenMint: string;
  coin: CoinRef;
  /** Target whose trade opened it (null when the opening copy is not indexed). */
  target: string | null;
  venue: VenueOrUnsupported;
  tokens: TokenStr;
  decimals: number;
  costLamports: LamportStr;
  openedAt: number;
  /** Signature of the vault `copier_buy` that opened the position. */
  firstCopySig: string | null;
  targetSnapshot: TokenStr;
  targetPeak: TokenStr;
  vaultPeak: TokenStr;
  /** Spot price (display: the position is valued at its exit quote, see `valueLamports`). */
  markPriceLamports: number | null;
  /** Exit value: the venue's sell quote for all `tokens` after price impact and lp / protocol / creator fees. */
  valueLamports: LamportStr | null;
  /** tokens × spot price, before impact and fees (always ≥ `valueLamports`). */
  spotValueLamports: LamportStr | null;
  /** valueLamports − cost. */
  unrealizedLamports: LamportStr | null;
  unrealizedBps: number | null;
  /** valueLamports (cost basis when unpriced) ÷ copier NAV in bps. */
  pctOfEquityBps: number | null;
  /** PnL already realized by partial sells of this position. */
  realizedLamports: LamportStr;
  buys: number;
  sells: number;
  lastTradeAt: number | null;
  /** From here on the position can be force-sold (`opened_at + max_hold_secs`). */
  maxHoldAt: number | null;
}

/** A vault `copier_buy` / `copier_sell` decoded from the program's `CopierBuy` / `CopierSell` events. */
export interface VaultTrade {
  copier: string;
  signature: string;
  slot: number;
  ts: number;
  side: "buy" | "sell";
  target: string;
  tokenMint: string;
  coin: CoinRef;
  venue: Venue;
  /** buy: `sol_in`; sell: `sol_out`. */
  solLamports: LamportStr;
  /** buy: `tokens_out`; sell: `tokens_in`. */
  tokens: TokenStr;
  costRemovedLamports: LamportStr | null;
  pnlLamports: LamportStr | null;
  realizedPnlLamports: LamportStr | null;
  hwmLamports: LamportStr | null;
  forced: boolean;
  equityLamports: LamportStr | null;
  signalLamports: LamportStr | null;
  targetBalance: TokenStr | null;
  /** The target trade it answers (the tx's SPL memo `copier:<sig>`). */
  targetSignature: string | null;
}

export type TargetTradeSide = "buy" | "sell" | "transfer_in" | "transfer_out" | "airdrop";
export type CopyStatus = "copied" | "skipped" | "failed";
export type SkipReason =
  | "not_signer"
  | "not_a_trade"
  | "unsupported_venue"
  | "signal_below_min"
  | "trade_cap"
  | "position_cap"
  | "impact_cap"
  | "max_positions"
  | "below_min_trade"
  | "vault_floor"
  | "own_mint"
  | "target_is_creator"
  | "token_dead"
  | "no_position"
  | "nothing_to_sell"
  | "non_sol_quote"
  | "mayhem"
  | "migrating"
  | "keeper_not_authorized"
  | "simulation_failed"
  | "send_failed"
  | "reentry_cooldown"
  | "held_by_other_target"
  | "stale_signal"
  | "paused"
  | "spend_window";

/** One observed target trade and the keeper's decision, as POSTed to `/internal/target-trades`. */
export interface TargetTradeIngest {
  /** Copier mint. */
  copier: string;
  target: string;
  /** Target tx signature. */
  signature: string;
  slot: number;
  /** Unix seconds of the target tx. */
  blockTime: number | null;
  side: TargetTradeSide;
  tokenMint: string;
  /** Raw base units, signed (target perspective). */
  tokenDelta: string;
  /** Lamports, signed (target perspective; tx fee excluded, wSOL folded). */
  solDelta: string;
  targetSolBefore: string;
  /** |solDelta| ÷ |tokenDelta| (lamports per raw unit). */
  priceLamportsPerToken: number | null;
  venue: VenueOrUnsupported | null;
  status: CopyStatus;
  /** Set when skipped/failed. */
  reason: SkipReason | null;
  /** Failure detail (simulation/send error) when failed. */
  error: string | null;
  /** The keeper's copier_buy/copier_sell signature when copied. */
  vaultSignature: string | null;
  /** Lamports planned/spent (buy). */
  vaultSolIn: string | null;
  /** Tokens sold (sell). */
  vaultTokensIn: string | null;
  /** Unix ms the keeper saw the trade. */
  detectedAt: number;
  /** Unix ms the decision was made. */
  decidedAt: number;
}

/** `POST /internal/target-trades` body (1..50 trades; upsert on (copier, signature, tokenMint): one row per token leg). */
export interface TargetTradesIngestBody {
  trades: TargetTradeIngest[];
}

export interface TargetTradesIngestResponse {
  accepted: number;
}

/** A stored target trade (keeper report). */
export interface TargetTrade {
  copier: string;
  target: string;
  signature: string;
  slot: number;
  blockTime: number | null;
  side: TargetTradeSide;
  tokenMint: string;
  coin: CoinRef;
  tokenDelta: string;
  solDelta: string;
  targetSolBefore: string;
  priceLamportsPerToken: number | null;
  venue: VenueOrUnsupported | null;
  status: CopyStatus;
  reason: SkipReason | null;
  error: string | null;
  vaultSignature: string | null;
  /** Unix ms; null on rows rebuilt from the vault tx memo (no keeper report). */
  detectedAt: number | null;
  decidedAt: number | null;
  /** "keeper": reported by the keeper; "memo": rebuilt from a vault tx memo and the target tx. */
  source: "keeper" | "memo";
}

/**
 * Target trade ↔ vault trade. `pending`: the keeper reported a copy whose vault tx is not indexed yet.
 * Copies whose keeper report was lost are rebuilt from the vault tx memo (target fields from the target tx itself).
 */
export interface Copy {
  /**
   * `<copier>:<target tx signature>:<tokenMint>` — unique per copier and token leg (one target tx can touch several
   * mints, and one target trade can be copied by several copiers).
   */
  id: string;
  copier: string;
  copierSymbol: string;
  /** Unix seconds: target block time (vault block time when unknown). */
  ts: number;
  target: TraderRef;
  targetSig: string;
  targetTs: number | null;
  targetSlot: number | null;
  side: TargetTradeSide;
  tokenMint: string;
  coin: CoinRef;
  /** |solDelta| of the target (lamports). */
  targetSolLamports: LamportStr | null;
  /** |tokenDelta| of the target. */
  targetTokens: TokenStr | null;
  status: CopyStatus | "pending";
  reason: SkipReason | null;
  error: string | null;
  vaultSig: string | null;
  vaultTs: number | null;
  vaultSlot: number | null;
  vaultSolLamports: LamportStr | null;
  vaultTokens: TokenStr | null;
  pnlLamports: LamportStr | null;
  forced: boolean;
  /** (vaultTs − targetTs) × 1000: block times have 1s resolution. */
  lagMs: number | null;
  lagSlots: number | null;
  /** vault SOL ÷ target SOL in bps. */
  sizeBps: number | null;
}

export type BurnKind = "coin" | "platform";

/** `BuybackBurned` (75% share: the copier's own coin) or `PlatformBurned` (25% share: the platform token). */
export interface Burn {
  kind: BurnKind;
  signature: string;
  slot: number;
  ts: number;
  /** The copier whose coin was burned (coin burns) / the platform token mint (copier burns, null while unset). */
  copier: string | null;
  /** Burned mint. */
  mint: string;
  symbol: string | null;
  image: string | null;
  solLamports: LamportStr;
  tokens: TokenStr;
  /** Cumulative own-coin burn of the copier after this burn (coin burns). */
  totalBurned: TokenStr | null;
}

export type FeeEventKind = "distribution" | "sync" | "deposit";

/** Fee flow: pump distribution (vault + target shares), program fee booking (`FeesSynced`) or a capital deposit. */
export interface FeeEvent {
  kind: FeeEventKind;
  copier: string;
  symbol: string | null;
  signature: string;
  slot: number;
  ts: number;
  /** distribution: total distributed; sync: lamports booked; deposit: lamports deposited. */
  lamports: LamportStr;
  toVaultLamports: LamportStr | null;
  toTargetsLamports: LamportStr | null;
  /** sync: cumulative fees_in after; deposit: depositor; distribution: null. */
  totalFeesInLamports: LamportStr | null;
  from: string | null;
}

/** HWM excess split on a profitable sell (`ProfitSplit`). */
export interface ProfitEvent {
  copier: string;
  symbol: string | null;
  signature: string;
  slot: number;
  ts: number;
  excessLamports: LamportStr;
  toBuybackLamports: LamportStr;
  toPlatformLamports: LamportStr;
}

export type FeedItem =
  | { type: "copy"; id: string; ts: number; mint: string; data: Copy }
  | { type: "burn"; id: string; ts: number; mint: string; data: Burn }
  | { type: "launch"; id: string; ts: number; mint: string; data: CopierSummary }
  | { type: "fees"; id: string; ts: number; mint: string; data: FeeEvent }
  | { type: "profit"; id: string; ts: number; mint: string; data: ProfitEvent };

export interface Stats {
  copiers: number;
  /** Σ copier NAV. */
  tvlLamports: LamportStr;
  /** Σ creator fees routed: vault fees_in + target distributions. */
  feesLamports: LamportStr;
  /** Σ SOL spent on own-coin buyback burns. */
  burnedValueLamports: LamportStr;
  /** Σ SOL spent on the platform token burns. */
  platformBurnLamports: LamportStr;
  copies24h: number;
  skipped24h: number;
  /** Mean copy lag over the last 24h (null without copies). */
  avgLagMs: number | null;
  realizedPnlLamports: LamportStr;
  targetsEarnedLamports: LamportStr;
  trackedTraders: number;
  /** Copiers whose fee routing no longer matches registration (`feeRouting.status == "changed"`). */
  feeRoutingAlerts: number;
  /** Last keeper liveness proof on chain (`config.keeper_heartbeat_ts`; null until the config was read). */
  keeperHeartbeatTs: number | null;
  /** Admin changes wait this long between proposal and execution (null until the config was read). */
  timelockSecs: number | null;
  /** Admin changes that can still take effect (status `queued` or `executable`). */
  pendingChanges: number;
  updatedAt: number;
}

/** Where a directory wallet comes from: public leaderboards, copy-vault's curated research notes, localnet test seeds. */
export type DirectorySource = "kolscan" | "pump" | "gmgn" | "kolexplorer" | "fomo" | "curated" | "localnet";
export type FollowerPlatform = "x" | "pump" | "fomo";

/** Trading stats a source reports (USD; win rates 0–1; trades = closed positions / swaps per window). */
export interface TraderStats {
  pnl1dUsd: number | null;
  pnl7dUsd: number | null;
  pnl30dUsd: number | null;
  winRate7d: number | null;
  winRate30d: number | null;
  trades7d: number | null;
  trades30d: number | null;
  avgHoldSecs: number | null;
  /** Last time a source saw the wallet trade (unix seconds). */
  lastActiveTs: number | null;
}

/** One source's view of a wallet. */
export interface DirectorySourceStat {
  source: DirectorySource;
  /** 1-based rank on the source's main board (kolscan monthly, pump.fun monthly PnL, GMGN 30d …). */
  rank: number | null;
  /** The wallet's page on the source. */
  url: string | null;
  name: string | null;
  handle: string | null;
  followers: number | null;
  stats: TraderStats;
  tags: string[];
  notes: string | null;
  fetchedAt: number | null;
  /** False for profile-only enrichment (e.g. the wallet's pump.fun profile when pump's boards don't list it). */
  listed: boolean;
}

export type DirectorySort = "score" | "pnl30d" | "pnl7d" | "pnl1d" | "winrate" | "followers" | "copiers" | "rank";

/** A directory wallet: identity merged across sources, merged stats and the copyability score. */
export interface DirectoryEntry extends Omit<TraderRef, "verified" | "name"> {
  /** Directory name (source name, else `@handle`, else short address). */
  name: string;
  /** Wallets of one person share it (lower-cased X handle; the address when there's no handle). */
  personId: string;
  /** Wallets in the directory with the same `personId` (≥ 1). */
  walletCount: number;
  /** Best value per field across sources (kolscan > pump > gmgn > kolexplorer > fomo). */
  stats: TraderStats;
  /** Closed trades per day over the longest window with data. */
  tradesPerDay: number | null;
  /** Copyability 0–100 (hold time, trade frequency, PnL consistency, win rate, recency); null without trade data. */
  score: number | null;
  /** Plain-language reasons behind the score, strongest first. */
  scoreNotes: string[];
  /** Best rank across sources. */
  rank: { source: DirectorySource; rank: number } | null;
  /** e.g. "hft" (poor copy target), "low-frequency", "inactive", "caller", "multi-wallet". */
  tags: string[];
  notes: string | null;
  copiersCount: number;
  earnedLamports: LamportStr;
}

/** `GET /api/traders` page. `facets` count the whole filtered set before `source`/`tag` filters narrow it. */
export interface DirectoryPage {
  items: DirectoryEntry[];
  total: number;
  offset: number;
  limit: number;
  facets: { sources: Partial<Record<DirectorySource, number>>; tags: Record<string, number> };
  totals: { wallets: number; persons: number };
  /** Last successful refresh per remote source (unix seconds). */
  refreshedAt: Partial<Record<DirectorySource, number>>;
}

/** Everyone's wallets grouped under one identity. */
export interface TraderPerson {
  id: string;
  name: string;
  handle: string | null;
  xUrl: string | null;
  displayName: string | null;
  avatar: string | null;
  /** 256 px variant of `avatar`. */
  avatarLarge: string | null;
  followers: number | null;
  followersOn: FollowerPlatform | null;
  wallets: DirectoryEntry[];
}

/** A target wallet: directory data, copiers tracking it, fee-share earnings and recent trades. */
export interface TraderProfile {
  address: string;
  entry: DirectoryEntry | null;
  /** The person behind the wallet with all their directory wallets (null outside the directory). */
  person: TraderPerson | null;
  /** Every source's view of this wallet. */
  sources: DirectorySourceStat[];
  copiers: CopierSummary[];
  /** Σ fee-share lamports received from distributions of every copier targeting it. */
  earnedLamports: LamportStr;
  earnings: { copier: string; symbol: string; lamports: LamportStr; distributions: number }[];
  /** Copiers where the wallet signed `verify_trader`. */
  verifiedOn: string[];
  /** Latest observed trades of the wallet with every copier's decision (newest first). */
  recentTrades: TargetTrade[];
  stats: { observed: number; copied: number; skipped: number; failed: number };
}

export interface PlatformTokenTarget extends TraderRef {
  index: number;
  /** Share of the vault's open cost basis in positions opened on this target's trades (equal split when flat). */
  weightBps: number;
  copies: number;
  pnlLamports: LamportStr;
  openPositions: number;
  lastTradeTs: number | null;
}

/** The platform token index copier. `mint`/`copier` are null until `set_platform_mint` is indexed. */
export interface PlatformTokenInfo {
  mint: string | null;
  copier: CopierDetail | null;
  targets: PlatformTokenTarget[];
  /** Capital deposited into the index vault (`Deposited`). */
  seedLamports: LamportStr;
  burnPool: string;
  /** Lamports above rent waiting to buy + burn the platform token (null until read). */
  burnPoolLamports: LamportStr | null;
  /** Σ the platform token tokens burned (by the burn pool and by the index's own buybacks). */
  totalBurnedTokens: TokenStr;
  platformBurnLamports: LamportStr;
  burns: Burn[];
}

/** [unix seconds, NAV lamports]: mark-to-market vault value sampled every 15s (bucketed per range). */
export type EquityPoint = [number, LamportStr];

/** 1-minute (or coarser, see `?interval=`) own-coin price candle, lamports per whole token. */
export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  /** Market cap at close (lamports). */
  mcap: LamportStr | null;
}

/** Copier program account + Config PDA presence on the indexed cluster. */
export interface ProgramState {
  deployed: boolean;
  configInitialized: boolean;
}

export interface Health {
  ok: boolean;
  slot: number | null;
  lastIndexedSlot: number;
  lagSlots: number | null;
  wsConnected: boolean;
  genesisHash: string | null;
  /**
   * Pre-launch (program not deployed / Config not initialized) is healthy: the indexer polls and picks both up.
   * null = not checked yet (before the first full refresh).
   */
  program: { id: string; deployed: boolean | null; configInitialized: boolean | null };
  error?: string;
}

export interface UploadResponse {
  uri: string;
  image: string;
}

export interface ApiError {
  error: string;
}

export type WsMessage =
  | { type: "copy"; data: Copy }
  | { type: "trade"; data: VaultTrade }
  | { type: "burn"; data: Burn }
  | { type: "launch"; data: CopierSummary }
  | { type: "fees"; data: FeeEvent }
  | { type: "stats"; data: Stats }
  /** A copier's summary changed (trade, fees, price sample, verification). */
  | { type: "copier"; data: CopierSummary }
  /** The indexer re-indexed after a chain reset: clients drop cached data and refetch. */
  | { type: "reset"; data: { genesisHash: string } }
  /** An admin change was proposed / executed / cancelled / invalidated / discarded, or the keeper was paused. */
  | { type: "governance"; data: Governance };

export type AdminChangeKind = "keeper" | "params" | "descriptors" | "indexTargets";

/**
 * Lifecycle of a timelocked admin change (program rules):
 * - `queued`: now < eta;
 * - `executable`: eta ≤ now ≤ expiresAt and it is its kind's live change (`config.latest_change_ids[kind] == id`);
 * - `superseded`: no longer its kind's live change (a newer proposal, `pause_keeper`, or an admin handover), or a
 *   `ChangeInvalidated` was seen; it can only be discarded;
 * - `expired`: now > expiresAt; it can only be discarded;
 * - `executed` / `cancelled` / `discarded`: closed (account gone).
 */
export type ChangeStatus = "queued" | "executable" | "superseded" | "expired" | "executed" | "cancelled" | "discarded";

export type InvalidationReason = "superseded" | "keeperPaused" | "adminChanged";

/** A timelocked admin change (`propose_*` → `execute_pending` within [eta, expiresAt], or cancel / discard). */
export interface AdminChange {
  id: number;
  kind: AdminChangeKind;
  status: ChangeStatus;
  proposer: string | null;
  proposedAt: number;
  /** Earliest `execute_pending` (unix s; anyone can execute from then on). */
  eta: number;
  /** Latest `execute_pending` (eta + 7 days); after it the change can only be discarded. Null when never seen. */
  expiresAt: number | null;
  /** Why the program invalidated it (`ChangeInvalidated`), null when it wasn't. */
  invalidation: { reason: InvalidationReason; ts: number } | null;
  /** Executed / cancelled / discarded at (unix s). */
  resolvedAt: number | null;
  proposeSig: string | null;
  resolveSig: string | null;
  /** The proposed payload (read from the PendingChange account while it exists; null when it was never read). */
  payload: AdminChangePayload | null;
  /** Human-readable differences from the current config (e.g. "maxTradeBps 1000 → 2500"). */
  summary: string[];
}

export type AdminChangePayload =
  | { kind: "keeper"; keeper: string }
  | { kind: "params"; params: ParamsSnapshot }
  | { kind: "descriptors"; descriptors: number }
  | { kind: "indexTargets"; copier: string; targets: string[] };

export interface KeeperPause {
  signature: string;
  ts: number;
  /** The keeper that was removed. */
  keeper: string;
}

/** `GET /api/governance`: who can change what, and what is queued. */
export interface Governance {
  /** Null until the program config was read. */
  timelockSecs: number | null;
  admin: string | null;
  /** Proposed admin handover (`propose_admin`), null when none. */
  pendingAdmin: string | null;
  pendingAdminEta: number | null;
  /** Current keeper; null while paused (`Pubkey::default`). */
  keeper: string | null;
  keeperPaused: boolean;
  keeperHeartbeatTs: number | null;
  keeperGraceSecs: number | null;
  /** now − heartbeat > grace: exits are permissionless (target balance 0) until the keeper is back. */
  keeperStale: boolean;
  /** Open changes (queued, executable, superseded, expired), soonest ETA first. */
  pending: AdminChange[];
  /** Closed changes (executed, cancelled, discarded), newest first (≤ 50). */
  history: AdminChange[];
  /** `pause_keeper` calls, newest first (≤ 50). */
  keeperPauses: KeeperPause[];
}
