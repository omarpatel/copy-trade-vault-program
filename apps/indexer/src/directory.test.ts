import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { Store } from "./db";
import { Directory, readSnapshot, writeSnapshot } from "./directory";
import { copyScore, mergeDirectory } from "./directory-merge";
import { parseFomoBoard } from "./directory-sources/fomo";
import { parseGmgnRank, parseGmgnWallet } from "./directory-sources/gmgn";
import { parseKolexplorer } from "./directory-sources/kolexplorer";
import { kolscanWallets, parseKolscanPage, parseKolscanRows } from "./directory-sources/kolscan";
import { parseMayhem, parsePayouts, parsePnlBoard, parseProfiles, pnlWallets } from "./directory-sources/pump";
import { EMPTY_STATS, emptyWallet, type SourceWallet } from "./directory-sources/types";
import { xHandle } from "./directory-sources/util";
import { isRecord } from "./sanitize";

/** Recorded responses (2026-10-04), trimmed to a few rows. */
const FIXTURES = path.join(import.meta.dirname, "..", "test-fixtures", "directory");
const fixture = (name: string) => fs.readFileSync(path.join(FIXTURES, name), "utf8");
const json = (name: string): unknown => JSON.parse(fixture(name));

const COOKER = "8deJ9xeUvXSJwicYptA9mHsU2rN2pDx37KWzkDkEXhU6";
const DIOR = "87rRdssFiTJKY4MGARa4G5vQ31hmR7MxSmhzeaJ5AAxJ";
const DECU = "4vw54BmAogeRV3vPKWyFet5yf8DTLcREzdSzx4rw9Ud9";
const NOW = 1_791_150_000;

function wallet(source: SourceWallet["source"], address: string, patch: Partial<SourceWallet> = {}): SourceWallet {
  return { ...emptyWallet(source, address), ...patch, stats: { ...EMPTY_STATS, ...patch.stats } };
}

describe("source parsers (recorded fixtures)", () => {
  test("kolscan: flight payload split mid-string → directory, SOL price, leaderboard rows", () => {
    const page = parseKolscanPage(fixture("kolscan-leaderboard.html"));
    assert.equal(page.solUsd, 120.46530484604355);
    assert.deepEqual(
      page.kols.map((k) => [k.address, k.name, k.handle]),
      [
        [COOKER, "Cooker", "CookerFlips"],
        [DECU, "decu", "notdecu"],
        [DIOR, "Dior", "Dior100x"],
      ],
    );
    assert.match(page.kols[0]!.pfp!, /^https:\/\/kolscan-images\.pump\.fun\/profiles\/8deJ9x/);
    assert.equal(page.rows.length, 3);

    const apiPage = json("kolscan-api-page.json");
    assert.ok(isRecord(apiPage));
    page.rows.push(...parseKolscanRows(apiPage.data));
    const wallets = kolscanWallets(page, NOW);
    const cooker = wallets.find((w) => w.address === COOKER)!;
    // 647.55 SOL daily at $120.47; 378W/83L weekly.
    assert.equal(Math.round(cooker.stats.pnl1dUsd!), 78_007);
    assert.equal(cooker.stats.trades7d, 461);
    assert.equal(cooker.stats.winRate7d, 378 / 461);
    assert.equal(cooker.stats.lastActiveTs, NOW, "traded today");
    assert.equal(cooker.url, `https://kolscan.io/account/${COOKER}`);
    // Monthly rank by profit among wallets on the 30d board: LJC #1, decu #2.
    assert.equal(wallets.find((w) => w.address === DECU)?.rank, 2);
    // A leaderboard-only wallet (not in the directory) still lists, with the row's name/handle.
    const ljc = wallets.find((w) => w.name === "LJC")!;
    assert.equal(ljc.handle, "OnlyLJC");
    assert.equal(ljc.rank, 1);
  });

  test("kolscan: a page without the directory throws instead of wiping the list", () => {
    assert.throws(() => parseKolscanPage("<html><body>maintenance</body></html>"), /initialData/);
  });

  test("pump.fun: PnL boards fold per window; payouts, mayhem and profiles", () => {
    const daily = parsePnlBoard(json("pump-pnl-daily.json"));
    assert.deepEqual(
      daily.map((r) => [r.rank, r.handle]),
      [
        [1, "hdegrootvan"],
        [2, null],
        [3, "Slidrrz"],
      ],
    );
    const [w] = pnlWallets([
      { period: "daily", sort: "combined", rows: daily.slice(0, 1) },
      { period: "monthly", sort: "realized", rows: [{ ...daily[0]!, rank: 2, pnlUsd: 1_000 }] },
      { period: "monthly", sort: "combined", rows: [{ ...daily[0]!, rank: 7, pnlUsd: 1_000 }] },
    ]);
    assert.equal(w!.stats.pnl1dUsd, daily[0]!.pnlUsd);
    assert.equal(w!.stats.pnl30dUsd, 1_000);
    assert.equal(w!.rank, 7, "rank comes from the monthly combined board, not the realized-PnL one");
    assert.match(w!.avatarUrl!, /^https:\/\/pump\.mypinata\.cloud\/ipfs\//);

    const [payout] = parsePayouts(json("pump-payouts.json"));
    assert.equal(payout!.address, "Be24Gbf5KisDk1LcWWZsBn8dvB816By7YzYF5zWZnRR6", "the Solana wallet, not the EVM one");
    assert.equal(payout!.handle, null, "twitterUrl is an x.com/i/user id link, not a handle");
    assert.deepEqual(payout!.tags, ["caller"]);

    const [bot] = parseMayhem(json("pump-mayhem.json"));
    assert.equal(bot!.stats.trades7d, 14_263);
    assert.equal(bot!.stats.winRate7d, 0.3549);

    const profiles = parseProfiles(json("pump-users.json"));
    assert.deepEqual(
      profiles.map((p) => [p.name, p.handle, p.followers]),
      [
        ["oxr", "oxrxbt", 421_752],
        ["Pcsd", null, 206_855],
      ],
    );
  });

  test("gmgn: realized profit (USD), win rate, swaps, hold time, mapped tags; wallet detail followers", () => {
    const [decu] = parseGmgnRank(json("gmgn-rank.json"));
    assert.equal(decu!.address, DECU);
    assert.equal(decu!.handle, "notdecu");
    assert.equal(Math.round(decu!.stats.pnl30dUsd!), 814_342);
    assert.equal(decu!.stats.trades30d, 39_416);
    assert.equal(decu!.stats.avgHoldSecs, 524_042);
    assert.equal(decu!.stats.lastActiveTs, 1_791_141_394);
    assert.deepEqual(decu!.tags, ["kol"], "terminal and wash/arb flags are dropped");
    assert.deepEqual(parseGmgnWallet(json("gmgn-wallet.json")), {
      followers: 666_465,
      handle: "Cented7",
      displayName: "cented",
      avatar: "https://gmgn.ai/defi/images/twitter/b8cd9c6689e23071d3dd80c1f404bb99.jpg",
    });
  });

  test("kolexplorer: BOM-prefixed roster, USD profits, percent win rate, /img avatars", () => {
    const rows = parseKolexplorer(fixture("kolexplorer-search.json"));
    const coler = rows.find((r) => r.name === "Coler")!;
    assert.equal(coler.handle, "ColerCooks");
    assert.equal(coler.stats.pnl7dUsd, 195_803);
    assert.equal(coler.stats.winRate7d, 0.4279);
    assert.equal(coler.avatarUrl, "https://kolexplorer.com/img/coler-1768530086.jpg");
    assert.equal(coler.url, "https://kolexplorer.com/kol/coler");
  });

  test("fomo (fomoapi.io documented shape): one row per Solana wallet of a trader", () => {
    const rows = parseFomoBoard({ traders: [{ rank: 3, handle: "frank", displayName: "Frank", pnlUsd: 1234.5, trades: 40, followers: 900, wallets: { solana: [COOKER, "not-a-key"], evm: "0xabc" } }] }, "30d");
    assert.deepEqual(
      rows.map((r) => [r.address, r.name, r.rank, r.stats.pnl30dUsd, r.stats.trades30d, r.followers, r.url]),
      [[COOKER, "Frank", 3, 1234.5, 40, 900, "https://fomo.family/u/frank"]],
    );
  });

  test("xHandle accepts handles and profile URLs only", () => {
    assert.equal(xHandle("https://x.com/CookerFlips"), "CookerFlips");
    assert.equal(xHandle("https://twitter.com/@abc_1/status/1"), "abc_1");
    assert.equal(xHandle("@abc"), "abc");
    assert.equal(xHandle("https://x.com/i/user/1180963377406853121"), null);
    assert.equal(xHandle("https://example.com/abc"), null);
    assert.equal(xHandle("way_too_long_handle_x"), null);
  });
});

describe("merge", () => {
  test("dedupes by address with identity precedence, keeps every source row, groups a person's wallets", () => {
    const merged = mergeDirectory(
      [
        wallet("kolexplorer", COOKER, { name: "Cooker (KE)", handle: "cookerflips", avatarUrl: "https://ke/c.jpg", stats: { ...EMPTY_STATS, pnl7dUsd: 1 } }),
        wallet("kolscan", COOKER, { name: "Cooker", handle: "CookerFlips", avatarUrl: "https://ks/c.jpg", rank: 9, stats: { ...EMPTY_STATS, pnl7dUsd: 2 } }),
        wallet("pump", COOKER, { followers: 5_000, profileOnly: true, avatarUrl: "https://pump/c.jpg" }),
        // GMGN's never-fetched placeholder: must not outrank the real pump count as "0 followers on X".
        wallet("gmgn", COOKER, { followers: 0, profileOnly: true }),
        wallet("gmgn", DIOR, { name: "Cooker alt", handle: "COOKERFLIPS", followers: 70_000, rank: 3 }),
        wallet("pump", DECU, { followers: 10, profileOnly: true }),
      ],
      NOW,
    );
    assert.equal(merged.length, 2, "profile-only rows never list a wallet on their own");
    const c = merged.find((w) => w.address === COOKER)!;
    assert.equal(c.name, "Cooker");
    assert.equal(c.handle, "CookerFlips");
    assert.deepEqual(c.sources, ["kolscan", "kolexplorer"]);
    assert.equal(c.rows.length, 4);
    assert.equal(c.stats.pnl7dUsd, 2, "kolscan stats beat kolexplorer");
    assert.deepEqual(c.avatarSources, ["https://ks/c.jpg", "https://ke/c.jpg", "https://pump/c.jpg"]);
    assert.deepEqual([c.followers, c.followersOn], [5_000, "pump"]);
    assert.deepEqual(c.rank, { source: "kolscan", rank: 9 });
    const alt = merged.find((w) => w.address === DIOR)!;
    assert.deepEqual([alt.followers, alt.followersOn], [70_000, "x"], "GMGN reports X followers");
    // Same handle, different case → one person with two wallets.
    assert.equal(c.personId, "cookerflips");
    assert.equal(alt.personId, "cookerflips");
    assert.equal(c.walletCount, 2);
    assert.ok(c.tags.includes("multi-wallet"));
  });

  test("curated tags/notes survive, HFT and inactivity are derived from stats", () => {
    const [w] = mergeDirectory(
      [
        wallet("curated", COOKER, { name: "Cooker", tags: ["low-frequency"], notes: "researched" }),
        wallet("kolscan", COOKER, { stats: { ...EMPTY_STATS, trades30d: 3_000, trades7d: 0 } }),
      ],
      NOW,
    );
    assert.equal(w!.notes, "researched");
    assert.ok(w!.tags.includes("hft"), "100 trades/day");
    assert.ok(w!.tags.includes("inactive"));
    assert.ok(w!.tags.includes("low-frequency"), "curated tags are kept even when stats disagree");
  });
});

describe("copyability score", () => {
  const base = { ...EMPTY_STATS, pnl1dUsd: 2_000, pnl7dUsd: 15_000, pnl30dUsd: 60_000, winRate30d: 0.6, lastActiveTs: NOW - 3600 };

  test("a profitable, steady, few-trades-a-day wallet beats an equally profitable HFT wallet", () => {
    const steady = copyScore({ ...base, trades30d: 120, avgHoldSecs: 3 * 3600 }, NOW);
    const hft = copyScore({ ...base, trades30d: 6_000, avgHoldSecs: 20 }, NOW);
    assert.ok(steady.score! >= 75, `steady ${steady.score}`);
    assert.ok(hft.score! <= 50, `hft ${hft.score}`);
    assert.match(hft.notes[0]!, /high-frequency|scalper/);
  });

  test("losses, inactivity and low win rate pull the score down; no trade data → null", () => {
    const good = copyScore({ ...base, trades30d: 120 }, NOW).score!;
    assert.ok(copyScore({ ...base, trades30d: 120, pnl30dUsd: -5_000, pnl7dUsd: -1_000, pnl1dUsd: -10 }, NOW).score! < good - 30);
    assert.ok(copyScore({ ...base, trades30d: 120, trades7d: 0, lastActiveTs: null }, NOW).score! < good);
    assert.ok(copyScore({ ...base, trades30d: 120, winRate30d: 0.2 }, NOW).score! < good);
    assert.equal(copyScore(EMPTY_STATS, NOW).score, null);
  });

  test("hold time and frequency combine pessimistically (a long average hold can't hide 200 swaps/day)", () => {
    const s = copyScore({ ...base, trades30d: 6_000, avgHoldSecs: 6 * 86_400 }, NOW).score!;
    assert.ok(s <= 55, `got ${s}`);
  });
});

describe("Directory", () => {
  test("store rows beat an older snapshot; a newer snapshot beats stale rows; queries filter/sort/page", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "copier-dir-"));
    const snapFile = path.join(dir, "snap.json");
    writeSnapshot(snapFile, {
      generatedAt: 100,
      sources: {
        kolscan: { fetchedAt: 100, wallets: [wallet("kolscan", COOKER, { name: "Snap Cooker", handle: "CookerFlips", stats: { ...EMPTY_STATS, pnl30dUsd: 10 } })] },
        pump: { fetchedAt: 100, wallets: [wallet("pump", DECU, { name: "decu", stats: { ...EMPTY_STATS, pnl30dUsd: 99 } })] },
      },
    });
    assert.equal(readSnapshot(snapFile)?.sources.kolscan?.wallets[0]?.name, "Snap Cooker");
    const store = new Store(":memory:");
    store.replaceDirectorySource("kolscan", [{ address: DIOR, data: JSON.stringify(wallet("kolscan", DIOR, { name: "Dior", stats: { ...EMPTY_STATS, pnl30dUsd: 50 } })) }]);
    store.recordDirectoryRun("kolscan", 200, 200, 1, null);
    store.replaceDirectorySource("pump", [{ address: DIOR, data: JSON.stringify(wallet("pump", DIOR, { name: "stale" })) }]);
    store.recordDirectoryRun("pump", 50, 50, 1, null);

    const d = new Directory({ store, snapshotFile: snapFile, now: () => NOW });
    assert.equal(d.get(COOKER)?.sources.includes("kolscan") ?? false, false, "kolscan comes from the newer crawl");
    assert.equal(d.get(DIOR)?.name, "Dior");
    assert.equal(d.get(DECU)?.name, "decu", "pump comes from the newer snapshot");
    assert.deepEqual(d.refreshedAt(), { kolscan: 200, pump: 100 });

    const q = (o: Partial<Parameters<Directory["query"]>[0]>) =>
      d.query({ q: null, sources: [], tags: [], sort: "pnl30d", offset: 0, limit: 50, ...o }, () => 0).items.map((w) => w.address);
    assert.deepEqual(q({ sources: ["pump", "kolscan"] }), [DECU, DIOR]);
    assert.deepEqual(q({ sources: ["pump", "kolscan"], offset: 1, limit: 1 }), [DIOR]);
    assert.deepEqual(q({ q: "@dio" }), [DIOR]);
    assert.deepEqual(q({ q: DECU.slice(0, 6).toLowerCase() }), [DECU], "address prefix, case-insensitive");
    assert.equal(q({ tags: ["-hft"] }).includes("CyaE1VxvBrahnPWkqm5VsdCvyS2QmNht2UFrKJHga54o"), false, "curated HFT wallets excluded");
  });

  test("apply() persists rows and run status; a 0-wallet result never replaces the list", async () => {
    const store = new Store(":memory:");
    const d = new Directory({ store, snapshotFile: null, now: () => NOW });
    d.apply({ source: "kolexplorer", fetchedAt: NOW, wallets: [wallet("kolexplorer", DIOR, { name: "Dior" })] });
    assert.equal(store.directoryRows().length, 1);
    assert.equal(store.directoryRuns()[0]?.count, 1);
    await assert.rejects(
      d.refresh({ id: "kolexplorer", intervalMs: 1, enabled: () => true, fetch: async () => ({ source: "kolexplorer", fetchedAt: NOW + 1, wallets: [] }) }),
      /0 wallets/,
    );
    assert.equal(d.get(DIOR)?.name, "Dior");
    const run = store.directoryRuns()[0]!;
    assert.equal(run.last_ok_at, NOW, "the failure keeps the last success");
    assert.match(run.error!, /0 wallets/);
  });
});
