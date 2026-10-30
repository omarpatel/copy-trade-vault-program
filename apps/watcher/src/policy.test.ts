import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProgramParams, VenueReserves } from "@copy-trade-vault/sdk";
import { decideBuy, decideSell, type BuyInput, type SellInput } from "./policy";

const SOL = 1_000_000_000n;
const TARGET = "Bi4rd5FH5bYEN8scZ7wevxNZyNmKHdaBcvewdPFxYdLt";
const TOKEN = "RrM6FkvmJ8kwyK2SEN6K9wNm3kX5jrV262ihQM1sF99";
const OWN_MINT = "9R8g8JtEqRAh5yZ4aXbf1mWcfgLq9kAo6fmx93MSK9k7";
const NOW = 1_790_000_000;

/** SPEC §2 default params. */
const PARAMS: ProgramParams = {
  maxTradeBps: 1_000,
  maxPositionBps: 2_000,
  maxOpenPositions: 12,
  minTradeLamports: 10_000_000n,
  minSignalLamports: 50_000_000n,
  signalMultipleBps: 10_000,
  maxImpactBps: 300,
  slippageBps: 500,
  vaultFloorLamports: 20_000_000n,
  maxHoldSecs: 604_800n,
  keeperGraceSecs: 3_600n,
  spendWindowSecs: 3_600n,
  maxWindowSpendBps: 3_000,
};

/** 50 SOL of real liquidity; price 50 lamports per 1,000 raw units, so 2e13 raw units are worth exactly 1 SOL. */
const RESERVES: VenueReserves = {
  kind: "curve",
  baseReserve: 1_000_000_000_000_000n,
  quoteReserve: 50n * SOL,
  realBaseReserve: 700_000_000_000_000n,
  realQuoteReserve: 50n * SOL,
  impactQuoteReserve: 50n * SOL,
  supply: 1_000_000_000_000_000n,
};

function buyInput(over: Partial<BuyInput> = {}, trade: Partial<BuyInput["trade"]> = {}): BuyInput {
  return {
    trade: {
      side: "buy",
      signer: true,
      target: TARGET,
      tokenMint: TOKEN,
      tokenDelta: 20_000_000_000_000n,
      solDelta: -1n * SOL,
      solBefore: 4n * SOL,
      blockTime: NOW - 2,
      isCreate: false,
      ...trade,
    },
    platformMint: OWN_MINT,
    params: PARAMS,
    venue: { kind: "curve", reserves: RESERVES, creatorWallets: ["11111111111111111111111111111111"] },
    equity: 10n * SOL,
    freeSol: 10n * SOL,
    position: null,
    openPositions: 0,
    // A window opened a minute ago on 10 SOL equity: 30% = 3 SOL budget, untouched.
    window: { windowStart: BigInt(NOW - 60), windowSpent: 0n, windowEquity: 10n * SOL },
    nowTs: NOW,
    knobs: { maxSignalAgeSecs: 90, convictionK: 4, convictionFloorBps: 2_500, deadQuoteLamports: SOL / 5n, reentryCooldownSecs: 120 },
    ...over,
  };
}

const skipReason = (input: BuyInput) => {
  const d = decideBuy(input);
  assert.equal(d.action, "skip", `expected a skip, got ${JSON.stringify(d, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`);
  return d.action === "skip" ? d.reason : null;
};

describe("decideBuy sizing", () => {
  it("full conviction: bound by the signal (target spend × multiple, 95% margin)", () => {
    const d = decideBuy(buyInput());
    assert.deepEqual(d, { action: "buy", solIn: 950_000_000n, signalLamports: SOL, convictionBps: 10_000, binding: "signal" });
  });

  it("bound by equity × max_trade when the target trades large", () => {
    const d = decideBuy(buyInput({}, { solDelta: -5n * SOL, tokenDelta: 100_000_000_000_000n, solBefore: 10n * SOL }));
    assert.equal(d.action, "buy");
    if (d.action === "buy") {
      assert.equal(d.binding, "trade_cap");
      assert.equal(d.solIn, SOL);
    }
  });

  it("low conviction (small share of the target's SOL) scales down to the floor", () => {
    const d = decideBuy(buyInput({}, { solBefore: 40n * SOL }));
    assert.equal(d.action, "buy");
    if (d.action === "buy") {
      assert.equal(d.convictionBps, 2_500);
      assert.equal(d.solIn, 237_500_000n);
    }
  });

  it("conviction never pushes a copy below min_trade when the caps allow it", () => {
    // Impact cap 1 SOL × 3% = 0.03 SOL; floor conviction 25% → 0.0075 SOL, lifted to min_trade (0.01 SOL).
    const venue = { kind: "curve" as const, reserves: { ...RESERVES, realQuoteReserve: SOL, impactQuoteReserve: SOL }, creatorWallets: [] };
    const d = decideBuy(buyInput({ venue }, { solBefore: 1_000n * SOL }));
    assert.equal(d.action, "buy");
    if (d.action === "buy") {
      assert.equal(d.binding, "impact_cap");
      assert.equal(d.convictionBps, 2_500);
      assert.equal(d.solIn, PARAMS.minTradeLamports);
    }
  });

  it("anti-bait: a big token increase bought with little SOL can only pull a copy that small", () => {
    // 5 SOL worth of tokens at spot, but the target paid 0.06 SOL for them.
    const d = decideBuy(buyInput({}, { tokenDelta: 100_000_000_000_000n, solDelta: -60_000_000n, solBefore: 60_000_000n }));
    assert.equal(d.action, "buy");
    if (d.action === "buy") {
      assert.equal(d.signalLamports, 60_000_000n);
      assert.equal(d.solIn, 57_000_000n);
    }
  });

  it("signal is the spot value of the increase when it is below what the target paid (fees, slippage, rent)", () => {
    const d = decideBuy(buyInput({}, { tokenDelta: 10_000_000_000_000n }));
    assert.equal(d.action, "buy");
    if (d.action === "buy") assert.equal(d.signalLamports, 500_000_000n);
  });

  it("bound by the remaining spend window (rent allowance held back)", () => {
    // 30% of the window's 10 SOL = 3 SOL; 2.9 SOL spent; 0.01 SOL kept for the rent the program counts as spend.
    const d = decideBuy(buyInput({ window: { windowStart: BigInt(NOW - 600), windowSpent: 2_900_000_000n, windowEquity: 10n * SOL } }));
    assert.equal(d.action, "buy");
    if (d.action === "buy") {
      assert.equal(d.binding, "spend_window");
      assert.equal(d.solIn, 90_000_000n);
    }
  });

  it("an expired window does not bind: the next buy opens a new one on current equity", () => {
    const d = decideBuy(buyInput({ window: { windowStart: BigInt(NOW - 3_600), windowSpent: 3n * SOL, windowEquity: 10n * SOL } }));
    assert.equal(d.action, "buy");
    if (d.action === "buy") assert.equal(d.binding, "signal");
  });
});

describe("decideBuy skip reasons", () => {
  it("airdrops and unsigned increases", () => {
    assert.equal(skipReason(buyInput({}, { side: "airdrop", signer: false })), "not_signer");
  });
  it("transfers in are not trades", () => {
    assert.equal(skipReason(buyInput({}, { side: "transfer_in" })), "not_a_trade");
  });
  it("stale signal (backfill after downtime)", () => {
    assert.equal(skipReason(buyInput({}, { blockTime: NOW - 600 })), "stale_signal");
  });
  it("own mint", () => {
    assert.equal(skipReason(buyInput({}, { tokenMint: OWN_MINT })), "own_mint");
  });
  it("unsupported venues map to their specific reasons", () => {
    assert.equal(skipReason(buyInput({ venue: { kind: "unsupported", code: "mayhem" } })), "mayhem");
    assert.equal(skipReason(buyInput({ venue: { kind: "unsupported", code: "migrating" } })), "migrating");
    assert.equal(skipReason(buyInput({ venue: { kind: "unsupported", code: "non_sol_quote" } })), "non_sol_quote");
    assert.equal(skipReason(buyInput({ venue: { kind: "unsupported", code: "no_venue" } })), "unsupported_venue");
  });
  it("target is the coin's creator or a fee shareholder; or the buy is its own launch", () => {
    assert.equal(skipReason(buyInput({ venue: { kind: "curve", reserves: RESERVES, creatorWallets: ["sc", TARGET] } })), "target_is_creator");
    assert.equal(skipReason(buyInput({}, { isCreate: true })), "target_is_creator");
  });
  it("dead token (no real liquidity)", () => {
    assert.equal(skipReason(buyInput({ venue: { kind: "pool", reserves: { ...RESERVES, realQuoteReserve: SOL / 10n }, creatorWallets: [] } })), "token_dead");
  });
  it("signal below min_signal", () => {
    assert.equal(skipReason(buyInput({}, { solDelta: -10_000_000n })), "signal_below_min");
  });
  it("max open positions (only for a new position)", () => {
    assert.equal(skipReason(buyInput({ openPositions: 12 })), "max_positions");
    const adding = decideBuy(buyInput({ openPositions: 12, position: { cost: SOL / 2n, lastTradeTs: BigInt(NOW - 3_600), target: TARGET } }));
    assert.equal(adding.action, "buy");
  });
  it("repeat buy within the re-entry cooldown", () => {
    assert.equal(skipReason(buyInput({ position: { cost: SOL / 2n, lastTradeTs: BigInt(NOW - 30), target: TARGET } })), "reentry_cooldown");
  });
  it("index copier: a token whose position follows another basket wallet is skipped before simulation", () => {
    const other = "11111111111111111111111111111112";
    assert.equal(skipReason(buyInput({ position: { cost: SOL / 2n, lastTradeTs: BigInt(NOW - 3_600), target: other } })), "held_by_other_target");
  });
  it("position cap reached", () => {
    assert.equal(skipReason(buyInput({ position: { cost: 2n * SOL, lastTradeTs: BigInt(NOW - 3_600), target: TARGET } })), "position_cap");
  });
  it("impact cap on a thin venue", () => {
    // The program caps against the curve's real SOL (pool: the quote vault balance), not the un-swept-net value.
    const thin = { ...RESERVES, realQuoteReserve: 300_000_000n, impactQuoteReserve: 300_000_000n };
    assert.equal(skipReason(buyInput({ venue: { kind: "curve", reserves: thin, creatorWallets: [] } })), "impact_cap");
  });
  it("vault floor: free SOL minus floor and rent allowance is below min_trade", () => {
    assert.equal(skipReason(buyInput({ freeSol: 35_000_000n, equity: 10n * SOL })), "vault_floor");
  });
  it("trade cap on a tiny vault", () => {
    assert.equal(skipReason(buyInput({ equity: 50_000_000n, freeSol: 50_000_000n })), "trade_cap");
  });
  it("spend window exhausted", () => {
    assert.equal(skipReason(buyInput({ window: { windowStart: BigInt(NOW - 600), windowSpent: 2_995_000_000n, windowEquity: 10n * SOL } })), "spend_window");
  });
});

describe("decideSell (allowedSell)", () => {
  const position = {
    // 2e13 raw units = 1 SOL at RESERVES' spot.
    tokens: 20_000_000_000_000n,
    targetSnapshot: 2_000_000n,
    targetPeak: 2_000_000n,
    vaultPeak: 20_000_000_000_000n,
    openedAt: BigInt(NOW - 3_600),
  };
  const sell = (over: Partial<SellInput>) =>
    decideSell({ position, targetNow: 2_000_000n, nowTs: NOW, maxHoldSecs: PARAMS.maxHoldSecs, reserves: RESERVES, ...over });

  it("no position", () => {
    assert.deepEqual(sell({ position: null }), { action: "skip", reason: "no_position", detail: "the vault holds none of this token" });
  });
  it("target still holds its snapshot: nothing to sell", () => {
    const d = sell({});
    assert.equal(d.action, "skip");
    if (d.action === "skip") assert.equal(d.reason, "nothing_to_sell");
  });
  it("target sold 40%: the vault sells the same fraction of its peak", () => {
    assert.deepEqual(sell({ targetNow: 1_200_000n }), { action: "sell", tokensIn: 8_000_000_000_000n, forced: false });
  });
  it("target sold everything: the vault sells everything", () => {
    assert.deepEqual(sell({ targetNow: 0n }), { action: "sell", tokensIn: 20_000_000_000_000n, forced: false });
  });
  it("after an earlier partial sell, converges to the target's remaining fraction", () => {
    const after = { ...position, tokens: 12_000_000_000_000n, targetSnapshot: 1_200_000n };
    assert.deepEqual(sell({ position: after, targetNow: 500_000n }), { action: "sell", tokensIn: 7_000_000_000_000n, forced: false });
  });
  it("max hold elapsed: everything, regardless of the target", () => {
    assert.deepEqual(sell({ nowTs: Number(position.openedAt) + 604_801 }), { action: "sell", tokensIn: 20_000_000_000_000n, forced: true });
  });
  it("a partial sell worth dust waits", () => {
    // 1 raw unit of the target's 2,000,000 → 10,000,000 raw units of the vault's, worth 500 lamports.
    const d = sell({ targetNow: 1_999_999n });
    assert.equal(d.action, "skip");
    if (d.action === "skip") assert.equal(d.reason, "nothing_to_sell");
  });
});
