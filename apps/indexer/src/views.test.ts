import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { parseCopierEvents, PUMP_TOKEN_TOTAL_SUPPLY, vaultPda } from "@copy-trade-vault/sdk";
import { PublicKey } from "@solana/web3.js";
import { applyEvent, Effects } from "./apply";
import { copierMemoTarget } from "./chain-logs";
import { Store, type CopierState, type TargetTradeRow } from "./db";
import { Directory } from "./directory";
import { copierTxLogs } from "./testing";
import { changeSummary, spendWindowOf, Views } from "./views";

const key = (n: number) => new PublicKey(Buffer.alloc(32, n)).toBase58();
const sig = (n: number) => `${"5".repeat(80)}${String(n).padStart(8, "1").replace(/0/g, "z")}`;

const MINT = key(1);
const LAUNCHER = key(2);
const TOKEN = key(3);
const SHARING = key(4);
const PLATFORM_TOKEN = key(5);
const KEEPER = key(6);
/** clukz, a VERIFIED directory entry (kols.json). */
const TARGET = "G6fUXjMKPJzCY1rveAE6Qm7wy5U3vZgKDJmN1VPAdiZC";
const VAULT = vaultPda(new PublicKey(MINT)).toBase58();
const NOW = 1_759_560_000;
const SOL = 1_000_000_000n;

let store: Store;
let views: Views;
let slot = 1_000;

/** Runs `logs` through the same path as the sync: SDK event parser → memo → applyEvent → tx row. */
function ingestTx(signature: string, logs: string[], blockTime: number): Effects {
  const fx = new Effects();
  const events = parseCopierEvents(logs);
  const ctx = { signature, slot: ++slot, memoTarget: copierMemoTarget(logs) };
  store.tx(() => {
    events.forEach((ev, i) => applyEvent(store, ctx, i, ev, fx));
    store.markTx(signature, ctx.slot, blockTime, false, events.length);
  });
  views.invalidate();
  return fx;
}

function state(over: Partial<CopierState> = {}): CopierState {
  return {
    kind: "single",
    launcher: LAUNCHER,
    targets: JSON.stringify([TARGET]),
    trader_bps: 2_000,
    verified: 0,
    created_at: NOW - 3_600,
    sharing_config: SHARING,
    accounted: "0",
    fees_in: "0",
    capital_in: "0",
    open_cost: "0",
    open_positions: 0,
    realized_pnl: "0",
    hwm: "0",
    buyback_pool: "0",
    platform_sent: "0",
    burned: "0",
    buyback_spent: "0",
    platform_pending: "0",
    window_start: 0,
    window_spent: "0",
    window_equity: "0",
    trades: 0,
    last_keeper_ts: 0,
    graduated_pool: null,
    ...over,
  };
}

function keeperReport(over: Partial<TargetTradeRow>): TargetTradeRow {
  return {
    copier: MINT,
    signature: sig(900),
    target: TARGET,
    slot: 990,
    block_time: NOW - 100,
    side: "buy",
    token_mint: TOKEN,
    token_delta: "35000000000",
    sol_delta: "-1000000000",
    target_sol_before: "50000000000",
    price: 0.0286,
    venue: "curve",
    status: "copied",
    reason: null,
    error: null,
    vault_sig: null,
    vault_sol_in: "100000000",
    vault_tokens_in: null,
    detected_at: (NOW - 100) * 1000 + 350,
    decided_at: (NOW - 100) * 1000 + 420,
    source: "keeper",
    received_at: NOW - 99,
    ...over,
  };
}

function register(): void {
  ingestTx(
    sig(1),
    copierTxLogs([
      {
        name: "CopierRegistered",
        data: { mint: MINT, launcher: LAUNCHER, kind: "single", targets: [TARGET], traderBps: 2_000, sharingConfig: SHARING, ts: NOW - 3_600 },
      },
    ]),
    NOW - 3_600,
  );
}

beforeEach(() => {
  store = new Store(":memory:");
  views = new Views(store, new Directory({ snapshotFile: null }), () => NOW);
  slot = 1_000;
});

describe("event ingestion", () => {
  test("CopierRegistered creates the copier with its vault PDA and directory-resolved target", () => {
    register();
    const [m] = views.summaries();
    assert.equal(m?.mint, MINT);
    assert.equal(m?.vault, VAULT);
    assert.equal(m?.kind, "single");
    assert.equal(m?.traderBps, 2_000);
    assert.deepEqual(m?.targets, [
      {
        address: TARGET,
        name: "clukz",
        handle: "clukzSOL",
        xUrl: "https://x.com/clukzSOL",
        displayName: null,
        avatar: null,
        followers: null,
        followersOn: null,
        sources: ["curated"],
        verified: false,
      },
    ]);
  });

  test("copier search accepts the trader's @handle as the search box suggests, and $TICKER", () => {
    register();
    const mints = (q: string) => views.list({ sort: "new", kind: null, q }).map((m) => m.mint);
    assert.deepEqual(mints("@clukzSOL"), [MINT]);
    assert.deepEqual(mints("clukzsol"), [MINT]);
    assert.deepEqual(mints("@nobody"), []);
  });

  test("TraderVerified sets and clears the target's bit", () => {
    register();
    ingestTx(sig(2), copierTxLogs([{ name: "TraderVerified", data: { mint: MINT, target: TARGET, verified: true, ts: NOW - 3_000 } }]), NOW - 3_000);
    assert.equal(views.summary(MINT)?.verifiedMask, 1);
    assert.equal(views.summary(MINT)?.targets[0]?.verified, true);
    ingestTx(sig(3), copierTxLogs([{ name: "TraderVerified", data: { mint: MINT, target: TARGET, verified: false, ts: NOW - 2_000 } }]), NOW - 2_000);
    assert.equal(views.summary(MINT)?.verifiedMask, 0);
  });

  test("replaying the same transaction books nothing twice", () => {
    register();
    const logs = copierTxLogs([{ name: "Deposited", data: { mint: MINT, from: LAUNCHER, lamports: 30n * SOL, ts: NOW - 500 } }]);
    ingestTx(sig(4), logs, NOW - 500);
    const again = new Effects();
    store.tx(() => parseCopierEvents(logs).forEach((ev, i) => applyEvent(store, { signature: sig(4), slot: 1, memoTarget: null }, i, ev, again)));
    assert.equal(again.deposits.length, 0);
    assert.equal(store.depositsTotal(MINT), (30n * SOL).toString());
  });
});

describe("copies and lag", () => {
  const buyLogs = (memo: string | undefined) =>
    copierTxLogs(
      [
        {
          name: "CopierBuy",
          data: {
            mint: MINT,
            target: TARGET,
            tokenMint: TOKEN,
            venue: "curve",
            solIn: 100_000_000n,
            tokensOut: 3_480_000_000n,
            targetBalance: 35_000_000_000n,
            signalLamports: 1_000_000_000n,
            equity: 2n * SOL,
            ts: NOW - 98,
          },
        },
      ],
      memo,
    );

  test("vault tx memo links the keeper's report; lag = vault block time − target block time", () => {
    register();
    store.upsertTargetTrade(keeperReport({}));
    const fx = ingestTx(sig(10), buyLogs(`copier:${sig(900)}`), NOW - 98);
    assert.equal(fx.trades.length, 1);
    const [copy] = views.copies(MINT, 10);
    assert.equal(copy?.status, "copied");
    assert.equal(copy?.vaultSig, sig(10));
    assert.equal(copy?.lagMs, 2_000);
    assert.equal(copy?.lagSlots, slot - 990);
    assert.equal(copy?.targetSolLamports, "1000000000");
    assert.equal(copy?.vaultSolLamports, "100000000");
    assert.equal(copy?.sizeBps, 1_000);
    assert.equal(copy?.target.name, "clukz");
    assert.equal(views.summary(MINT)?.lagP50Ms, 2_000);
    assert.equal(views.stats().avgLagMs, 2_000);
  });

  test("a reported copy whose vault tx is not indexed yet is pending; skips carry their reason", () => {
    register();
    store.upsertTargetTrade(keeperReport({ vault_sig: sig(11) }));
    store.upsertTargetTrade(keeperReport({ signature: sig(901), slot: 989, status: "skipped", reason: "signal_below_min", vault_sol_in: null }));
    const copies = views.copies(MINT, 10);
    assert.deepEqual(
      copies.map((c) => [c.id, c.targetSig, c.status, c.reason, c.lagMs]),
      [
        [`${MINT}:${sig(900)}:${TOKEN}`, sig(900), "pending", null, null],
        [`${MINT}:${sig(901)}:${TOKEN}`, sig(901), "skipped", "signal_below_min", null],
      ],
    );
    assert.equal(views.summary(MINT)?.copies24h, 1);
    assert.equal(views.summary(MINT)?.skipped24h, 1);
  });

  test("a two-leg target tx (sell A, buy B) keeps one row per token leg, each linked to its own vault trade", () => {
    register();
    const OTHER = key(8);
    store.upsertTargetTrade(keeperReport({ side: "sell", token_mint: TOKEN, token_delta: "-35000000000", sol_delta: "900000000", status: "skipped", reason: "no_position", vault_sol_in: null }));
    store.upsertTargetTrade(keeperReport({ side: "buy", token_mint: OTHER, vault_sig: sig(14) }));
    ingestTx(
      sig(14),
      copierTxLogs(
        [
          {
            name: "CopierBuy",
            data: { mint: MINT, target: TARGET, tokenMint: OTHER, venue: "curve", solIn: 100_000_000n, tokensOut: 1n, targetBalance: 1n, signalLamports: 1n, equity: SOL, ts: NOW - 99 },
          },
        ],
        `copier:${sig(900)}`,
      ),
      NOW - 99,
    );
    const legs = views.copies(MINT, 10);
    assert.deepEqual(
      legs.map((c) => [c.id, c.side, c.tokenMint, c.status, c.reason, c.vaultSig]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      [
        [`${MINT}:${sig(900)}:${OTHER}`, "buy", OTHER, "copied", null, sig(14)],
        [`${MINT}:${sig(900)}:${TOKEN}`, "sell", TOKEN, "skipped", "no_position", null],
      ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    );
    assert.equal(views.copy(MINT, sig(900), OTHER)?.lagMs, 1_000);
    assert.equal(store.tradesMissingTargets(10).length, 0);
  });

  test("24h counters include reports whose target block time is not known yet", () => {
    register();
    store.upsertTargetTrade(keeperReport({ block_time: null, received_at: NOW - 10, vault_sig: sig(15) }));
    store.upsertTargetTrade(keeperReport({ signature: sig(902), block_time: null, received_at: NOW - 10, status: "skipped", reason: "trade_cap", vault_sol_in: null }));
    store.upsertTargetTrade(keeperReport({ signature: sig(903), block_time: null, received_at: NOW - 2 * 86_400, status: "skipped", reason: "trade_cap", vault_sol_in: null }));
    views.invalidate();
    assert.equal(views.summary(MINT)?.copies24h, 1);
    assert.equal(views.summary(MINT)?.skipped24h, 1);
    assert.equal(views.stats().copies24h, 1);
    assert.equal(views.stats().skipped24h, 1);
  });

  test("a memo-rebuilt row never overwrites a keeper report; a keeper report overwrites a memo row", () => {
    register();
    store.upsertTargetTrade(keeperReport({ source: "memo", detected_at: null, decided_at: null }));
    store.upsertTargetTrade(keeperReport({ status: "failed", reason: "send_failed", error: "blockhash expired" }));
    assert.equal(views.copies(MINT, 1)[0]?.status, "failed");
    store.upsertTargetTrade(keeperReport({ source: "memo", status: "copied" }));
    assert.equal(views.copies(MINT, 1)[0]?.status, "failed");
  });

  test("forced exits answer no target trade even with a memo", () => {
    register();
    ingestTx(
      sig(12),
      copierTxLogs(
        [
          {
            name: "CopierSell",
            data: {
              mint: MINT,
              target: TARGET,
              tokenMint: TOKEN,
              venue: "curve",
              tokensIn: 1n,
              solOut: 1n,
              costRemoved: 1n,
              pnl: 0n,
              realizedPnl: 0n,
              hwm: 0n,
              forced: true,
              ts: NOW,
            },
          },
        ],
        `copier:${sig(900)}`,
      ),
      NOW,
    );
    assert.equal(store.trade(sig(12), 0)?.target_sig, null);
  });
});

describe("PnL and HWM views", () => {
  test("loss then win: pnl history, HWM gap, profit split feed item", () => {
    register();
    const sell = (n: number, pnl: bigint, realized: bigint, hwm: bigint, ts: number, split?: { excess: bigint }) =>
      ingestTx(
        sig(n),
        copierTxLogs([
          {
            name: "CopierSell",
            data: { mint: MINT, target: TARGET, tokenMint: TOKEN, venue: "pool", tokensIn: 10n, solOut: 10n, costRemoved: 10n, pnl, realizedPnl: realized, hwm, forced: false, ts },
          },
          ...(split
            ? [
                {
                  name: "ProfitSplit" as const,
                  data: { mint: MINT, excess: split.excess, toBuyback: (split.excess * 3n) / 4n, toPlatform: split.excess - (split.excess * 3n) / 4n, ts },
                },
              ]
            : []),
        ]),
        ts,
      );
    sell(20, 2n * SOL, 2n * SOL, 2n * SOL, NOW - 300, { excess: 2n * SOL });
    sell(21, -3n * SOL, -SOL, 2n * SOL, NOW - 200);
    store.setCopierState(MINT, 5_000, state({ realized_pnl: (-SOL).toString(), hwm: (2n * SOL).toString(), fees_in: (4n * SOL).toString() }));
    views.invalidate();
    const d = views.detail(MINT)!;
    assert.deepEqual(d.pnlHistory, [
      [NOW - 300, (2n * SOL).toString(), (2n * SOL).toString()],
      [NOW - 200, (-SOL).toString(), (2n * SOL).toString()],
    ]);
    assert.equal(d.hwmGapLamports, (3n * SOL).toString());
    assert.equal(d.pnlBps, -2_500);
    const profit = views.feed({ mint: MINT, types: new Set(["profit"]), limit: 10 });
    assert.equal(profit.length, 1);
    assert.equal(profit[0]?.type === "profit" && profit[0].data.toPlatformLamports, (SOL / 2n).toString());
  });

  test("pnlHistory is capped: many sells are downsampled to the last sell per bucket", () => {
    register();
    store.tx(() => {
      for (let i = 0; i < 1_200; i++) {
        store.insertTrade({
          signature: sig(10_000 + i), event_index: 0, slot: 10_000 + i, ts: NOW - 1_200 + i, copier: MINT, side: "sell", target: TARGET,
          token_mint: TOKEN, venue: "curve", sol: "1", tokens: "1", cost_removed: "1", pnl: "1", realized_pnl: String(i + 1), hwm: String(i + 1),
          forced: 0, equity: null, signal: null, target_balance: null, target_sig: null,
        });
      }
    });
    const h = views.detail(MINT)!.pnlHistory;
    assert.ok(h.length <= 500, `${h.length} points`);
    assert.ok(h.length >= 400);
    assert.deepEqual(h[h.length - 1], [NOW - 1, "1200", "1200"]);
    for (let i = 1; i < h.length; i++) assert.ok(h[i]![0] > h[i - 1]![0]);
  });
});

describe("candles", () => {
  test("retention folds 1-minute candles older than the cutoff into hourly candles", () => {
    const hour = 1_759_557_600; // aligned to 3600
    for (let m = 0; m < 60; m++) {
      store.upsertCandle({ mint: MINT, t: hour + m * 60, o: 10 + m, h: 20 + m, l: 5 + m, c: 11 + m, mcap: m === 59 ? null : String(m), nav: String(1000 + m) });
    }
    store.upsertCandle({ mint: MINT, t: hour + 3_600, o: 1, h: 1, l: 1, c: 1, mcap: "x", nav: "y" });
    assert.equal(store.compactCandles(hour + 3_600, 3_600), 59);
    assert.equal(store.compactCandles(hour + 3_600, 3_600), 0);
    const rows = store.candlesSince(MINT, 0);
    assert.deepEqual(rows.map((c) => [c.t, c.o, c.h, c.l, c.c, c.mcap, c.nav]), [
      [hour, 10, 79, 5, 70, "58", "1059"],
      [hour + 3_600, 1, 1, 1, 1, "x", "y"],
    ]);
  });

  test("a page that stops mid-bucket folds the rest on the next call instead of deleting it", () => {
    const hour = 1_759_557_600;
    for (let h = 0; h < 2; h++) {
      for (let m = 0; m < 60; m++) store.upsertCandle({ mint: MINT, t: hour + h * 3_600 + m * 60, o: m + 1, h: m + 1, l: m + 1, c: m + 1, mcap: null, nav: null });
    }
    // 118 unaligned minutes; a 70-row page covers hour 0 and cuts hour 1 after its 11th unaligned minute.
    while (store.compactCandles(hour + 2 * 3_600, 3_600, 70) > 0);
    const rows = store.candlesSince(MINT, 0);
    assert.deepEqual(rows.map((c) => [c.t, c.o, c.h, c.l, c.c]), [
      [hour, 1, 60, 1, 60],
      [hour + 3_600, 1, 60, 1, 60],
    ]);
  });

  test("responses are capped: a long window widens the interval instead of returning every minute", () => {
    register();
    store.tx(() => {
      for (let m = 0; m < 3 * 1_440; m++) store.upsertCandle({ mint: MINT, t: NOW - 3 * 86_400 + m * 60, o: 1, h: 2, l: 0.5, c: 1, mcap: null, nav: null });
    });
    const minute = views.candles(MINT, 60, "all");
    assert.ok(minute.length <= 1_500, `${minute.length} candles`);
    assert.equal(minute[1]!.t - minute[0]!.t, 300);
    assert.equal(views.candles(MINT, 60, "1h").length, 60);
  });
});

describe("the platform token seed capital", () => {
  test("seedLamports is the Copier account's capital_in, not the indexed Deposited rows", () => {
    register();
    store.setState(
      "config",
      JSON.stringify({ admin: LAUNCHER, keeper: KEEPER, platformMint: MINT, params: { keeperGraceSecs: 3_600, spendWindowSecs: 3_600, maxWindowSpendBps: 3_000 }, platformBurned: "0", platformBurnSpent: "0" }),
    );
    store.setCopierState(MINT, 9_000, state({ kind: "index", capital_in: (30n * SOL).toString() }));
    views.invalidate();
    assert.equal(views.platformToken().seedLamports, (30n * SOL).toString());
  });
});

describe("fees, burns, traders, the platform token", () => {
  test("distribution earnings reach the trader profile, directory and stats", () => {
    register();
    store.setCopierState(MINT, 5_000, state({ fees_in: "800000000" }));
    store.insertDistribution(
      { signature: sig(30), copier: MINT, slot: 1_200, ts: NOW - 50, distributed: "1000000000", to_vault: "800000000", to_targets: "200000000", shares: "[]" },
      [{ target: TARGET, lamports: "200000000" }],
    );
    views.invalidate();
    assert.equal(views.summary(MINT)?.targetEarnedLamports, "200000000");
    const p = views.traderProfile(TARGET);
    assert.equal(p.earnedLamports, "200000000");
    assert.deepEqual(p.earnings, [{ copier: MINT, symbol: "", lamports: "200000000", distributions: 1 }]);
    assert.equal(p.entry?.copiersCount, 1);
    assert.equal(views.directoryList({ q: "clukz", sources: [], tags: [], sort: "score", offset: 0, limit: 10 }).items[0]?.earnedLamports, "200000000");
    assert.equal(views.directoryList({ q: null, sources: [], tags: [], sort: "copiers", offset: 0, limit: 1 }).items[0]?.address, TARGET);
    assert.equal(views.stats().feesLamports, "1000000000");
    assert.equal(views.traderProfile(key(77)).entry, null);
  });

  test("own-coin and the platform token burns, burned share of supply, platform-token info", () => {
    register();
    ingestTx(
      sig(40),
      copierTxLogs([
        {
          name: "ParamsUpdated",
          data: {
            params: {
              maxTradeBps: 1000,
              maxPositionBps: 2000,
              maxOpenPositions: 12,
              minTradeLamports: 10_000_000n,
              minSignalLamports: 50_000_000n,
              signalMultipleBps: 10000,
              maxImpactBps: 300,
              slippageBps: 500,
              vaultFloorLamports: 20_000_000n,
              maxHoldSecs: 604_800n,
              keeperGraceSecs: 3_600n,
              spendWindowSecs: 3_600n,
              maxWindowSpendBps: 3_000,
            },
            admin: LAUNCHER,
            pendingAdmin: "11111111111111111111111111111111",
            keeper: KEEPER,
            platformMint: PLATFORM_TOKEN,
            descriptors: 10,
            ts: NOW - 900,
          },
        },
      ]),
      NOW - 900,
    );
    ingestTx(sig(41), copierTxLogs([{ name: "BuybackBurned", data: { mint: MINT, solIn: SOL, tokensBurned: PUMP_TOKEN_TOTAL_SUPPLY / 100n, totalBurned: PUMP_TOKEN_TOTAL_SUPPLY / 100n, ts: NOW - 60 } }]), NOW - 60);
    ingestTx(sig(42), copierTxLogs([{ name: "PlatformBurned", data: { solIn: SOL / 4n, tokensBurned: 5_000_000n, ts: NOW - 30 } }]), NOW - 30);
    store.setCopierState(MINT, 5_000, state({ burned: (PUMP_TOKEN_TOTAL_SUPPLY / 100n).toString() }));
    views.invalidate();
    assert.deepEqual(
      views.burns({ limit: 10 }).map((b) => [b.kind, b.copier, b.mint, b.solLamports]),
      [
        ["platform", PLATFORM_TOKEN, PLATFORM_TOKEN, (SOL / 4n).toString()],
        ["coin", MINT, MINT, SOL.toString()],
      ],
    );
    assert.equal(views.summary(MINT)?.burnedBps, 100);
    const s = views.stats();
    assert.equal(s.burnedValueLamports, SOL.toString());
    assert.equal(s.platformBurnLamports, (SOL / 4n).toString());
    assert.equal(views.config()?.params.maxHoldSecs, 604_800);
    const mt = views.platformToken();
    assert.equal(mt.mint, PLATFORM_TOKEN);
    assert.equal(mt.copier, null);
    assert.equal(mt.totalBurnedTokens, "5000000");
  });
});

describe("governance (timelocked admin changes)", () => {
  const params = {
    maxTradeBps: 1000,
    maxPositionBps: 2000,
    maxOpenPositions: 12,
    minTradeLamports: "10000000",
    minSignalLamports: "50000000",
    signalMultipleBps: 10000,
    maxImpactBps: 300,
    slippageBps: 500,
    vaultFloorLamports: "20000000",
    maxHoldSecs: 604800,
    keeperGraceSecs: 3600,
    spendWindowSecs: 3600,
    maxWindowSpendBps: 3000,
  };
  const config = (over: Record<string, unknown> = {}) =>
    store.setState(
      "config",
      JSON.stringify({ admin: LAUNCHER, keeper: KEEPER, platformMint: null, params, platformBurned: "0", platformBurnSpent: "0", timelockSecs: 86_400, pendingAdmin: null, pendingAdminEta: null, keeperHeartbeatTs: NOW - 120, latestChangeIds: [null, null, null, null], ...over }),
    );
  const WEEK = 604_800;
  const propose = (n: number, id: number, kind: "keeper" | "params", eta: number) =>
    ingestTx(sig(n), copierTxLogs([{ name: "ChangeProposed", data: { id: BigInt(id), kind, eta, expiresAt: eta + WEEK, ts: NOW } }]), NOW);

  test("ChangeProposed → queued with ETA, expiry and payload diff; ChangeExecuted / ChangeCancelled close it", () => {
    config({ latestChangeIds: [1, 0, null, null] });
    const fx = propose(60, 0, "params", NOW + 86_400);
    assert.deepEqual(fx.changes, [{ id: 0, event: "proposed" }]);
    store.upsertPendingAccount({ id: 0, kind: "params", proposer: LAUNCHER, proposed_at: NOW, eta: NOW + 86_400, expires_at: NOW + 86_400 + WEEK, payload: JSON.stringify({ kind: "params", params: { ...params, maxTradeBps: 2500 } }) });
    propose(61, 1, "keeper", NOW + 86_400);
    let g = views.governance();
    assert.equal(g.timelockSecs, 86_400);
    assert.deepEqual(
      g.pending.map((c) => [c.id, c.kind, c.status, c.eta, c.expiresAt, c.proposeSig]),
      [
        [0, "params", "queued", NOW + 86_400, NOW + 86_400 + WEEK, sig(60)],
        [1, "keeper", "queued", NOW + 86_400, NOW + 86_400 + WEEK, sig(61)],
      ],
    );
    assert.deepEqual(g.pending[0]!.summary, ["maxTradeBps 1000 → 2500"]);
    assert.equal(views.stats().pendingChanges, 2);

    ingestTx(sig(62), copierTxLogs([{ name: "ChangeExecuted", data: { id: 0n, kind: "params", ts: NOW + 86_401 } }]), NOW + 86_401);
    ingestTx(sig(63), copierTxLogs([{ name: "ChangeCancelled", data: { id: 1n, kind: "keeper", ts: NOW + 10 } }]), NOW + 10);
    g = views.governance();
    assert.equal(g.pending.length, 0);
    assert.deepEqual(
      g.history.map((c) => [c.id, c.status, c.resolveSig, c.proposeSig]),
      [
        [0, "executed", sig(62), sig(60)],
        [1, "cancelled", sig(63), sig(61)],
      ],
    );
    // A late account read must not resurrect an executed change.
    store.upsertPendingAccount({ id: 0, kind: "params", proposer: LAUNCHER, proposed_at: NOW, eta: NOW + 86_400, expires_at: NOW + 86_400 + WEEK, payload: "null" });
    assert.equal(views.governance().history[0]!.status, "executed");
  });

  test("status follows the program: executable within [eta, expiresAt], expired after, superseded when not the live id or invalidated", () => {
    propose(70, 5, "params", NOW - 10); // eta passed
    propose(71, 6, "keeper", NOW + 100);
    propose(72, 7, "params", NOW - WEEK - 20); // past expiry
    config({ latestChangeIds: [6, 5, null, null] });
    const status = () => Object.fromEntries(views.governance().pending.map((c) => [c.id, c.status]));
    assert.deepEqual(status(), { 5: "executable", 6: "queued", 7: "superseded" });
    config({ latestChangeIds: [6, 7, null, null] });
    assert.equal(status()[7], "expired");
    assert.equal(status()[5], "superseded");
    // `pause_keeper` invalidates the queued keeper change even before the Config is re-read.
    ingestTx(sig(73), copierTxLogs([{ name: "ChangeInvalidated", data: { id: 6n, kind: "keeper", reason: "keeperPaused", ts: NOW + 1 } }]), NOW + 1);
    const six = views.governance().pending.find((c) => c.id === 6)!;
    assert.equal(six.status, "superseded");
    assert.deepEqual(six.invalidation, { reason: "keeperPaused", ts: NOW + 1 });
    assert.equal(views.stats().pendingChanges, 0);
    // A permissionless discard closes it.
    ingestTx(sig(74), copierTxLogs([{ name: "ChangeDiscarded", data: { id: 6n, kind: "keeper", ts: NOW + 2 } }]), NOW + 2);
    assert.equal(views.governance().history.find((c) => c.id === 6)?.status, "discarded");
  });

  test("KeeperPaused is recorded once; keeper staleness follows heartbeat vs grace", () => {
    config({ keeper: null, keeperHeartbeatTs: NOW - 4_000 });
    const logs = copierTxLogs([{ name: "KeeperPaused", data: { keeper: KEEPER, ts: NOW - 5 } }]);
    const fx = ingestTx(sig(64), logs, NOW - 5);
    assert.deepEqual(fx.pauses, [KEEPER]);
    const again = new Effects();
    store.tx(() => parseCopierEvents(logs).forEach((ev, i) => applyEvent(store, { signature: sig(64), slot: 1, memoTarget: null }, i, ev, again)));
    assert.deepEqual(again.pauses, []);
    const g = views.governance();
    assert.equal(g.keeperPaused, true);
    assert.equal(g.keeperStale, true);
    assert.deepEqual(g.keeperPauses, [{ signature: sig(64), ts: NOW - 5, keeper: KEEPER }]);
    assert.equal(views.stats().keeperHeartbeatTs, NOW - 4_000);
  });

  test("index target change summary names added and removed wallets", () => {
    register();
    const added = key(40);
    const g = changeSummary({ kind: "indexTargets", copier: MINT, targets: [added] }, null, (m) => store.copier(m));
    assert.equal(g.length, 3);
    assert.match(g[1]!, /^adds /);
    assert.match(g[2]!, /^removes /);
  });

  test("spend window: cap = window equity × max_window_spend_bps, remaining never negative", () => {
    const w = spendWindowOf({ window_start: NOW - 600, window_spent: "400000000", window_equity: "1000000000" }, { spendWindowSecs: 3_600, maxWindowSpendBps: 3_000 });
    assert.deepEqual(w, { startedAt: NOW - 600, resetsAt: NOW + 3_000, spentLamports: "400000000", equityLamports: "1000000000", capLamports: "300000000", remainingLamports: "0" });
    assert.equal(spendWindowOf({ window_start: 0, window_spent: "0", window_equity: "0" }, null).capLamports, null);
  });
});
