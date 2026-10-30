import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { profitSplit, tokenValueLamports, type VenueReserves } from "@copy-trade-vault/sdk";
import {
  bucketLast,
  copyLag,
  exitValueLamports,
  foldCandle,
  markPosition,
  median,
  mergeCandles,
  replayHwm,
  sparkline,
  splitDistribution,
  targetWeights,
  vaultBook,
} from "./aggregate";

const SOL = 1_000_000_000n;

describe("vaultBook", () => {
  test("matches the program's free_sol / equity and marks positions", () => {
    // 5 SOL on the vault + 0.5 wSOL, 0.3 earmarked for buyback, 0.1 pending for the platform token, two positions costing 1.2 SOL.
    const book = vaultBook({
      vaultLamports: 5n * SOL,
      wsol: SOL / 2n,
      rent: 890_880n,
      buybackPool: (3n * SOL) / 10n,
      platformPending: SOL / 10n,
      openCost: (12n * SOL) / 10n,
      positions: [
        { cost: SOL, value: (15n * SOL) / 10n },
        { cost: (2n * SOL) / 10n, value: null },
      ],
    });
    const free = 5n * SOL + SOL / 2n - 890_880n - (3n * SOL) / 10n - SOL / 10n;
    assert.equal(book.free, free);
    assert.equal(book.equity, free + (12n * SOL) / 10n);
    // Unpriced position counts at cost: NAV = free + 1.5 + 0.2.
    assert.equal(book.nav, free + (17n * SOL) / 10n);
    assert.equal(book.unrealized, SOL / 2n);
  });

  test("open cost not covered by fetched positions still counts at cost; free never negative", () => {
    const book = vaultBook({ vaultLamports: 1_000n, wsol: 0n, rent: 890_880n, buybackPool: 0n, platformPending: 0n, openCost: 7n * SOL, positions: [] });
    assert.equal(book.free, 0n);
    assert.equal(book.nav, 7n * SOL);
    assert.equal(book.equity, 7n * SOL);
  });
});

describe("markPosition", () => {
  test("unrealized PnL and share of NAV", () => {
    const m = markPosition(2n * SOL, (3n * SOL) / 2n, 10n * SOL);
    assert.equal(m.unrealized, -SOL / 2n);
    assert.equal(m.unrealizedBps, -2_500);
    assert.equal(m.pctOfEquityBps, 1_500);
  });
  test("no mark: no PnL, exposure at cost", () => {
    const m = markPosition(SOL, null, 4n * SOL);
    assert.equal(m.unrealized, null);
    assert.equal(m.unrealizedBps, null);
    assert.equal(m.pctOfEquityBps, 2_500);
  });
});

describe("copyLag", () => {
  test("block-time difference in ms and slot distance", () => {
    assert.deepEqual(copyLag({ blockTime: 1_759_560_000, slot: 370_000_000 }, { blockTime: 1_759_560_002, slot: 370_000_005 }), {
      lagMs: 2_000,
      lagSlots: 5,
    });
  });
  test("same-second copies have 0ms lag; leader clock skew clamps to 0", () => {
    assert.equal(copyLag({ blockTime: 100, slot: 10 }, { blockTime: 100, slot: 11 }).lagMs, 0);
    assert.equal(copyLag({ blockTime: 101, slot: 10 }, { blockTime: 100, slot: 11 }).lagMs, 0);
  });
  test("unknown block time → null lag", () => {
    assert.deepEqual(copyLag({ blockTime: null, slot: 10 }, { blockTime: 100, slot: null }), { lagMs: null, lagSlots: null });
  });
  test("median of lags", () => {
    assert.equal(median([3000, 1000, 2000]), 2000);
    assert.equal(median([1000, 2000]), 1500);
    assert.equal(median([]), null);
  });
});

describe("replayHwm", () => {
  test("loss then win: only profit above the previous high-water mark splits", () => {
    const steps = replayHwm([
      { ts: 1, pnl: 2n * SOL }, // realized 2, hwm 2, excess 2
      { ts: 2, pnl: -3n * SOL }, // realized -1, hwm 2
      { ts: 3, pnl: 2n * SOL }, // realized 1 < hwm: nothing splits
      { ts: 4, pnl: 3n * SOL }, // realized 4, excess 2
    ]);
    assert.deepEqual(
      steps.map((s) => [s.realized, s.hwm, s.excess]),
      [
        [2n * SOL, 2n * SOL, 2n * SOL],
        [-SOL, 2n * SOL, 0n],
        [SOL, 2n * SOL, 0n],
        [4n * SOL, 4n * SOL, 2n * SOL],
      ],
    );
  });

  test("agrees with the SDK's per-sell profitSplit (the program rule)", () => {
    const pnls = [5n, -7n, 1n, 9n, -2n, 4n].map((x) => x * 10_000_000n);
    let realized = 0n;
    let hwm = 0n;
    const steps = replayHwm(pnls.map((pnl, ts) => ({ ts, pnl })));
    pnls.forEach((pnl, i) => {
      const s = profitSplit(realized, hwm, pnl);
      assert.equal(steps[i]!.realized, s.realizedPnl);
      assert.equal(steps[i]!.hwm, s.hwm);
      assert.equal(steps[i]!.excess, s.excess);
      realized = s.realizedPnl;
      hwm = s.hwm;
    });
  });
});

describe("splitDistribution", () => {
  const vault = "VauLt11111111111111111111111111111111111111";
  const target = "TargeT1111111111111111111111111111111111111";
  const ev = {
    distributed: 1_000_000_001n,
    shareholders: [
      { address: target, shareBps: 2_000 },
      { address: vault, shareBps: 8_000 },
    ],
  };

  test("uses observed balance deltas when they are pure credits", () => {
    const deltas: Record<string, bigint> = { [target]: 200_000_000n, [vault]: 800_000_001n };
    const s = splitDistribution(ev, (a) => deltas[a] ?? null, vault, [target]);
    assert.equal(s.toTargets, 200_000_000n);
    assert.equal(s.toVault, 800_000_001n);
  });

  test("falls back to pro-rata when the shareholder also paid (negative delta) or is absent", () => {
    const deltas: Record<string, bigint> = { [target]: -5_000n };
    const s = splitDistribution(ev, (a) => deltas[a] ?? null, vault, [target]);
    assert.equal(s.toTargets, 200_000_000n);
    assert.equal(s.toVault, 800_000_000n);
    assert.deepEqual(
      s.shares.map((x) => x.role),
      ["target", "vault"],
    );
  });
});

describe("series", () => {
  test("bucketLast keeps the last value per bucket", () => {
    assert.deepEqual(
      bucketLast(
        [
          [0, "a"],
          [10, "b"],
          [15, "c"],
          [44, "d"],
        ],
        15,
      ),
      [
        [0, "b"],
        [15, "c"],
        [30, "d"],
      ],
    );
  });

  test("sparkline carries values forward and skips time before the first sample", () => {
    const pts: [number, number][] = [
      [50, 5],
      [80, 8],
    ];
    // Samples at t = 0, 25, 50, 75, 100: nothing known before 50, then 5 carried to 75, 8 at 100.
    assert.deepEqual(sparkline(pts, 0, 100, 5), [5, 5, 8]);
    assert.deepEqual(sparkline([], 0, 100, 5), []);
  });

  test("foldCandle opens a new bucket and tracks high/low/close", () => {
    let c = foldCandle(null, 60, 10, "100");
    c = foldCandle(c, 60, 12, "120");
    c = foldCandle(c, 60, 9, null);
    assert.deepEqual(c, { t: 60, o: 10, h: 12, l: 9, c: 9, mcap: "120" });
    assert.deepEqual(foldCandle(c, 120, 11, "110"), { t: 120, o: 11, h: 11, l: 11, c: 11, mcap: "110" });
  });

  test("mergeCandles rolls 1m candles into 5m", () => {
    const m = mergeCandles(
      [
        { t: 300, o: 1, h: 2, l: 1, c: 2, mcap: "1" },
        { t: 360, o: 2, h: 5, l: 0.5, c: 3, mcap: "2" },
        { t: 600, o: 3, h: 3, l: 3, c: 3, mcap: null },
      ],
      300,
    );
    assert.deepEqual(m, [
      { t: 300, o: 1, h: 5, l: 0.5, c: 3, mcap: "2" },
      { t: 600, o: 3, h: 3, l: 3, c: 3, mcap: null },
    ]);
  });
});

describe("targetWeights", () => {
  test("share of open cost by target; rounding remainder to the first; equal split when flat", () => {
    assert.deepEqual(
      targetWeights(
        ["a", "b", "c"],
        [
          { target: "a", cost: 1n },
          { target: "b", cost: 1n },
          { target: "c", cost: 1n },
        ],
      ),
      [3_334, 3_333, 3_333],
    );
    assert.deepEqual(targetWeights(["a", "b"], []), [5_000, 5_000]);
    assert.deepEqual(targetWeights(["a", "b"], [{ target: "b", cost: 3n }]), [0, 10_000]);
  });
});

describe("exitValueLamports (positions marked at exit, not spot)", () => {
  const fee = { lpBps: 0, protocolBps: 95, creatorBps: 30 };
  // A thin curve: 30 SOL virtual quote against 1.073e15 virtual tokens (a fresh pump curve).
  const curve: VenueReserves = {
    kind: "curve",
    baseReserve: 1_073_000_000_000_000n,
    quoteReserve: 30n * SOL,
    realBaseReserve: 793_100_000_000_000n,
    realQuoteReserve: 0n,
    supply: 1_000_000_000_000_000n,
    impactQuoteReserve: 0n,
  } as VenueReserves;

  test("a large position on a thin curve is worth less than spot by its price impact plus fees", () => {
    const tokens = 200_000_000_000_000n; // ~19% of the virtual token reserve
    const spot = tokenValueLamports(tokens, curve);
    const exit = exitValueLamports(tokens, curve, fee);
    const raw = (tokens * curve.quoteReserve) / (curve.baseReserve + tokens); // constant-product output
    // pump rounds each fee up.
    const ceil = (x: bigint, bps: bigint) => (x * bps + 9_999n) / 10_000n;
    assert.equal(exit, raw - ceil(raw, 95n) - ceil(raw, 30n));
    assert.ok(exit < spot);
    // Impact alone is ≈ tokens / (base + tokens) ≈ 15.7% of spot here.
    assert.ok(Number(spot - raw) / Number(spot) > 0.15);
  });

  test("a tiny position is worth ≈ spot × (1 − fee)", () => {
    const tokens = 1_000_000_000n; // 1000 tokens
    const spot = tokenValueLamports(tokens, curve);
    const exit = exitValueLamports(tokens, curve, fee);
    const expected = (spot * (10_000n - 125n)) / 10_000n;
    assert.ok(exit <= expected && expected - exit <= 2n, `${exit} vs ${expected}`);
  });

  test("a pool that can't pay the full output pays at most its real quote", () => {
    const pool = { ...curve, kind: "pool", baseReserve: 1_000_000_000n, quoteReserve: 10n * SOL, realQuoteReserve: SOL } as VenueReserves;
    const poolFee = { lpBps: 20, protocolBps: 5, creatorBps: 5 };
    const exit = exitValueLamports(1_000_000_000n, pool, poolFee);
    const raw = (SOL * 10_000n) / 9_980n;
    const ceil = (x: bigint, bps: bigint) => (x * bps + 9_999n) / 10_000n;
    assert.equal(exit, raw - ceil(raw, 20n) - ceil(raw, 5n) - ceil(raw, 5n));
    assert.ok(exit < 5n * SOL);
  });

  test("an empty position is worth nothing", () => {
    assert.equal(exitValueLamports(0n, curve, fee), 0n);
  });
});
