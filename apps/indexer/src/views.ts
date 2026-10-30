import { burnPoolPda, CHANGE_KIND_INDEX, NO_CHANGE_ID, pendingChangeStatus, PUMP_TOKEN_TOTAL_SUPPLY } from "@copy-trade-vault/sdk";
import type {
  Burn,
  Candle,
  CoinRef,
  Copy,
  CopyStatus,
  DirectoryEntry,
  DirectoryPage,
  EquityPoint,
  AdminChange,
  AdminChangePayload,
  ChangeStatus,
  FeedItem,
  Governance,
  SpendWindow,
  FeeEvent,
  CopierDetail,
  CopierSummary,
  CopierTarget,
  PlatformTokenInfo,
  ParamsSnapshot,
  Position,
  ProfitEvent,
  SkipReason,
  Stats,
  TargetTrade,
  TargetTradeSide,
  TraderProfile,
  TraderRef,
  VaultTrade,
  VenueOrUnsupported,
} from "@copy-trade-vault/sdk/api";
import {
  bucketLast,
  changeBps,
  copyLag,
  markPosition,
  mean,
  median,
  mergeCandles,
  RANGES,
  ratioBps,
  sparkline,
  targetWeights,
  type RangeKey,
} from "./aggregate";
import type {
  AdminChangeRow,
  BurnRow,
  CopyRow,
  DepositRow,
  DistributionRow,
  FeeSyncRow,
  CopierAggRow,
  CopierRow,
  PositionRow,
  ProfitSplitRow,
  Store,
  TargetTradeRow,
  TradeRow,
} from "./db";
import type { Directory, DirectoryQuery } from "./directory";
import type { MergedWallet } from "./directory-merge";

/** Program `Config` as last read from chain (or from `ParamsUpdated`), persisted in `sync_state.config`. */
export interface ProgramConfig {
  admin: string;
  /** null while paused (`Pubkey::default()`, `pause_keeper`). */
  keeper: string | null;
  /** null while `Pubkey::default()`. */
  platformMint: string | null;
  params: ParamsSnapshot;
  platformBurned: string;
  platformBurnSpent: string;
  /** Fields only the Config account carries (null until it was read: `ParamsUpdated` doesn't have them). */
  timelockSecs: number | null;
  pendingAdmin: string | null;
  pendingAdminEta: number | null;
  keeperHeartbeatTs: number | null;
  /**
   * `config.latest_change_ids` by kind (keeper, params, descriptors, indexTargets): each kind's only executable change
   * id, null = none live. Null until the Config account was read.
   */
  latestChangeIds: (number | null)[] | null;
}

export const CONFIG_KEY = "config";
export const BURN_POOL_KEY = "burn_pool_lamports";
const BURN_POOL = burnPoolPda().toBase58();

const SPARK_POINTS = 48;
const DAY = 86_400;
const LAG_SAMPLE = 50;
/** Summaries are rebuilt at most this often (list endpoints, WS fan-out); writes invalidate earlier. */
const CACHE_MS = 2_000;
/** Response caps: `pnlHistory` points and candles per response (the interval widens to fit). */
export const MAX_SERIES_POINTS = 500;
export const MAX_CANDLES = 1_500;
/** Supported candle intervals (seconds), ascending; `?interval=` must be one of them. */
export const CANDLE_INTERVALS = [60, 300, 900, 3_600, 14_400, 86_400] as const;

const abs = (s: string) => (s.startsWith("-") ? s.slice(1) : s);
const big = (s: string | null | undefined) => BigInt(s ?? "0");

export function readConfig(store: Store): ProgramConfig | null {
  const raw = store.getState(CONFIG_KEY);
  return raw ? (JSON.parse(raw) as ProgramConfig) : null;
}

/**
 * Builds every API object from SQLite rows. One instance per process; `invalidate()` after writes drops the
 * summary cache (otherwise ≤ 2s stale).
 */
export class Views {
  private cache: { at: number; generation: number; summaries: CopierSummary[]; byMint: Map<string, CopierSummary> } | null = null;

  constructor(
    private readonly store: Store,
    private readonly directory: Directory,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  invalidate(): void {
    this.cache = null;
  }

  config(): ProgramConfig | null {
    return readConfig(this.store);
  }

  traderRef(address: string, verified: boolean): TraderRef {
    const k = this.directory.get(address);
    return {
      address,
      name: k?.name ?? null,
      handle: k?.handle ?? null,
      xUrl: k?.handle ? `https://x.com/${k.handle}` : null,
      displayName: k?.displayName ?? null,
      avatar: k ? this.directory.avatars.url(k, 128) : null,
      followers: k?.followers ?? null,
      followersOn: k?.followersOn ?? null,
      sources: k?.sources ?? [],
      verified,
    };
  }

  coinRef(mint: string): CoinRef {
    const m = this.store.copier(mint);
    if (m) return { mint, name: m.name || null, symbol: m.symbol || null, image: m.image };
    const t = this.store.token(mint);
    return { mint, name: t?.name ?? null, symbol: t?.symbol ?? null, image: t?.image ?? null };
  }

  // ---------------- copiers ----------------

  private targetsOf(row: CopierRow): string[] {
    return JSON.parse(row.targets) as string[];
  }

  private lagsOf(copier: string): number[] {
    return this.store
      .lags({ copier }, LAG_SAMPLE)
      .map((l) => copyLag({ blockTime: l.target_time, slot: l.target_slot }, { blockTime: l.vault_time ?? l.vault_ts, slot: l.vault_slot }).lagMs)
      .filter((v): v is number => v !== null);
  }

  private summaryOf(row: CopierRow, agg: CopierAggRow | undefined, platformMint: string | null): CopierSummary {
    const now = this.now();
    const realized = big(row.realized_pnl);
    const unrealized = big(row.unrealized);
    const pnl = realized + unrealized;
    const sparkFrom = now - 7 * DAY;
    return {
      mint: row.mint,
      kind: row.kind,
      launcher: row.launcher,
      vault: row.vault,
      targets: this.targetsOf(row).map((a, i) => this.traderRef(a, (row.verified & (1 << i)) !== 0)),
      traderBps: row.trader_bps,
      verifiedMask: row.verified,
      createdAt: row.created_at,
      isPlatformToken: platformMint === row.mint,
      name: row.name,
      symbol: row.symbol,
      image: row.image,
      market: {
        venue: row.venue,
        graduated: row.venue === "pool" || row.graduated_pool !== null,
        pool: row.pool ?? row.graduated_pool,
        priceLamports: row.price,
        marketCapLamports: row.mcap,
        supply: row.supply,
        decimals: row.decimals,
        curveProgressBps: row.curve_progress,
        change24hBps: changeBps(row.price, this.store.priceNear(row.mint, now - DAY)),
        updatedAt: row.market_at,
      },
      equityLamports: row.equity,
      navLamports: row.nav,
      freeLamports: row.free,
      openCostLamports: row.open_cost,
      positionsValueLamports: row.positions_value,
      unrealizedLamports: row.unrealized,
      feesInLamports: row.fees_in,
      capitalInLamports: row.capital_in,
      realizedPnlLamports: row.realized_pnl,
      hwmLamports: row.hwm,
      pnlLamports: pnl.toString(),
      pnlBps: ratioBps(pnl, big(row.fees_in) + big(row.capital_in)),
      buybackPoolLamports: row.buyback_pool,
      buybackSpentLamports: row.buyback_spent,
      burnedTokens: row.burned,
      burnedBps: ratioBps(big(row.burned), PUMP_TOKEN_TOTAL_SUPPLY) ?? 0,
      platformSentLamports: row.platform_sent,
      targetEarnedLamports: agg?.to_targets ?? "0",
      trades: row.trades,
      openPositions: row.open_positions,
      copies24h: agg?.copies24h ?? 0,
      skipped24h: agg?.skipped24h ?? 0,
      lagP50Ms: median(this.lagsOf(row.mint)),
      lastCopyAt: agg?.last_copy_at ?? null,
      spark: sparkline(this.store.sparkPoints(row.mint, sparkFrom, (7 * DAY) / SPARK_POINTS), sparkFrom, now, SPARK_POINTS),
      feeRouting: {
        status: row.fee_status,
        checkedAt: row.fee_checked_at,
        detail: row.fee_detail,
        shareholders: JSON.parse(row.fee_shareholders) as { address: string; bps: number }[],
      },
    };
  }

  summaries(): CopierSummary[] {
    const nowMs = Date.now();
    if (this.cache && this.cache.generation === this.store.generation && nowMs - this.cache.at < CACHE_MS) return this.cache.summaries;
    const aggs = this.store.copierAggs(this.now() - DAY);
    const platformMint = this.config()?.platformMint ?? null;
    const summaries = this.store.copiers().map((r) => this.summaryOf(r, aggs.get(r.mint), platformMint));
    this.cache = { at: nowMs, generation: this.store.generation, summaries, byMint: new Map(summaries.map((s) => [s.mint, s])) };
    return summaries;
  }

  summary(mint: string): CopierSummary | null {
    this.summaries();
    return this.cache?.byMint.get(mint) ?? null;
  }

  /** `GET /api/copiers` ordering + filters. */
  list(opts: { sort: "pnl" | "tvl" | "new" | "fees"; kind: "single" | "index" | null; q: string | null }): CopierSummary[] {
    let list = this.summaries();
    if (opts.kind) list = list.filter((m) => m.kind === opts.kind);
    if (opts.q) {
      const q = opts.q.trim().replace(/^[$@]/, "").toLowerCase();
      list = list.filter(
        (m) =>
          m.name.toLowerCase().includes(q) ||
          m.symbol.toLowerCase().includes(q) ||
          m.mint.toLowerCase().startsWith(q) ||
          m.targets.some((t) => t.address.toLowerCase().startsWith(q) || t.name?.toLowerCase().includes(q) || t.handle?.toLowerCase().includes(q)),
      );
    }
    const cmp = (a: bigint, b: bigint) => (a === b ? 0 : a > b ? -1 : 1);
    const key: Record<typeof opts.sort, (m: CopierSummary) => bigint> = {
      pnl: (m) => BigInt(m.pnlLamports),
      tvl: (m) => BigInt(m.navLamports),
      new: (m) => BigInt(m.createdAt),
      fees: (m) => BigInt(m.feesInLamports) + BigInt(m.targetEarnedLamports),
    };
    return [...list].sort((a, b) => cmp(key[opts.sort](a), key[opts.sort](b)) || b.createdAt - a.createdAt);
  }

  detail(mint: string): CopierDetail | null {
    const row = this.store.copier(mint);
    const summary = this.summary(mint);
    if (!row || !summary) return null;
    const cfg = this.config();
    const aggs = this.store.copierAggs(this.now() - DAY).get(mint);
    const positions = this.store.positions(mint);
    const stats = new Map(this.store.targetTradeStats(mint).map((s) => [s.target, s]));
    const skipped = this.store.skippedByTarget(mint);
    const targets: CopierTarget[] = summary.targets.map((t, index) => ({
      ...t,
      index,
      openPositions: positions.filter((p) => p.target === t.address).length,
      realizedPnlLamports: stats.get(t.address)?.realized ?? "0",
      copies: stats.get(t.address)?.copies ?? 0,
      skipped: skipped.get(t.address) ?? 0,
      lastTradeAt: stats.get(t.address)?.last_ts ?? null,
    }));
    return {
      ...summary,
      targets,
      sharingConfig: row.sharing_config,
      graduatedPool: row.graduated_pool,
      lastKeeperTs: row.last_keeper_ts || null,
      params: cfg?.params ?? null,
      keeper: cfg?.keeper ?? null,
      coin: {
        name: row.name,
        symbol: row.symbol,
        uri: row.uri,
        image: row.image,
        description: row.description,
        twitter: row.twitter,
        telegram: row.telegram,
        website: row.website,
      },
      fees: {
        distributedLamports: aggs?.distributed ?? "0",
        toVaultLamports: aggs?.to_vault ?? "0",
        toTargetsLamports: aggs?.to_targets ?? "0",
        feesInLamports: row.fees_in,
        distributions: aggs?.distributions ?? 0,
        lastDistributedAt: aggs?.last_distributed_at ?? null,
      },
      wsolLamports: row.wsol,
      burnPoolLamports: this.store.getState(BURN_POOL_KEY),
      hwmGapLamports: (big(row.hwm) - big(row.realized_pnl)).toString(),
      pnlHistory: this.store.pnlHistory(mint, MAX_SERIES_POINTS),
      spendWindow: spendWindowOf(row, cfg?.params ?? null),
    };
  }

  positionView(p: PositionRow, nav: bigint, maxHoldSecs: number | null): Position {
    const first = this.store.firstBuy(p.copier, p.token_mint, p.opened_at);
    const pt = this.store.positionTrades(p.copier, p.token_mint, p.opened_at);
    const mark = markPosition(big(p.cost), p.value === null ? null : BigInt(p.value), nav);
    return {
      copier: p.copier,
      tokenMint: p.token_mint,
      coin: this.coinRef(p.token_mint),
      target: p.target,
      venue: (p.venue ?? first?.venue ?? "unsupported") as VenueOrUnsupported,
      tokens: p.tokens,
      decimals: this.store.token(p.token_mint)?.decimals ?? 6,
      costLamports: p.cost,
      openedAt: p.opened_at,
      firstCopySig: first?.signature ?? null,
      targetSnapshot: p.target_snapshot,
      targetPeak: p.target_peak,
      vaultPeak: p.vault_peak,
      markPriceLamports: p.mark_price,
      valueLamports: mark.value?.toString() ?? null,
      spotValueLamports: p.spot_value,
      unrealizedLamports: mark.unrealized?.toString() ?? null,
      unrealizedBps: mark.unrealizedBps,
      pctOfEquityBps: mark.pctOfEquityBps,
      realizedLamports: pt.realized,
      buys: pt.buys,
      sells: pt.sells,
      lastTradeAt: p.last_trade_ts || pt.last_ts,
      maxHoldAt: maxHoldSecs === null ? null : p.opened_at + maxHoldSecs,
    };
  }

  positions(mint: string): Position[] | null {
    const row = this.store.copier(mint);
    if (!row) return null;
    const maxHold = this.config()?.params.maxHoldSecs ?? null;
    return this.store.positions(mint).map((p) => this.positionView(p, big(row.nav), maxHold));
  }

  // ---------------- trades / copies ----------------

  vaultTrade(t: TradeRow): VaultTrade {
    return {
      copier: t.copier,
      signature: t.signature,
      slot: t.slot,
      ts: this.store.txBlockTime(t.signature) ?? t.ts,
      side: t.side,
      target: t.target,
      tokenMint: t.token_mint,
      coin: this.coinRef(t.token_mint),
      venue: t.venue,
      solLamports: t.sol,
      tokens: t.tokens,
      costRemovedLamports: t.cost_removed,
      pnlLamports: t.pnl,
      realizedPnlLamports: t.realized_pnl,
      hwmLamports: t.hwm,
      forced: t.forced === 1,
      equityLamports: t.equity,
      signalLamports: t.signal,
      targetBalance: t.target_balance,
      targetSignature: t.target_sig,
    };
  }

  trades(mint: string, limit: number): VaultTrade[] {
    return this.store.tradesOf(mint, limit).map((t) => this.vaultTrade(t));
  }

  targetTrade(r: TargetTradeRow): TargetTrade {
    return {
      copier: r.copier,
      target: r.target,
      signature: r.signature,
      slot: r.slot,
      blockTime: r.block_time,
      side: r.side as TargetTradeSide,
      tokenMint: r.token_mint,
      coin: this.coinRef(r.token_mint),
      tokenDelta: r.token_delta,
      solDelta: r.sol_delta,
      targetSolBefore: r.target_sol_before,
      priceLamportsPerToken: r.price,
      venue: r.venue as VenueOrUnsupported | null,
      status: r.status as CopyStatus,
      reason: r.reason as SkipReason | null,
      error: r.error,
      vaultSignature: r.vault_sig,
      detectedAt: r.detected_at,
      decidedAt: r.decided_at,
      source: r.source,
    };
  }

  copyView(r: CopyRow): Copy {
    const copier = this.store.copier(r.copier);
    const targets = copier ? this.targetsOf(copier) : [];
    const idx = targets.indexOf(r.target);
    const verified = copier !== undefined && idx >= 0 && (copier.verified & (1 << idx)) !== 0;
    const vaultTs = r.t_signature ? (r.t_block_time ?? r.t_ts) : null;
    const lag = r.t_signature ? copyLag({ blockTime: r.block_time, slot: r.slot }, { blockTime: vaultTs, slot: r.t_slot }) : { lagMs: null, lagSlots: null };
    const targetSol = r.sol_delta === "0" && r.token_delta === "0" ? null : abs(r.sol_delta);
    const vaultSol = r.t_sol ?? (r.side === "buy" ? r.vault_sol_in : null);
    const status: Copy["status"] = r.status === "copied" && !r.t_signature ? "pending" : (r.status as CopyStatus);
    return {
      id: `${r.copier}:${r.signature}:${r.token_mint}`,
      copier: r.copier,
      copierSymbol: copier?.symbol ?? "",
      ts: r.block_time ?? vaultTs ?? r.received_at,
      target: this.traderRef(r.target, verified),
      targetSig: r.signature,
      targetTs: r.block_time,
      targetSlot: r.slot,
      side: r.side as TargetTradeSide,
      tokenMint: r.token_mint,
      coin: this.coinRef(r.token_mint),
      targetSolLamports: targetSol,
      targetTokens: abs(r.token_delta),
      status,
      reason: r.reason as SkipReason | null,
      error: r.error,
      vaultSig: r.t_signature ?? r.vault_sig,
      vaultTs,
      vaultSlot: r.t_slot,
      vaultSolLamports: vaultSol,
      vaultTokens: r.t_tokens ?? r.vault_tokens_in,
      pnlLamports: r.t_pnl,
      forced: r.t_forced === 1,
      lagMs: lag.lagMs,
      lagSlots: lag.lagSlots,
      sizeBps: vaultSol !== null && targetSol !== null ? ratioBps(BigInt(vaultSol), BigInt(targetSol)) : null,
    };
  }

  copies(mint: string | null, limit: number): Copy[] {
    return this.store.copies(mint, limit).map((r) => this.copyView(r));
  }

  /** One leg (`tokenMint`) of a target tx as seen by `copier`. */
  copy(copier: string, signature: string, tokenMint: string): Copy | null {
    const r = this.store.copy(copier, signature, tokenMint);
    return r ? this.copyView(r) : null;
  }

  // ---------------- burns / fees / feed ----------------

  burnView(b: BurnRow): Burn {
    const coin = this.coinRef(b.mint);
    return {
      kind: b.kind,
      signature: b.signature,
      slot: b.slot,
      ts: b.ts,
      copier: b.copier,
      mint: b.mint,
      symbol: coin.symbol,
      image: coin.image,
      solLamports: b.sol_in,
      tokens: b.tokens,
      totalBurned: b.total_burned,
    };
  }

  burns(f: { copier?: string; kind?: "coin" | "platform"; limit: number }): Burn[] {
    return this.store.burns(f).map((b) => this.burnView(b));
  }

  private symbolOf(mint: string): string | null {
    return this.store.copier(mint)?.symbol || null;
  }

  distributionEvent(d: DistributionRow): FeeEvent {
    return {
      kind: "distribution",
      copier: d.copier,
      symbol: this.symbolOf(d.copier),
      signature: d.signature,
      slot: d.slot,
      ts: d.ts,
      lamports: d.distributed,
      toVaultLamports: d.to_vault,
      toTargetsLamports: d.to_targets,
      totalFeesInLamports: null,
      from: null,
    };
  }

  syncEvent(s: FeeSyncRow): FeeEvent {
    return {
      kind: "sync",
      copier: s.copier,
      symbol: this.symbolOf(s.copier),
      signature: s.signature,
      slot: s.slot,
      ts: s.ts,
      lamports: s.lamports,
      toVaultLamports: s.lamports,
      toTargetsLamports: null,
      totalFeesInLamports: s.total,
      from: null,
    };
  }

  depositEvent(d: DepositRow): FeeEvent {
    return {
      kind: "deposit",
      copier: d.copier,
      symbol: this.symbolOf(d.copier),
      signature: d.signature,
      slot: d.slot,
      ts: d.ts,
      lamports: d.lamports,
      toVaultLamports: d.lamports,
      toTargetsLamports: null,
      totalFeesInLamports: null,
      from: d.from_addr,
    };
  }

  profitEvent(p: ProfitSplitRow): ProfitEvent {
    return {
      copier: p.copier,
      symbol: this.symbolOf(p.copier),
      signature: p.signature,
      slot: p.slot,
      ts: p.ts,
      excessLamports: p.excess,
      toBuybackLamports: p.to_buyback,
      toPlatformLamports: p.to_platform,
    };
  }

  /**
   * Global (or one copier's) live feed, newest first. `FeesSynced` bookings only appear in a copier's own feed: they
   * re-book lamports a distribution already announced.
   */
  feed(opts: { mint: string | null; types: Set<FeedItem["type"]>; limit: number }): FeedItem[] {
    const { mint, types, limit } = opts;
    const items: FeedItem[] = [];
    if (types.has("copy")) {
      for (const c of this.copies(mint, limit)) items.push({ type: "copy", id: `copy:${c.id}`, ts: c.ts, mint: c.copier, data: c });
    }
    if (types.has("burn")) {
      for (const b of this.burns({ copier: mint ?? undefined, limit })) {
        items.push({ type: "burn", id: `burn:${b.signature}:${b.kind}`, ts: b.ts, mint: b.copier ?? b.mint, data: b });
      }
    }
    if (types.has("launch")) {
      for (const m of this.summaries()) {
        if (mint && m.mint !== mint) continue;
        items.push({ type: "launch", id: `launch:${m.mint}`, ts: m.createdAt, mint: m.mint, data: m });
      }
    }
    if (types.has("fees")) {
      const fees: FeeEvent[] = [
        ...this.store.distributions(mint, limit).map((d) => this.distributionEvent(d)),
        ...this.store.deposits(mint, limit).map((d) => this.depositEvent(d)),
        ...(mint ? this.store.feeSyncs(mint, limit).map((s) => this.syncEvent(s)) : []),
      ];
      for (const f of fees) items.push({ type: "fees", id: `fees:${f.kind}:${f.signature}:${f.copier}`, ts: f.ts, mint: f.copier, data: f });
    }
    if (types.has("profit")) {
      for (const p of this.store.profitSplits(mint, limit)) {
        items.push({ type: "profit", id: `profit:${p.signature}:${p.event_index}`, ts: p.ts, mint: p.copier, data: this.profitEvent(p) });
      }
    }
    return items.sort((a, b) => b.ts - a.ts || a.id.localeCompare(b.id)).slice(0, limit);
  }

  // ---------------- stats ----------------

  stats(): Stats {
    const summaries = this.summaries();
    const since = this.now() - DAY;
    let tvl = 0n;
    let fees = 0n;
    let realized = 0n;
    let earned = 0n;
    const traders = new Set<string>();
    for (const m of summaries) {
      tvl += BigInt(m.navLamports);
      fees += BigInt(m.feesInLamports) + BigInt(m.targetEarnedLamports);
      realized += BigInt(m.realizedPnlLamports);
      earned += BigInt(m.targetEarnedLamports);
      for (const t of m.targets) traders.add(t.address);
    }
    const burns = this.store.burnsTotals();
    const counts = this.store.statusCounts(since);
    const lags = this.store
      .lags({ since }, 1_000)
      .map((l) => copyLag({ blockTime: l.target_time, slot: l.target_slot }, { blockTime: l.vault_time ?? l.vault_ts, slot: l.vault_slot }).lagMs)
      .filter((v): v is number => v !== null);
    return {
      copiers: summaries.length,
      tvlLamports: tvl.toString(),
      feesLamports: fees.toString(),
      burnedValueLamports: burns.coin_sol,
      platformBurnLamports: burns.platform_sol,
      copies24h: counts.copied,
      skipped24h: counts.skipped,
      avgLagMs: mean(lags),
      realizedPnlLamports: realized.toString(),
      targetsEarnedLamports: earned.toString(),
      trackedTraders: traders.size,
      feeRoutingAlerts: summaries.filter((m) => m.feeRouting.status === "changed").length,
      keeperHeartbeatTs: this.config()?.keeperHeartbeatTs ?? null,
      timelockSecs: this.config()?.timelockSecs ?? null,
      pendingChanges: this.openChanges(this.config()).filter((c) => c.status === "queued" || c.status === "executable").length,
      updatedAt: this.now(),
    };
  }

  // ---------------- series ----------------

  equity(mint: string, range: RangeKey): EquityPoint[] {
    const now = this.now();
    const { secs, bucket } = RANGES[range];
    const from = secs === null ? 0 : now - secs;
    // 15s samples are kept for 8 days; longer windows read the 1m candles.
    const points: [number, string][] =
      secs !== null && secs <= 7 * DAY
        ? this.store.snapshotsSince(mint, from).map((s) => [s.ts, s.nav])
        : this.store.candlesSince(mint, from).flatMap((c) => (c.nav === null ? [] : [[c.t, c.nav] as [number, string]]));
    return bucketLast(points, bucket ?? adaptiveBucket(points));
  }

  /**
   * Own-coin candles at `intervalSecs`, widened to the next supported interval until the window fits in
   * `MAX_CANDLES` (minutes older than the 1-minute retention are hourly rows).
   */
  candles(mint: string, intervalSecs: number, range: RangeKey): Candle[] {
    const now = this.now();
    const { secs } = RANGES[range];
    const from = secs === null ? 0 : now - secs;
    const rows = this.store.candlesSince(mint, from).map(({ t, o, h, l, c, mcap }) => ({ t, o, h, l, c, mcap }));
    if (rows.length === 0) return [];
    const span = rows[rows.length - 1]!.t - rows[0]!.t + 60;
    const interval = CANDLE_INTERVALS.find((i) => i >= intervalSecs && span / i <= MAX_CANDLES) ?? CANDLE_INTERVALS[CANDLE_INTERVALS.length - 1]!;
    return interval <= 60 ? rows : mergeCandles(rows, interval);
  }

  // ---------------- traders ----------------

  private copiersCountByTarget(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const m of this.summaries()) for (const t of m.targets) counts.set(t.address, (counts.get(t.address) ?? 0) + 1);
    return counts;
  }

  private entryOf(k: MergedWallet, counts: Map<string, number>, earned: Map<string, string>): DirectoryEntry {
    const { verified: _, name: __, ...ref } = this.traderRef(k.address, false);
    return {
      ...ref,
      name: k.name,
      personId: k.personId,
      walletCount: k.walletCount,
      stats: k.stats,
      tradesPerDay: k.tradesPerDay,
      score: k.score,
      scoreNotes: k.scoreNotes,
      rank: k.rank,
      tags: k.tags,
      notes: k.notes,
      copiersCount: counts.get(k.address) ?? 0,
      earnedLamports: earned.get(k.address) ?? "0",
    };
  }

  directoryList(query: DirectoryQuery): DirectoryPage {
    const counts = this.copiersCountByTarget();
    const earned = this.store.earningsByTarget();
    const { items, total, facets } = this.directory.query(query, (a) => counts.get(a) ?? 0);
    return {
      items: items.map((k) => this.entryOf(k, counts, earned)),
      total,
      offset: query.offset,
      limit: query.limit,
      facets,
      totals: { wallets: this.directory.all().length, persons: this.directory.personCount() },
      refreshedAt: this.directory.refreshedAt(),
    };
  }

  traderProfile(address: string): TraderProfile {
    const k = this.directory.get(address);
    const counts = this.copiersCountByTarget();
    const earned = this.store.earningsByTarget();
    const copiers = this.summaries().filter((m) => m.targets.some((t) => t.address === address));
    const earnings = this.store.earningsOf(address);
    const entry = k ? this.entryOf(k, counts, earned) : null;
    const wallets = k ? this.directory.person(k.personId) : [];
    return {
      address,
      entry,
      person:
        k && entry
          ? {
              id: k.personId,
              name: k.name,
              handle: k.handle,
              xUrl: entry.xUrl,
              displayName: k.displayName,
              avatar: entry.avatar,
              avatarLarge: this.directory.avatars.url(k, 256),
              followers: k.followers,
              followersOn: k.followersOn,
              // This wallet first, then the person's others by score.
              wallets: [k, ...wallets.filter((w) => w !== k).sort((a, b) => (b.score ?? -1) - (a.score ?? -1))].map((w) => this.entryOf(w, counts, earned)),
            }
          : null,
      sources: (k?.rows ?? [])
        .filter((r) => r.source !== "localnet")
        .map((r) => ({
          source: r.source,
          rank: r.rank,
          url: r.url,
          name: r.name,
          handle: r.handle,
          followers: r.followers,
          stats: r.stats,
          tags: r.tags,
          notes: r.notes,
          fetchedAt: this.directory.refreshedAt()[r.source] ?? null,
          listed: !r.profileOnly,
        })),
      copiers,
      earnedLamports: earned.get(address) ?? "0",
      earnings: earnings.map((e) => ({ copier: e.copier, symbol: e.symbol ?? "", lamports: e.lamports, distributions: e.distributions })),
      verifiedOn: copiers.filter((m) => m.targets.some((t) => t.address === address && t.verified)).map((m) => m.mint),
      recentTrades: this.store.copiesOfTarget(address, 50).map((r) => this.targetTrade(r)),
      stats: this.store.targetStats(address),
    };
  }

  // ---------------- governance ----------------

  private changeView(r: AdminChangeRow, cfg: ProgramConfig | null): AdminChange {
    const payload = r.payload ? (JSON.parse(r.payload) as AdminChangePayload) : null;
    return {
      id: r.id,
      kind: r.kind,
      status: changeStatus(r, cfg?.latestChangeIds ?? null, this.now()),
      proposer: r.proposer,
      proposedAt: r.proposed_at,
      eta: r.eta,
      expiresAt: r.expires_at,
      invalidation: r.invalidated_reason && r.invalidated_at !== null ? { reason: r.invalidated_reason, ts: r.invalidated_at } : null,
      resolvedAt: r.resolved_at,
      proposeSig: r.propose_sig,
      resolveSig: r.resolve_sig,
      payload,
      summary: payload ? changeSummary(payload, cfg, (m) => this.store.copier(m)) : [],
    };
  }

  private openChanges(cfg: ProgramConfig | null): AdminChange[] {
    return this.store.openChanges().map((r) => this.changeView(r, cfg));
  }

  adminChange(id: number): AdminChange | null {
    const r = this.store.adminChange(id);
    return r ? this.changeView(r, this.config()) : null;
  }

  governance(): Governance {
    const cfg = this.config();
    const heartbeat = cfg?.keeperHeartbeatTs ?? null;
    const grace = cfg?.params.keeperGraceSecs ?? null;
    return {
      timelockSecs: cfg?.timelockSecs ?? null,
      admin: cfg?.admin ?? null,
      pendingAdmin: cfg?.pendingAdmin ?? null,
      pendingAdminEta: cfg?.pendingAdminEta ?? null,
      keeper: cfg?.keeper ?? null,
      keeperPaused: cfg !== null && cfg.keeper === null,
      keeperHeartbeatTs: heartbeat,
      keeperGraceSecs: grace,
      keeperStale: heartbeat !== null && grace !== null && this.now() - heartbeat > grace,
      pending: this.openChanges(cfg),
      history: this.store.changeHistory(50).map((r) => this.changeView(r, cfg)),
      keeperPauses: this.store.keeperPauses(50).map((p) => ({ signature: p.signature, ts: p.ts, keeper: p.keeper })),
    };
  }

  // ---------------- the platform token ----------------

  platformToken(): PlatformTokenInfo {
    const cfg = this.config();
    const mint = cfg?.platformMint ?? null;
    const detail = mint ? this.detail(mint) : null;
    const burned = mint ? this.store.mintBurned(mint) : { tokens: "0", platform_sol: "0" };
    const positions = mint ? this.store.positions(mint) : [];
    const targets = detail?.targets ?? [];
    const weights = targetWeights(
      targets.map((t) => t.address),
      positions.map((p) => ({ target: p.target, cost: big(p.cost) })),
    );
    return {
      mint,
      copier: detail,
      targets: targets.map((t, i) => ({
        ...this.traderRef(t.address, t.verified),
        index: t.index,
        weightBps: weights[i] ?? 0,
        copies: t.copies,
        pnlLamports: t.realizedPnlLamports,
        openPositions: t.openPositions,
        lastTradeTs: t.lastTradeAt,
      })),
      // On-chain `capital_in` (every `deposit`), not the indexed `Deposited` rows: history the node pruned is lost.
      seedLamports: detail?.capitalInLamports ?? "0",
      burnPool: BURN_POOL,
      burnPoolLamports: this.store.getState(BURN_POOL_KEY),
      totalBurnedTokens: burned.tokens,
      platformBurnLamports: cfg?.platformBurnSpent ?? burned.platform_sol,
      burns: mint ? this.burns({ copier: mint, limit: 50 }) : [],
    };
  }
}

/** ≤ ~400 points for an unbounded range: bucket = span / 400, at least the 15s sampling period. */
function adaptiveBucket(points: [number, unknown][]): number {
  if (points.length < 2) return 15;
  const span = points[points.length - 1]![0] - points[0]![0];
  return Math.max(15, Math.ceil(span / 400 / 15) * 15);
}

/**
 * The copier's buy spend window as `copier_buy` enforces it: `window_spent ≤ window_equity × max_window_spend_bps`, a
 * new window (re-based on current equity) on the first buy ≥ `spend_window_secs` after `window_start`.
 */
export function spendWindowOf(
  row: Pick<CopierRow, "window_start" | "window_spent" | "window_equity">,
  params: Pick<ParamsSnapshot, "spendWindowSecs" | "maxWindowSpendBps"> | null,
): SpendWindow {
  const spent = big(row.window_spent);
  const cap = params ? (big(row.window_equity) * BigInt(params.maxWindowSpendBps)) / 10_000n : null;
  return {
    startedAt: row.window_start,
    resetsAt: params ? row.window_start + params.spendWindowSecs : null,
    spentLamports: spent.toString(),
    equityLamports: row.window_equity,
    capLamports: cap?.toString() ?? null,
    remainingLamports: cap === null ? null : (cap > spent ? cap - spent : 0n).toString(),
  };
}

/**
 * The program's lifecycle of a change: closed by its event; superseded when a `ChangeInvalidated` was seen; else the
 * SDK's `pendingChangeStatus` (not `latest_change_ids[kind]` → superseded, past expiry → expired, before eta → queued,
 * else executable). Before the Config / account were read, only eta (and a known expiry) decide.
 */
export function changeStatus(r: AdminChangeRow, latest: (number | null)[] | null, now: number): ChangeStatus {
  if (r.status !== "open") return r.status;
  if (r.invalidated_reason !== null) return "superseded";
  if (latest !== null && r.expires_at !== null) {
    return pendingChangeStatus(
      { id: BigInt(r.id), kind: r.kind, eta: BigInt(r.eta), expiresAt: BigInt(r.expires_at) },
      { latestChangeIds: latest.map((id) => (id === null ? NO_CHANGE_ID : BigInt(id))) },
      now,
    );
  }
  if (latest !== null && latest[CHANGE_KIND_INDEX[r.kind]] !== r.id) return "superseded";
  if (r.expires_at !== null && now > r.expires_at) return "expired";
  return now < r.eta ? "queued" : "executable";
}

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

/** What a proposed change would change, against the current config ("maxTradeBps 1000 → 2500"). */
export function changeSummary(
  payload: AdminChangePayload,
  cfg: ProgramConfig | null,
  copierOf: (mint: string) => Pick<CopierRow, "targets" | "symbol"> | undefined,
): string[] {
  switch (payload.kind) {
    case "keeper":
      return [`keeper ${cfg?.keeper ? short(cfg.keeper) : "none"} → ${short(payload.keeper)}`];
    case "params": {
      const now = cfg?.params;
      const out: string[] = [];
      for (const k of Object.keys(payload.params) as (keyof ParamsSnapshot)[]) {
        const next = payload.params[k];
        const prev = now?.[k];
        if (prev === undefined) out.push(`${k} → ${next}`);
        else if (String(prev) !== String(next)) out.push(`${k} ${prev} → ${next}`);
      }
      return out.length ? out : ["params unchanged"];
    }
    case "descriptors":
      return [`trade descriptors replaced (${payload.descriptors} entries)`];
    case "indexTargets": {
      const m = copierOf(payload.copier);
      const before = m ? (JSON.parse(m.targets) as string[]) : [];
      const added = payload.targets.filter((t) => !before.includes(t));
      const removed = before.filter((t) => !payload.targets.includes(t));
      const label = m?.symbol ? `$${m.symbol}` : short(payload.copier);
      return [
        `${label} index targets: ${payload.targets.length} wallets`,
        ...(added.length ? [`adds ${added.map(short).join(", ")}`] : []),
        ...(removed.length ? [`removes ${removed.map(short).join(", ")}`] : []),
      ];
    }
  }
}
