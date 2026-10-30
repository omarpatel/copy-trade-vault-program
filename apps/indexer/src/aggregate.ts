/**
 * Pure aggregation math behind the API views (no I/O): NAV and marks, copy lag, HWM replay, fee-distribution
 * shares, series bucketing and candles. Lamports are bigint here; views stringify them.
 */
import { feeAmount, venueSellQuote, type FeeBps, type VenueReserves } from "@copy-trade-vault/sdk";
import type { Candle } from "@copy-trade-vault/sdk/api";
import type { DistributeCreatorFeesEvent } from "./chain-logs";

/** num ÷ den in bps (rounded toward zero); null when den ≤ 0. */
export function ratioBps(num: bigint, den: bigint): number | null {
  if (den <= 0n) return null;
  return Number((num * 10_000n) / den);
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

export function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
}

/**
 * Copy lag between the target trade and the vault tx answering it: block times (1 s resolution) in ms and the
 * slot distance. A vault tx can't precede its signal; negative distances (clock skew between leaders) clamp to 0.
 */
export function copyLag(
  target: { blockTime: number | null; slot: number | null },
  vault: { blockTime: number | null; slot: number | null },
): { lagMs: number | null; lagSlots: number | null } {
  const lagMs = target.blockTime !== null && vault.blockTime !== null ? Math.max(0, vault.blockTime - target.blockTime) * 1000 : null;
  const lagSlots = target.slot !== null && vault.slot !== null ? Math.max(0, vault.slot - target.slot) : null;
  return { lagMs, lagSlots };
}

/** Rent-exempt minimum of a zero-data system account (the vault PDA). */
export const ZERO_DATA_RENT = 890_880n;

export interface VaultBook {
  /** lamports + wSOL − rent − buyback_pool − platform_pending (≥ 0): the program's `free_sol`. */
  free: bigint;
  /** Program equity: free + open cost. */
  equity: bigint;
  /** Mark-to-market: free + Σ marked positions. */
  nav: bigint;
  positionsValue: bigint;
  unrealized: bigint;
}

/**
 * Vault accounting, same formula as `Copier::free_sol` / `Copier::equity` in the program. Positions without a mark
 * count at cost basis, so an unpriced position neither inflates nor deflates NAV.
 */
export function vaultBook(input: {
  vaultLamports: bigint;
  wsol: bigint;
  rent: bigint;
  buybackPool: bigint;
  platformPending: bigint;
  openCost: bigint;
  positions: { cost: bigint; value: bigint | null }[];
}): VaultBook {
  let free = input.vaultLamports + input.wsol - input.rent - input.buybackPool - input.platformPending;
  if (free < 0n) free = 0n;
  let positionsValue = 0n;
  let marked = 0n;
  let markedCost = 0n;
  let seenCost = 0n;
  for (const p of input.positions) {
    positionsValue += p.value ?? p.cost;
    seenCost += p.cost;
    if (p.value !== null) {
      marked += p.value;
      markedCost += p.cost;
    }
  }
  // Open cost is the program's own sum; positions not fetched yet still count at cost.
  if (input.openCost > seenCost) positionsValue += input.openCost - seenCost;
  return {
    free,
    equity: free + input.openCost,
    nav: free + positionsValue,
    positionsValue,
    unrealized: marked - markedCost,
  };
}

export interface PositionMark {
  value: bigint | null;
  unrealized: bigint | null;
  unrealizedBps: number | null;
  pctOfEquityBps: number | null;
}

/**
 * What selling the whole position would return right now: the venue's sell quote for every token (constant-product
 * price impact) minus the venue's lp / protocol / creator fees. pump_amm rejects a sell whose `raw − lp fee` exceeds
 * the pool's real quote; then the largest payable raw output (`real × 10000 / (10000 − lp)`) is what an exit can get.
 */
export function exitValueLamports(tokens: bigint, reserves: VenueReserves, feeBps: FeeBps): bigint {
  if (tokens <= 0n) return 0n;
  try {
    return venueSellQuote(reserves, tokens, feeBps).solOut;
  } catch {
    const raw = (reserves.realQuoteReserve * 10_000n) / (10_000n - BigInt(feeBps.lpBps));
    const fees = feeAmount(raw, feeBps.lpBps) + feeAmount(raw, feeBps.protocolBps) + feeAmount(raw, feeBps.creatorBps);
    return raw > fees ? raw - fees : 0n;
  }
}

export function markPosition(cost: bigint, value: bigint | null, nav: bigint): PositionMark {
  const unrealized = value === null ? null : value - cost;
  return {
    value,
    unrealized,
    unrealizedBps: unrealized === null ? null : ratioBps(unrealized, cost),
    pctOfEquityBps: ratioBps(value ?? cost, nav),
  };
}

export interface HwmStep {
  ts: number;
  pnl: bigint;
  realized: bigint;
  hwm: bigint;
  /** Profit above the previous HWM that this sell split (75% coin buyback / 25% the platform token). */
  excess: bigint;
}

/**
 * Replays the program's HWM rule over a copier's sells (`realized += pnl; if realized > hwm: excess = realized − hwm,
 * hwm = realized`). Starts from 0/0 like a fresh `Copier` account; used to cross-check indexed `CopierSell` events
 * and to derive the split history when only pnl is known.
 */
export function replayHwm(sells: { ts: number; pnl: bigint }[]): HwmStep[] {
  let realized = 0n;
  let hwm = 0n;
  return sells.map(({ ts, pnl }) => {
    realized += pnl;
    let excess = 0n;
    if (realized > hwm) {
      excess = realized - hwm;
      hwm = realized;
    }
    return { ts, pnl, realized, hwm, excess };
  });
}

export interface DistributionSplit {
  distributed: bigint;
  toVault: bigint;
  toTargets: bigint;
  shares: { address: string; bps: number; lamports: bigint; role: "vault" | "target" | "other" }[];
}

/**
 * Splits one pump `DistributeCreatorFeesEvent` between the vault and the target(s). Each shareholder's lamports are
 * its observed balance change in the tx when that is a plausible pure credit (0 ≤ Δ ≤ distributed); otherwise
 * (shareholder also paid fees / moved SOL in the same tx, or is absent from the key list) pump's pro-rata
 * `distributed × share_bps / 10000`.
 */
export function splitDistribution(
  ev: Pick<DistributeCreatorFeesEvent, "distributed" | "shareholders">,
  observedDelta: (address: string) => bigint | null,
  vault: string,
  targets: string[],
): DistributionSplit {
  let toVault = 0n;
  let toTargets = 0n;
  const shares = ev.shareholders.map(({ address, shareBps }) => {
    const seen = observedDelta(address);
    const lamports = seen !== null && seen >= 0n && seen <= ev.distributed ? seen : (ev.distributed * BigInt(shareBps)) / 10_000n;
    const role = address === vault ? "vault" : targets.includes(address) ? "target" : "other";
    if (role === "vault") toVault += lamports;
    else if (role === "target") toTargets += lamports;
    return { address, bps: shareBps, lamports, role } as const;
  });
  return { distributed: ev.distributed, toVault, toTargets, shares };
}

/** Last value per `bucketSecs` bucket, stamped with the bucket start (input sorted by ts). */
export function bucketLast<T>(points: [number, T][], bucketSecs: number): [number, T][] {
  if (bucketSecs <= 1) return points;
  const out: [number, T][] = [];
  for (const [ts, v] of points) {
    const b = ts - (ts % bucketSecs);
    const last = out[out.length - 1];
    if (last && last[0] === b) last[1] = v;
    else out.push([b, v]);
  }
  return out;
}

/** `n` evenly spaced samples over [from, to] carrying the last known value forward (input sorted by ts). */
export function sparkline(points: [number, number][], from: number, to: number, n: number): number[] {
  if (points.length === 0 || n <= 0) return [];
  const out: number[] = [];
  let i = 0;
  let last: number | null = null;
  for (let k = 0; k < n; k++) {
    const t = n === 1 ? to : from + ((to - from) * k) / (n - 1);
    while (i < points.length && points[i]![0] <= t) last = points[i++]![1];
    if (last !== null) out.push(last);
  }
  return out;
}

/** Folds one price sample into the candle of its bucket (a new candle when `c` is another bucket or null). */
export function foldCandle(c: Candle | null, t: number, price: number, mcap: string | null): Candle {
  if (!c || c.t !== t) return { t, o: price, h: price, l: price, c: price, mcap };
  return { t, o: c.o, h: Math.max(c.h, price), l: Math.min(c.l, price), c: price, mcap: mcap ?? c.mcap };
}

/** Merges consecutive candles into `intervalSecs` candles (input sorted by t, each aligned to its own interval). */
export function mergeCandles(candles: Candle[], intervalSecs: number): Candle[] {
  const out: Candle[] = [];
  for (const k of candles) {
    const t = k.t - (k.t % intervalSecs);
    const last = out[out.length - 1];
    if (last && last.t === t) {
      last.h = Math.max(last.h, k.h);
      last.l = Math.min(last.l, k.l);
      last.c = k.c;
      last.mcap = k.mcap ?? last.mcap;
    } else {
      out.push({ ...k, t });
    }
  }
  return out;
}

export function changeBps(now: number | null, past: number | null): number | null {
  if (now === null || past === null || past <= 0) return null;
  return Math.round(((now - past) / past) * 10_000);
}

/**
 * the platform token basket weights: each target's share of the open cost basis in positions its trades opened; an equal split
 * while the vault is flat. Rounding remainder goes to the first target so the weights sum to 10000.
 */
export function targetWeights(targets: string[], exposure: { target: string | null; cost: bigint }[]): number[] {
  if (targets.length === 0) return [];
  const per = targets.map((t) => exposure.reduce((s, e) => (e.target === t ? s + e.cost : s), 0n));
  const total = per.reduce((a, b) => a + b, 0n);
  const weights = total > 0n ? per.map((c) => Number((c * 10_000n) / total)) : targets.map(() => Math.floor(10_000 / targets.length));
  weights[0]! += 10_000 - weights.reduce((a, b) => a + b, 0);
  return weights;
}

export type RangeKey = "1h" | "24h" | "7d" | "30d" | "all";

/** Window and bucket (seconds) of an `?range=` value; ≤ ~400 points per series (`all`: bucket sized to the history). */
export const RANGES: Record<RangeKey, { secs: number | null; bucket: number | null }> = {
  "1h": { secs: 3_600, bucket: 15 },
  "24h": { secs: 86_400, bucket: 300 },
  "7d": { secs: 7 * 86_400, bucket: 1_800 },
  "30d": { secs: 30 * 86_400, bucket: 7_200 },
  all: { secs: null, bucket: null },
};
