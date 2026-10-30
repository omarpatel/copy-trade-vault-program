/**
 * Bigint math with no runtime web3 dependency (safe for light browser bundles): pump curve /
 * PumpSwap quotes (exact ports of pump-rust-client 0.2.0 `math::*`, which copier the on-chain
 * programs), fee tiers, and copy-vault's sell / profit-split / cap rules (programs/copy-vault). Floor division
 * unless noted. The live-FeeConfig fee selection (`curveFeeBps` / `poolFeeBps`) lives in `math.ts`.
 */
import { BPS, PROFIT_BUYBACK_BPS, PUMP_TOKEN_TOTAL_SUPPLY, TOKEN_UNIT } from "./params";
import type { BondingCurve, Fees, FeeTier, Pool } from "./layout";

// ---------------------------------------------------------------------------------------------
// Fees
// ---------------------------------------------------------------------------------------------

/** The bps a venue charges per trade, split by recipient. */
export type FeeBps = Fees;

/** Live bonding-curve schedule (pump FeeConfig `8Wf5…`, one tier): protocol 0.95% + creator 0.30%. */
export const PUMP_CURVE_FEE_BPS: FeeBps = { lpBps: 0, protocolBps: 95, creatorBps: 30 };

/** Live PumpSwap canonical-pool tiers (pump_amm FeeConfig `5PHi…`, read 2026-10-04; fee-sharing.md §4). */
export const PUMP_AMM_FEE_TIERS: FeeTier[] = (
  [
    [0, 2, 93, 30],
    [420, 20, 5, 95],
    [1_470, 20, 5, 90],
    [2_460, 20, 5, 85],
    [3_440, 20, 5, 80],
    [4_420, 20, 5, 75],
    [9_820, 20, 5, 70],
    [14_740, 20, 5, 65],
    [19_650, 20, 5, 60],
    [24_560, 20, 5, 55],
    [29_470, 20, 5, 50],
    [34_380, 20, 5, 45],
    [39_300, 20, 5, 40],
    [44_210, 20, 5, 35],
    [49_120, 20, 5, 30],
    [54_030, 20, 5, 28],
    [58_940, 20, 5, 25],
    [63_860, 20, 5, 23],
    [68_770, 20, 5, 20],
    [73_681, 20, 5, 18],
    [78_590, 20, 5, 15],
    [83_500, 20, 5, 13],
    [88_400, 20, 5, 10],
    [93_330, 20, 5, 8],
    [98_240, 20, 5, 5],
  ] as const
).map(([sol, lpBps, protocolBps, creatorBps]) => ({
  thresholdLamports: BigInt(sol) * 1_000_000_000n,
  fees: { lpBps, protocolBps, creatorBps },
}));

/** Non-canonical pools pay these flat fees (no creator fee). */
export const PUMP_AMM_FLAT_FEE_BPS: FeeBps = { lpBps: 25, protocolBps: 5, creatorBps: 0 };

export const totalFeeBps = (f: FeeBps) => f.lpBps + f.protocolBps + f.creatorBps;

/** pump's `fee(x, bps) = ceil(x * bps / 10_000)`. */
export function feeAmount(amount: bigint, bps: number): bigint {
  return (amount * BigInt(bps) + BPS - 1n) / BPS;
}

/** The highest tier whose threshold ≤ `mcapLamports`; the first tier below every threshold. */
export function pickFeeTier(tiers: FeeTier[], mcapLamports: bigint): Fees {
  const first = tiers[0];
  if (!first) throw new Error("empty fee tier schedule");
  for (let i = tiers.length - 1; i >= 0; i--) {
    if (mcapLamports >= tiers[i]!.thresholdLamports) return tiers[i]!.fees;
  }
  return first.fees;
}

/**
 * pump's exact-input fee split (`exact_in_fees`): the largest `net` with
 * `net + Σ ceil(net × bps_i / 10_000) ≤ amountIn`. 0 when the input can't cover the fees.
 */
export function exactInNet(amountIn: bigint, fees: FeeBps): bigint {
  const parts = [fees.lpBps, fees.protocolBps, fees.creatorBps];
  let net = (amountIn * BPS) / (BPS + BigInt(totalFeeBps(fees)));
  if (net <= 0n) return 0n;
  const cost = net + parts.reduce((s, b) => s + feeAmount(net, b), 0n);
  if (cost > amountIn) net -= cost - amountIn;
  return net > 0n ? net : 0n;
}

const feesOn = (amount: bigint, f: FeeBps) =>
  feeAmount(amount, f.lpBps) + feeAmount(amount, f.protocolBps) + feeAmount(amount, f.creatorBps);

// ---------------------------------------------------------------------------------------------
// Reserves
// ---------------------------------------------------------------------------------------------

/** A venue's reserves, normalized: the curve's virtual reserves or the pool's vault balances. */
export interface VenueReserves {
  kind: "curve" | "pool";
  /** Tokens the price uses: curve `virtual_token_reserves`; pool base vault balance. */
  baseReserve: bigint;
  /** Lamports the price uses: curve `virtual_quote_reserves`; pool quote vault + `virtual_quote_reserves`. */
  quoteReserve: bigint;
  /** Tokens that can be bought: curve `real_token_reserves`; pool base vault balance. */
  realBaseReserve: bigint;
  /** Lamports that can leave on sells: curve `real_quote_reserves`; pool quote vault − un-swept buckets. */
  realQuoteReserve: bigint;
  /**
   * The "real SOL" the program caps trades against (`max_impact_bps`): curve `real_quote_reserves`;
   * pool quote vault balance (buckets included).
   */
  impactQuoteReserve: bigint;
  /** Token supply (raw units) for market cap: live mint supply when known, else the stored total supply. */
  supply: bigint;
}

/** `VenueReserves` of a bonding curve. Pass the live mint supply when known (buyback burns lower it). */
export function curveReserves(curve: BondingCurve, mintSupply?: bigint): VenueReserves {
  return {
    kind: "curve",
    baseReserve: curve.virtualTokenReserves,
    quoteReserve: curve.virtualQuoteReserves,
    realBaseReserve: curve.realTokenReserves,
    realQuoteReserve: curve.realQuoteReserves,
    impactQuoteReserve: curve.realQuoteReserves,
    supply: curve.isMayhemMode ? curve.tokenTotalSupply : (mintSupply ?? curve.tokenTotalSupply),
  };
}

/**
 * `VenueReserves` of a PumpSwap pool from its vault balances. The pricing quote is the vault balance
 * plus the signed `virtual_quote_reserves`; sells pay out of the vault minus the un-swept buckets.
 */
export function poolReserves(pool: Pool, baseVaultAmount: bigint, quoteVaultAmount: bigint, mintSupply = PUMP_TOKEN_TOTAL_SUPPLY): VenueReserves {
  const effective = quoteVaultAmount + pool.virtualQuoteReserves;
  const real = quoteVaultAmount - pool.protocolFees - pool.creatorFees;
  return {
    kind: "pool",
    baseReserve: baseVaultAmount,
    quoteReserve: effective > 0n ? effective : 0n,
    realBaseReserve: baseVaultAmount,
    realQuoteReserve: real > 0n ? real : 0n,
    impactQuoteReserve: quoteVaultAmount,
    supply: mintSupply,
  };
}

/** pump's initial curve (`Global.initial_*`): what every fresh `create_v2` coin trades against. */
export const PUMP_INITIAL_VIRTUAL_TOKEN_RESERVES = 1_073_000_000_000_000n;
export const PUMP_INITIAL_VIRTUAL_QUOTE_RESERVES = 30_000_000_000n;
export const PUMP_INITIAL_REAL_TOKEN_RESERVES = 793_100_000_000_000n;

/** A fresh curve's reserves, for quoting a dev buy without RPC. */
export const PUMP_INITIAL_CURVE: VenueReserves = {
  kind: "curve",
  baseReserve: PUMP_INITIAL_VIRTUAL_TOKEN_RESERVES,
  quoteReserve: PUMP_INITIAL_VIRTUAL_QUOTE_RESERVES,
  realBaseReserve: PUMP_INITIAL_REAL_TOKEN_RESERVES,
  realQuoteReserve: 0n,
  impactQuoteReserve: 0n,
  supply: PUMP_TOKEN_TOTAL_SUPPLY,
};

/** Curve state as quotes need it; both `BondingCurve` and `VenueReserves` work. */
export type CurveLike =
  | Pick<BondingCurve, "virtualTokenReserves" | "virtualQuoteReserves" | "realTokenReserves" | "realQuoteReserves">
  | VenueReserves;

function curveParts(c: CurveLike) {
  return "baseReserve" in c
    ? { vT: c.baseReserve, vQ: c.quoteReserve, realT: c.realBaseReserve }
    : { vT: c.virtualTokenReserves, vQ: c.virtualQuoteReserves, realT: c.realTokenReserves };
}

// ---------------------------------------------------------------------------------------------
// Quotes
// ---------------------------------------------------------------------------------------------

export interface BuyQuote {
  /** Tokens received (raw units). */
  tokensOut: bigint;
  /** Lamports that buy tokens after fees. */
  netSol: bigint;
  /** Fees on `netSol` (lp + protocol + creator). */
  feeLamports: bigint;
  /** Creator part of `feeLamports`. */
  creatorFeeLamports: bigint;
}

export interface SellQuote {
  /** Lamports received after fees. */
  solOut: bigint;
  /** Constant-product output before fees. */
  rawSol: bigint;
  feeLamports: bigint;
  creatorFeeLamports: bigint;
}

const ZERO_BUY: BuyQuote = { tokensOut: 0n, netSol: 0n, feeLamports: 0n, creatorFeeLamports: 0n };

/**
 * `buy_exact_quote_in_v2/_v3` on a bonding curve: tokens for `solIn` lamports (fees included),
 * capped at the curve's real token reserves.
 */
export function curveBuyQuote(curve: CurveLike, solIn: bigint, feeBps: FeeBps): BuyQuote {
  const { vT, vQ, realT } = curveParts(curve);
  if (solIn <= 0n || vT === 0n || vQ === 0n) return ZERO_BUY;
  const net = exactInNet(solIn, feeBps);
  if (net <= 1n) return ZERO_BUY;
  const swapped = ((net - 1n) * vT) / (vQ + net - 1n);
  return {
    tokensOut: swapped < realT ? swapped : realT,
    netSol: net,
    feeLamports: feesOn(net, feeBps),
    creatorFeeLamports: feeAmount(net, feeBps.creatorBps),
  };
}

/** `sell_v2/_v3` on a bonding curve: lamports for `tokensIn` after fees. */
export function curveSellQuote(curve: CurveLike, tokensIn: bigint, feeBps: FeeBps): SellQuote {
  const { vT, vQ } = curveParts(curve);
  if (tokensIn <= 0n || vT === 0n) return { solOut: 0n, rawSol: 0n, feeLamports: 0n, creatorFeeLamports: 0n };
  const rawSol = (tokensIn * vQ) / (vT + tokensIn);
  const feeLamports = feesOn(rawSol, feeBps);
  return {
    solOut: rawSol > feeLamports ? rawSol - feeLamports : 0n,
    rawSol,
    feeLamports,
    creatorFeeLamports: feeAmount(rawSol, feeBps.creatorBps),
  };
}

/** Pool state as quotes need it. */
export type PoolLike = Pick<VenueReserves, "baseReserve" | "quoteReserve" | "realQuoteReserve">;

/** PumpSwap `buy_exact_quote_in(_v2)`: base tokens for `solIn` lamports of quote (fees included). */
export function poolBuyQuote(pool: PoolLike, solIn: bigint, feeBps: FeeBps): BuyQuote {
  const { baseReserve: B, quoteReserve: Q } = pool;
  if (solIn <= 0n || B === 0n || Q === 0n) return ZERO_BUY;
  const net = exactInNet(solIn, feeBps);
  if (net <= 1n) return ZERO_BUY;
  return {
    tokensOut: ((net - 1n) * B) / (Q + net - 1n),
    netSol: net,
    feeLamports: feesOn(net, feeBps),
    creatorFeeLamports: feeAmount(net, feeBps.creatorBps),
  };
}

/**
 * PumpSwap `sell(_v2)`: quote lamports for `tokensIn` after fees. Throws when the pool's real quote
 * (vault minus un-swept buckets) can't pay `raw − lp fee`, as pump_amm does.
 */
export function poolSellQuote(pool: PoolLike, tokensIn: bigint, feeBps: FeeBps): SellQuote {
  const { baseReserve: B, quoteReserve: Q } = pool;
  if (tokensIn <= 0n || B === 0n || Q === 0n) return { solOut: 0n, rawSol: 0n, feeLamports: 0n, creatorFeeLamports: 0n };
  const rawSol = (Q * tokensIn) / (B + tokensIn);
  const feeLamports = feesOn(rawSol, feeBps);
  if (pool.realQuoteReserve < rawSol - feeAmount(rawSol, feeBps.lpBps)) {
    throw new Error("pool cannot pay this sell: insufficient real quote reserves");
  }
  return {
    solOut: rawSol > feeLamports ? rawSol - feeLamports : 0n,
    rawSol,
    feeLamports,
    creatorFeeLamports: feeAmount(rawSol, feeBps.creatorBps),
  };
}

/** Buy quote on whichever venue `reserves` describes. */
export function venueBuyQuote(reserves: VenueReserves, solIn: bigint, feeBps: FeeBps): BuyQuote {
  return reserves.kind === "curve" ? curveBuyQuote(reserves, solIn, feeBps) : poolBuyQuote(reserves, solIn, feeBps);
}

/** Sell quote on whichever venue `reserves` describes. */
export function venueSellQuote(reserves: VenueReserves, tokensIn: bigint, feeBps: FeeBps): SellQuote {
  return reserves.kind === "curve" ? curveSellQuote(reserves, tokensIn, feeBps) : poolSellQuote(reserves, tokensIn, feeBps);
}

/** `expected × (10_000 − slippageBps) / 10_000`: a minimum-out bound. */
export function withSlippage(expected: bigint, slippageBps: number): bigint {
  const keep = BPS - BigInt(Math.min(Math.max(slippageBps, 0), 10_000));
  return (expected * keep) / BPS;
}

// ---------------------------------------------------------------------------------------------
// Price / value
// ---------------------------------------------------------------------------------------------

type Priced = Pick<VenueReserves, "baseReserve" | "quoteReserve">;

/** Spot price in lamports per WHOLE token (10^6 raw units), as a float for display. */
export function spotPriceLamportsPerToken(reserves: Priced): number {
  if (reserves.baseReserve === 0n) return 0;
  // 1e12 fixed-point keeps 12 significant decimals before the float conversion.
  const scaled = (reserves.quoteReserve * TOKEN_UNIT * 1_000_000_000_000n) / reserves.baseReserve;
  return Number(scaled) / 1e12;
}

/** Lamports `tokens` raw units are worth at the spot price, floored (the program's signal / mark value). */
export function tokenValueLamports(tokens: bigint, reserves: Priced): bigint {
  return reserves.baseReserve === 0n ? 0n : (tokens * reserves.quoteReserve) / reserves.baseReserve;
}

/** Market cap in lamports: `quote × supply / base` (pump's tier formula). `supply` in raw units. */
export function marketCapLamports(reserves: Priced & { supply?: bigint }, supply?: bigint): bigint {
  const s = supply ?? reserves.supply ?? PUMP_TOKEN_TOTAL_SUPPLY;
  return reserves.baseReserve === 0n ? 0n : (reserves.quoteReserve * s) / reserves.baseReserve;
}

/** Share of the curve's sellable supply already bought, in bps (0–10_000). */
export function curveProgressBps(realTokenReserves: bigint, initialRealTokenReserves = PUMP_INITIAL_REAL_TOKEN_RESERVES): number {
  if (initialRealTokenReserves === 0n || realTokenReserves >= initialRealTokenReserves) return 0;
  const bps = ((initialRealTokenReserves - realTokenReserves) * BPS) / initialRealTokenReserves;
  return Number(bps > BPS ? BPS : bps);
}

// ---------------------------------------------------------------------------------------------
// Copier rules
// ---------------------------------------------------------------------------------------------

/** The position fields `allowedSell` reads (`Position` decoded from chain satisfies it). */
export interface SellablePosition {
  tokens: bigint;
  targetSnapshot: bigint;
  targetPeak: bigint;
  vaultPeak: bigint;
  /** Unix seconds. */
  openedAt: bigint | number;
}

/**
 * Tokens `copier_sell` lets the vault sell given the target's balance now (programs/copy-vault):
 * - all tokens once `nowTs − openedAt > maxHoldSecs` (forced exit);
 * - when the target sold (`targetNow < targetSnapshot`): `tokens − floor(vaultPeak × targetNow / targetPeak)`,
 *   i.e. the vault keeps the fraction of its peak the target kept of its own;
 * - when the target holds nothing: everything;
 * - otherwise 0.
 */
export function allowedSell(
  position: SellablePosition,
  targetNow: bigint,
  opts: { nowTs?: number | bigint; maxHoldSecs?: number | bigint } = {},
): bigint {
  const { tokens, targetSnapshot, targetPeak, vaultPeak } = position;
  if (tokens <= 0n) return 0n;
  if (opts.nowTs !== undefined && opts.maxHoldSecs !== undefined) {
    if (BigInt(opts.nowTs) - BigInt(position.openedAt) > BigInt(opts.maxHoldSecs)) return tokens;
  }
  // The program also releases everything once the target holds nothing (even when it already held 0).
  if (targetNow >= targetSnapshot && targetNow !== 0n) return 0n;
  if (targetPeak === 0n) return tokens;
  const keep = (vaultPeak * targetNow) / targetPeak;
  return keep >= tokens ? 0n : tokens - keep;
}

export interface ProfitSplit {
  /** `realized_pnl` after this sell. */
  realizedPnl: bigint;
  /** High-water mark after this sell. */
  hwm: bigint;
  /** Profit above the previous HWM (0 when none). */
  excess: bigint;
  /** 75% of `excess`: added to the copier's own-coin `buyback_pool`. */
  toBuyback: bigint;
  /** 25% of `excess`: sent to the platform token burn pool (0 for the platform token itself, which keeps 100%). */
  toPlatform: bigint;
}

/**
 * The high-water-mark profit split of one `copier_sell` with realized `pnl`. `selfBurn` = the copier
 * is the platform token index (`config.platform_mint == copier.mint`): the whole excess buys back its own coin.
 */
export function profitSplit(realized: bigint, hwm: bigint, pnl: bigint, opts: { selfBurn?: boolean } = {}): ProfitSplit {
  const realizedPnl = realized + pnl;
  if (realizedPnl <= hwm) return { realizedPnl, hwm, excess: 0n, toBuyback: 0n, toPlatform: 0n };
  const excess = realizedPnl - hwm;
  const toBuyback = opts.selfBurn ? excess : (excess * BigInt(PROFIT_BUYBACK_BPS)) / BPS;
  return { realizedPnl, hwm: realizedPnl, excess, toBuyback, toPlatform: excess - toBuyback };
}

/**
 * The program's own fill floor for a `copier_buy` / `buyback_burn` / `burn_platform` of `solIn`:
 * `(10_000 − slippageBps)` of the fee-free constant-product quote, capped at what the venue can
 * deliver (`VenueQuote::buy_quote` + `floor_after_slippage`). The fill must reach max(this, min_tokens_out).
 */
export function copierBuyFloor(reserves: VenueReserves, solIn: bigint, slippageBps: number): bigint {
  const { baseReserve: t, quoteReserve: q, realBaseReserve } = reserves;
  const den = q + solIn;
  const raw = den === 0n ? 0n : (t * solIn) / den;
  return withSlippage(raw < realBaseReserve ? raw : realBaseReserve, slippageBps);
}

/** The program's proceeds floor for a `copier_sell` of `tokensIn` (fee-free quote less `slippageBps`). */
export function copierSellFloor(reserves: VenueReserves, tokensIn: bigint, slippageBps: number): bigint {
  const den = reserves.baseReserve + tokensIn;
  return withSlippage(den === 0n ? 0n : (reserves.quoteReserve * tokensIn) / den, slippageBps);
}

/**
 * Most lamports one trade may move on this venue: `maxImpactBps` of the venue's real SOL. Caps
 * `copier_buy`'s `sol_in`, `buyback_burn` / `burn_platform`'s `sol_in`, and (as a fee-free quote) a
 * permissionless `copier_sell`.
 */
export function impactCapLamports(reserves: Pick<VenueReserves, "impactQuoteReserve">, maxImpactBps: number): bigint {
  return (reserves.impactQuoteReserve * BigInt(maxImpactBps)) / BPS;
}

/**
 * Largest `tokens_in` a permissionless `copier_sell` may sell in one slice: the biggest amount whose
 * fee-free quote stays ≤ `impactCapLamports`.
 */
export function publicSellMaxTokens(reserves: VenueReserves, maxImpactBps: number): bigint {
  const cap = impactCapLamports(reserves, maxImpactBps);
  const { baseReserve: t, quoteReserve: q } = reserves;
  if (cap === 0n || t === 0n) return 0n;
  // The program floors the quote: floor(q·n / (t + n)) ≤ cap  ⇔  q·n < (cap + 1)(t + n)
  //   ⇔  n < (cap + 1)·t / (q − cap − 1); every n qualifies once cap + 1 ≥ q.
  if (cap + 1n >= q) return 2n ** 64n - 1n;
  const den = q - cap - 1n;
  let n = ((cap + 1n) * t + den - 1n) / den - 1n;
  while (n > 0n && (q * n) / (t + n) > cap) n--;
  while ((q * (n + 1n)) / (t + n + 1n) <= cap) n++;
  return n;
}

/** The copier fields the spend window reads. */
export interface SpendWindowState {
  windowStart: bigint;
  windowSpent: bigint;
  windowEquity: bigint;
}

/**
 * Lamports `copier_buy` may still spend (measured, rent included) in the copier's spend window at
 * `nowTs`, given its current `equity`. A buy at least `spendWindowSecs` after `windowStart` opens a
 * fresh window based on the equity at that moment (before the buy). The program counts the measured
 * spend including rent, so size opening buys ≤ this − `TRADE_RENT_ALLOWANCE_LAMPORTS` (position, token
 * ATA and UVA rent).
 */
export function spendWindowRemaining(
  copier: SpendWindowState,
  params: { spendWindowSecs: bigint; maxWindowSpendBps: number },
  equity: bigint,
  nowTs: bigint | number,
): bigint {
  const fresh = BigInt(nowTs) - copier.windowStart >= params.spendWindowSecs;
  const cap = ((fresh ? equity : copier.windowEquity) * BigInt(params.maxWindowSpendBps)) / BPS;
  const spent = fresh ? 0n : copier.windowSpent;
  return cap > spent ? cap - spent : 0n;
}

export interface CreatorFeeEstimate {
  /** Creator fee bps at this market cap. */
  creatorBps: number;
  /** Creator fees (lamports) on `volumeLamports` of trading. */
  creatorLamports: bigint;
}

/**
 * Creator fees a coin earns on `volumeLamports` of volume at market cap `mcapLamports`. Uses the pool
 * tiers (default: live mainnet schedule `PUMP_AMM_FEE_TIERS`); a bonding curve never reaches the
 * first tier change (420 SOL; curves graduate near 411 SOL), and its 30 bps equals the first tier.
 * Pass `curveFeeBps` (e.g. from a live FeeConfig) to price the curve stage explicitly.
 */
export function estimateCreatorFees(
  volumeLamports: bigint,
  mcapLamports: bigint,
  opts: { tiers?: FeeTier[]; venue?: "curve" | "pool"; curveFeeBps?: FeeBps } = {},
): CreatorFeeEstimate {
  const creatorBps =
    opts.venue === "curve"
      ? (opts.curveFeeBps ?? PUMP_CURVE_FEE_BPS).creatorBps
      : pickFeeTier(opts.tiers ?? PUMP_AMM_FEE_TIERS, mcapLamports).creatorBps;
  return { creatorBps, creatorLamports: (volumeLamports * BigInt(creatorBps)) / BPS };
}

/** Splits creator fees between the target (`traderBps`) and the vault (the rest). */
export function splitCreatorFees(creatorLamports: bigint, traderBps: number): { target: bigint; vault: bigint } {
  const target = (creatorLamports * BigInt(traderBps)) / BPS;
  return { target, vault: creatorLamports - target };
}
