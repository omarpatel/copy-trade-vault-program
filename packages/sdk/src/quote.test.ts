import assert from "node:assert/strict";
import { test } from "node:test";
import {
  allowedSell,
  impactCapLamports,
  publicSellMaxTokens,
  spendWindowRemaining,
  curveBuyQuote,
  curveSellQuote,
  estimateCreatorFees,
  exactInNet,
  feeAmount,
  marketCapLamports,
  pickFeeTier,
  poolBuyQuote,
  poolSellQuote,
  profitSplit,
  PUMP_AMM_FEE_TIERS,
  PUMP_CURVE_FEE_BPS,
  PUMP_INITIAL_CURVE,
  spotPriceLamportsPerToken,
  tokenValueLamports,
  withSlippage,
  type FeeBps,
} from "./quote";

const SOL = 1_000_000_000n;

test("exactInNet is the largest net whose per-component ceil fees fit in the input", () => {
  const fees: FeeBps[] = [PUMP_CURVE_FEE_BPS, { lpBps: 2, protocolBps: 93, creatorBps: 30 }, { lpBps: 20, protocolBps: 5, creatorBps: 95 }];
  const cost = (net: bigint, f: FeeBps) => net + feeAmount(net, f.lpBps) + feeAmount(net, f.protocolBps) + feeAmount(net, f.creatorBps);
  for (const f of fees) {
    for (const input of [1n, 99n, 10_125n, 1_000_003n, 987_654_321n, 12_345_678_901n]) {
      const net = exactInNet(input, f);
      if (net === 0n) continue;
      assert.ok(cost(net, f) <= input, `fees fit for ${input}`);
      assert.ok(cost(net + 1n, f) > input, `net is maximal for ${input}`);
    }
  }
  assert.equal(exactInNet(0n, PUMP_CURVE_FEE_BPS), 0n);
});

test("1 SOL dev buy on a fresh curve (pump's exact-in math)", () => {
  const q = curveBuyQuote(PUMP_INITIAL_CURVE, SOL, PUMP_CURVE_FEE_BPS);
  // net = floor(1e9 × 10_000 / 10_125); 9,382,717 + 2,962,963 ceil fees make exactly 1 SOL
  assert.equal(q.netSol, 987_654_320n);
  assert.equal(q.feeLamports, 9_382_717n + 2_962_963n);
  assert.equal(q.creatorFeeLamports, 2_962_963n);
  assert.equal(q.tokensOut, 34_199_203_120_618n);
});

test("curve buys cap at real token reserves; sells never return more than was spent", () => {
  const whale = curveBuyQuote(PUMP_INITIAL_CURVE, 1_000n * SOL, PUMP_CURVE_FEE_BPS);
  assert.equal(whale.tokensOut, PUMP_INITIAL_CURVE.realBaseReserve);

  const buy = curveBuyQuote(PUMP_INITIAL_CURVE, 2n * SOL, PUMP_CURVE_FEE_BPS);
  const after = {
    ...PUMP_INITIAL_CURVE,
    baseReserve: PUMP_INITIAL_CURVE.baseReserve - buy.tokensOut,
    quoteReserve: PUMP_INITIAL_CURVE.quoteReserve + buy.netSol - 1n,
  };
  const sell = curveSellQuote(after, buy.tokensOut, PUMP_CURVE_FEE_BPS);
  assert.ok(sell.solOut < 2n * SOL);
  assert.ok(sell.rawSol <= buy.netSol);
  assert.equal(sell.feeLamports, feeAmount(sell.rawSol, 95) + feeAmount(sell.rawSol, 30));
  assert.equal(curveSellQuote(after, 0n, PUMP_CURVE_FEE_BPS).solOut, 0n);
});

test("pool quotes: constant product on the effective quote, sells bounded by the real quote", () => {
  const pool = { baseReserve: 200_000_000_000_000n, quoteReserve: 100n * SOL, realQuoteReserve: 100n * SOL };
  const fees = { lpBps: 2, protocolBps: 93, creatorBps: 30 };
  const buy = poolBuyQuote(pool, SOL, fees);
  assert.equal(buy.tokensOut, ((buy.netSol - 1n) * pool.baseReserve) / (pool.quoteReserve + buy.netSol - 1n));
  const sell = poolSellQuote(pool, 1_000_000_000_000n, fees);
  const raw = (pool.quoteReserve * 1_000_000_000_000n) / (pool.baseReserve + 1_000_000_000_000n);
  assert.equal(sell.rawSol, raw);
  assert.equal(sell.solOut, raw - feeAmount(raw, 2) - feeAmount(raw, 93) - feeAmount(raw, 30));
  // boosted pool: prices on more quote than the vault can pay out
  assert.throws(() => poolSellQuote({ ...pool, realQuoteReserve: raw / 2n }, 1_000_000_000_000n, fees));
});

test("fee tiers: highest threshold ≤ mcap, first tier below every threshold", () => {
  assert.equal(pickFeeTier(PUMP_AMM_FEE_TIERS, 0n).creatorBps, 30);
  assert.equal(pickFeeTier(PUMP_AMM_FEE_TIERS, 420n * SOL - 1n).creatorBps, 30);
  assert.equal(pickFeeTier(PUMP_AMM_FEE_TIERS, 420n * SOL).creatorBps, 95);
  assert.equal(pickFeeTier(PUMP_AMM_FEE_TIERS, 1_470n * SOL).creatorBps, 90);
  assert.equal(pickFeeTier(PUMP_AMM_FEE_TIERS, 10_000_000n * SOL).creatorBps, 5);
  const shifted = [{ thresholdLamports: 10n, fees: { lpBps: 1, protocolBps: 1, creatorBps: 7 } }];
  assert.equal(pickFeeTier(shifted, 0n).creatorBps, 7);
  assert.throws(() => pickFeeTier([], 0n));
});

test("estimateCreatorFees follows the schedule (fee-sharing.md §4 examples)", () => {
  // $1M-equivalent volume on the curve stage → 0.30%
  assert.deepEqual(estimateCreatorFees(1_000n * SOL, 50n * SOL), { creatorBps: 30, creatorLamports: 3n * SOL });
  assert.deepEqual(estimateCreatorFees(1_000n * SOL, 500n * SOL), { creatorBps: 95, creatorLamports: 9_500_000_000n });
  assert.equal(estimateCreatorFees(1_000n * SOL, 100_000n * SOL).creatorBps, 5);
  assert.equal(estimateCreatorFees(1_000n * SOL, 500n * SOL, { venue: "curve" }).creatorBps, 30);
});

test("price, value and market cap of a fresh curve", () => {
  assert.equal(marketCapLamports(PUMP_INITIAL_CURVE), 27_958_993_476n);
  assert.equal(tokenValueLamports(1_073_000_000n, PUMP_INITIAL_CURVE), 30_000n);
  assert.ok(Math.abs(spotPriceLamportsPerToken(PUMP_INITIAL_CURVE) - 27.958993476) < 1e-9);
  assert.equal(withSlippage(10_000n, 500), 9_500n);
  assert.equal(withSlippage(10_000n, 20_000), 0n);
});

const position = (over: Partial<Parameters<typeof allowedSell>[0]> = {}) => ({
  tokens: 1_000n,
  targetSnapshot: 5_000n,
  targetPeak: 5_000n,
  vaultPeak: 1_000n,
  openedAt: 1_000n,
  ...over,
});

test("allowedSell: proportional to the target's sell from its peak", () => {
  assert.equal(allowedSell(position(), 5_000n), 0n, "target unchanged");
  assert.equal(allowedSell(position({ targetSnapshot: 0n }), 0n), 1_000n, "target already empty at the last copy");
  assert.equal(allowedSell(position(), 6_000n), 0n, "target bought more");
  assert.equal(allowedSell(position(), 2_500n), 500n, "target sold half");
  assert.equal(allowedSell(position(), 0n), 1_000n, "target exited");
  assert.equal(allowedSell(position(), 3_333n), 1_000n - (1_000n * 3_333n) / 5_000n, "keep is floored");
  // after the vault already sold half on the first target sell, a second sell to 40% of peak
  const second = position({ tokens: 500n, targetSnapshot: 2_500n });
  assert.equal(allowedSell(second, 2_000n), 100n);
  // vault holds less than its proportional keep (e.g. partially failed earlier sells): nothing more
  assert.equal(allowedSell(position({ tokens: 300n, targetSnapshot: 2_500n }), 2_000n), 0n);
  assert.equal(allowedSell(position({ tokens: 0n }), 0n), 0n);
});

test("allowedSell: max hold releases everything regardless of the target", () => {
  const p = position({ openedAt: 1_000n });
  assert.equal(allowedSell(p, 5_000n, { nowTs: 1_000 + 604_800, maxHoldSecs: 604_800 }), 0n, "not strictly past max hold");
  assert.equal(allowedSell(p, 5_000n, { nowTs: 1_000 + 604_801, maxHoldSecs: 604_800 }), 1_000n);
});

test("profitSplit: only profit above the high-water mark is split 75 / 25", () => {
  // loss then win: −100 realized, HWM 0, then +300 → realized 200, excess 200
  const loss = profitSplit(0n, 0n, -100n);
  assert.deepEqual(loss, { realizedPnl: -100n, hwm: 0n, excess: 0n, toBuyback: 0n, toPlatform: 0n });
  const win = profitSplit(loss.realizedPnl, loss.hwm, 300n);
  assert.deepEqual(win, { realizedPnl: 200n, hwm: 200n, excess: 200n, toBuyback: 150n, toPlatform: 50n });
  // back under the HWM and up again to exactly the HWM: nothing new to split
  const dip = profitSplit(win.realizedPnl, win.hwm, -50n);
  assert.equal(profitSplit(dip.realizedPnl, dip.hwm, 50n).excess, 0n);
  // rounding (program: to_buyback = floor(excess × 75%), the remainder goes to the platform token)
  assert.deepEqual(profitSplit(0n, 0n, 3n), { realizedPnl: 3n, hwm: 3n, excess: 3n, toBuyback: 2n, toPlatform: 1n });
  // the platform token itself keeps 100% for its own buyback
  assert.deepEqual(profitSplit(0n, 0n, 1_000n, { selfBurn: true }).toBuyback, 1_000n);
});

test("spendWindowRemaining: cap on the window's starting equity, fresh window after spendWindowSecs", () => {
  const params = { spendWindowSecs: 3_600n, maxWindowSpendBps: 3_000 };
  const copier = { windowStart: 1_000n, windowSpent: 2n * SOL, windowEquity: 10n * SOL };
  // same window: 30% of the window's equity (not today's) minus what was spent
  assert.equal(spendWindowRemaining(copier, params, 50n * SOL, 1_000 + 3_599), 1n * SOL);
  // exactly spendWindowSecs later a new window starts on the current equity
  assert.equal(spendWindowRemaining(copier, params, 50n * SOL, 1_000 + 3_600), 15n * SOL);
  // overspent windows (equity fell) never go negative
  assert.equal(spendWindowRemaining({ ...copier, windowSpent: 4n * SOL }, params, 1n, 2_000), 0n);
  // a never-used copier (windowStart 0) opens its first window on the first buy
  assert.equal(spendWindowRemaining({ windowStart: 0n, windowSpent: 0n, windowEquity: 0n }, params, 10n * SOL, 1_759_500_000), 3n * SOL);
});

test("impact caps: max sol_in per trade and the largest permissionless sell slice", () => {
  const reserves = { ...PUMP_INITIAL_CURVE, quoteReserve: 40n * SOL, realQuoteReserve: 10n * SOL, impactQuoteReserve: 10n * SOL };
  assert.equal(impactCapLamports(reserves, 300), 300_000_000n);
  const n = publicSellMaxTokens(reserves, 300);
  const quote = (t: bigint) => (reserves.quoteReserve * t) / (reserves.baseReserve + t);
  assert.ok(quote(n) <= 300_000_000n, "slice stays within the impact cap");
  assert.ok(quote(n + 1n) > 300_000_000n, "slice is the largest such amount");
  assert.equal(publicSellMaxTokens({ ...reserves, impactQuoteReserve: 0n }, 300), 0n);
});
