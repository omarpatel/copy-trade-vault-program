# copy-vault indexer API (`@copy-trade-vault/indexer`)

Base URL: `http://127.0.0.1:8790` by default (`PORT`). Every response type is defined once in
`packages/sdk/src/api.ts` (`import type { … } from "@copy-trade-vault/sdk/api"`).

Conventions:

- JSON only. Lamports and raw token amounts are **decimal strings** (signed values carry `-`).
- Timestamps are **unix seconds**; fields ending in `Ms` are milliseconds.
- Prices are numbers in **lamports per whole token** (10^6 base units for pump coins).
- `…Bps` are integer basis points (10000 = 100%) and can be negative.
- Errors: `{ "error": "message" }` with 400 (validation), 401 (ingest auth), 404 (not indexed), 429 (rate limit,
  `Retry-After` header), 502 (upload backend failed), 503 (`/api/health` while not synced). Every enum query param
  (`sort`, `kind`, `source`, `range`, `interval`, `types`, …) accepts only its listed values, anything else is a 400
  naming them; a repeated param (`?sort=a&sort=b`) is a 400 too. Query params are checked before the copier lookup, so
  a bad `range` on an unknown mint is 400, not 404.
- CORS: `Access-Control-Allow-Origin: *`.
- Rate limits per IP: `RATE_LIMIT_PER_MIN` (600) on everything, `UPLOAD_LIMIT_PER_MIN` (10) on `POST /api/upload`;
  `/internal/*` and (on localnet) loopback clients are exempt.

## How the data is derived

| Data | Source |
|---|---|
| copiers, vault state | `CopierRegistered` + the `Copier` account (re-read after every event touching it, full refresh every `REFRESH_MS`) |
| positions | `Position` accounts (`["position", mint, token_mint]`), marked every 15 s at exit value (below) |
| vault trades | `CopierBuy` / `CopierSell` events; the tx's SPL memo `copier:<target sig>` links the target trade |
| target trades / copy decisions | keeper reports (`POST /internal/target-trades`); rebuilt from the target tx when a memo-linked report is missing |
| copy lag | `(vault tx block time − target tx block time) × 1000` and the slot distance (block times have 1 s resolution) |
| fees | `FeesSynced` (vault side as booked by the program) and pump `DistributeCreatorFeesEvent` (both shares) |
| target earnings | see below |
| burns | `BuybackBurned` (75% share, own coin) and `PlatformBurned` (25% share, the platform token) |
| own-coin market | bonding curve (`virtual_*` reserves) or canonical PumpSwap pool (vault balances + `virtual_quote_reserves`) every 15 s; 1 m candles |
| NAV / equity series | 15 s samples of NAV (liquid SOL + positions at exit value; 8 days kept), 1 m candles beyond |
| Wallet directory | kolscan, pump.fun, GMGN, kolexplorer, FOMO (via fomoapi.io, keyed) crawled in the background into SQLite (`directory_*` tables, kept across chain wipes) and seeded from `src/directory-snapshot.json`; merged with `src/kols.json` (curated research notes) and `.localnet/seed.json` KOLs on localnet. See `docs/research/wallet-directory.md` |
| fee routing | sharing config + bonding curve + canonical pool re-read on every full refresh (60 s), after every copier event and on any tx touching the sharing config |

**Target fee-share earnings (exact method).** The indexer does not infer the target's cut from the vault's
`fees_in` (that would also count SOL sent straight to the vault). For every copier it scans the coin's pump
`sharing_config` (`getSignaturesForAddress` with a persisted cursor, plus a live `logsSubscribe`) for
`distribute_creator_fees_v2` transactions and decodes pump's `DistributeCreatorFeesEvent { distributed,
shareholders[] }`. Each shareholder's lamports are its **observed balance change in that tx** when it is a pure
credit (`0 ≤ Δ ≤ distributed`), else pump's pro-rata `distributed × share_bps / 10000` (the shareholder also paid the
tx fee, or several distributions share one tx). Target shares are summed per target (`/api/traders/:address`).

**Fee-routing watch (pump.fun admin CTO).** pump.fun's admin can rewrite a coin's fee sharing after launch. Every
refresh re-runs `register_copier`'s checks (`programs/copy-vault/src/instructions/register.rs` `check_launch`, fee-sharing
research §7) on current chain state: the registered sharing config is the canonical `["sharing-config", mint]` PDA,
still owned by pump_fees, version 2, `Active`, for this mint, `admin_revoked`, and holds exactly the registered split
(single: `[target X, vault 10000−X]`, index: `[vault 10000]`, any order); the bonding curve's `creator` is the sharing
config; once the canonical PumpSwap pool exists its `coin_creator` is too. Any difference sets
`feeRouting.status = "changed"` (with a `detail` of every difference and the current shareholders), logs a `warn`
line and pushes a `copier` WS update. `"unknown"` = not verified yet; a failed read keeps the previous verdict.

**NAV = liquid SOL + every position's sell quote after price impact and venue fees.** `navLamports = free + Σ
position exit value`, `free = lamports + wSOL − rent − buyback_pool − platform_pending` (the program's `free_sol`).
A position's exit value (`Position.valueLamports`) is the SDK's `venueSellQuote(reserves, tokens, feeBps).solOut` for
all its tokens: the constant-product output of selling the whole position into its venue (bonding curve while live,
canonical PumpSwap pool after graduation), minus lp / protocol / creator fees at the live pump_fees FeeConfig tier
(SDK `curveFeeBps` / `poolFeeBps`; pump Global + both FeeConfigs re-read every 10 min). When a pool's real quote
can't pay the whole output, the largest payable output is used. Spot value (`tokens × quote / base`, before impact
and fees) is shown separately as `Position.spotValueLamports`; `markPriceLamports` is the spot price. Unrealized PnL
= exit value − cost. Positions without a live venue (or before pump's fee state was read) count at cost.
`equityLamports` is the program's own definition (`free + open_cost`).

---

## `GET /api/health`

200 when synced, 503 otherwise. `program` reports whether the Copier program is deployed and its Config initialized on
the indexed cluster (`null` before the first full refresh). Pre-launch (either `false`) is healthy: the indexer keeps
polling (`REFRESH_MS`) and picks both up when they appear.

```json
{
  "ok": true, "slot": 3120, "lastIndexedSlot": 3118, "lagSlots": 2, "wsConnected": true, "genesisHash": "9mJ3…",
  "program": { "id": "9R8g8JtEqRAh5yZ4aXbf1mWcfgLq9kAo6fmx93MSK9k7", "deployed": true, "configInitialized": true }
}
```

## `GET /api/stats` → `Stats`

```json
{
  "copiers": 6,
  "tvlLamports": "41250000000",
  "feesLamports": "3810000000",
  "burnedValueLamports": "420000000",
  "platformBurnLamports": "140000000",
  "copies24h": 37,
  "skipped24h": 112,
  "avgLagMs": 1400,
  "realizedPnlLamports": "2210000000",
  "targetsEarnedLamports": "610000000",
  "trackedTraders": 9,
  "feeRoutingAlerts": 0,
  "keeperHeartbeatTs": 1759559900,
  "timelockSecs": 86400,
  "pendingChanges": 1,
  "updatedAt": 1759560000
}
```

`tvlLamports` = Σ NAV; `feesLamports` = Σ (vault `fees_in` + target distributions); `burnedValueLamports` = SOL spent on
own-coin buybacks; `platformBurnLamports` = SOL spent on the platform token burns; `avgLagMs` = mean lag of copies in the last 24 h.

## `GET /api/copiers?sort=pnl|tvl|new|fees&kind=single|index&q=` → `CopierSummary[]`

`sort` defaults to `pnl` (realized + unrealized). `q` matches name, symbol, mint prefix, target address prefix, KOL
name or handle (case-insensitive, `$` prefix ignored).

```json
[
  {
    "mint": "7Hk3…pump",
    "kind": "single",
    "launcher": "4Qn…",
    "vault": "9Vt…",
    "targets": [{ "address": "D1YLG89jz5vPH4UHYPZqQrE47CRehFWuGiWSLP6Pj9uC", "name": "Sample Trader D", "handle": "sample_trader_d", "avatar": null, "verified": true }],
    "traderBps": 1500,
    "verifiedMask": 1,
    "createdAt": 1759550000,
    "isPlatformToken": false,
    "name": "Sample D Copier",
    "symbol": "CSAMPD",
    "image": "https://ipfs.io/ipfs/bafy…",
    "market": {
      "venue": "curve", "graduated": false, "pool": null,
      "priceLamports": 41.7, "marketCapLamports": "41700000000", "supply": "999000000000000",
      "decimals": 6, "curveProgressBps": 2210, "change24hBps": 1840, "updatedAt": 1759559995
    },
    "equityLamports": "5300000000",
    "navLamports": "5520000000",
    "freeLamports": "3100000000",
    "openCostLamports": "2200000000",
    "positionsValueLamports": "2420000000",
    "unrealizedLamports": "220000000",
    "feesInLamports": "4100000000",
    "capitalInLamports": "0",
    "realizedPnlLamports": "1200000000",
    "hwmLamports": "1400000000",
    "pnlLamports": "1420000000",
    "pnlBps": 3463,
    "buybackPoolLamports": "150000000",
    "buybackSpentLamports": "750000000",
    "burnedTokens": "12000000000000",
    "burnedBps": 120,
    "platformSentLamports": "350000000",
    "targetEarnedLamports": "720000000",
    "trades": 41,
    "openPositions": 3,
    "copies24h": 12,
    "skipped24h": 30,
    "lagP50Ms": 1000,
    "lastCopyAt": 1759559800,
    "spark": [4100000000, 4180000000, 5520000000],
    "feeRouting": {
      "status": "intact",
      "checkedAt": 1759559990,
      "detail": null,
      "shareholders": [{ "address": "D1YL…", "bps": 1500 }, { "address": "9Vt…", "bps": 8500 }]
    }
  }
]
```

## `GET /api/copiers/:mint` → `CopierDetail`

The summary plus (`targets` become `CopierTarget[]`):

```json
{
  "targets": [{ "address": "D1YL…", "name": "Sample Trader D", "handle": "sample_trader_d", "avatar": null, "verified": true,
                "index": 0, "openPositions": 3, "realizedPnlLamports": "1200000000", "copies": 41, "skipped": 30, "lastTradeAt": 1759559800 }],
  "sharingConfig": "Fs3…",
  "graduatedPool": null,
  "lastKeeperTs": 1759559800,
  "params": { "maxTradeBps": 1000, "maxPositionBps": 2000, "maxOpenPositions": 12, "minTradeLamports": "10000000",
              "minSignalLamports": "50000000", "signalMultipleBps": 10000, "maxImpactBps": 300, "slippageBps": 500,
              "vaultFloorLamports": "20000000", "maxHoldSecs": 604800, "keeperGraceSecs": 3600 },
  "keeper": "Kp1…",
  "coin": { "name": "Sample D Copier", "symbol": "CSAMPD", "uri": "https://ipfs.io/ipfs/bafk…", "image": "https://ipfs.io/ipfs/bafy…",
            "description": "Copies Sample Trader D", "twitter": "https://x.com/…", "telegram": null, "website": null },
  "fees": { "distributedLamports": "4820000000", "toVaultLamports": "4100000000", "toTargetsLamports": "720000000",
            "feesInLamports": "4100000000", "distributions": 17, "lastDistributedAt": 1759559700 },
  "wsolLamports": "0",
  "burnPoolLamports": "0",
  "hwmGapLamports": "200000000",
  "pnlHistory": [[1759551000, "900000000", "900000000"], [1759552000, "1400000000", "1400000000"], [1759553000, "1200000000", "1400000000"]],
  "spendWindow": { "startedAt": 1759558000, "resetsAt": 1759561600, "spentLamports": "400000000",
                   "equityLamports": "5300000000", "capLamports": "1590000000", "remainingLamports": "1190000000" }
}
```

`pnlHistory` = `[ts, realized PnL, HWM]` after every `CopierSell`, at most 500 points (beyond that: the last sell of
each `span / 500` bucket); `hwmGapLamports` = HWM − realized (losses to win back before profits split again). 404 when
the mint is not an indexed copier.

## `GET /api/copiers/:mint/positions` → `Position[]`

Sorted by cost basis, largest first.

```json
[
  {
    "copier": "7Hk3…pump", "tokenMint": "Bq…pump",
    "coin": { "mint": "Bq…pump", "name": "Frog", "symbol": "FROG", "image": "https://…" },
    "target": "D1YL…", "venue": "curve", "tokens": "3480000000000", "decimals": 6,
    "costLamports": "1000000000", "openedAt": 1759558000, "firstCopySig": "5Kq…",
    "targetSnapshot": "35000000000000", "targetPeak": "35000000000000", "vaultPeak": "3480000000000",
    "markPriceLamports": 316.2, "valueLamports": "1100376000", "unrealizedLamports": "100376000",
    "unrealizedBps": 1003, "pctOfEquityBps": 1993, "realizedLamports": "0", "buys": 1, "sells": 0,
    "lastTradeAt": 1759558000, "maxHoldAt": 1760162800
  }
]
```

## `GET /api/copiers/:mint/copies?limit=50` → `Copy[]`

Newest first (`limit` 1..200). `status`: `copied` | `skipped` | `failed` | `pending` (reported copied, vault tx not
indexed yet).

```json
[
  {
    "id": "7Hk3…pump:3xT…:Bq…pump", "copier": "7Hk3…pump", "copierSymbol": "CSAMPD", "ts": 1759559800,
    "target": { "address": "D1YL…", "name": "Sample Trader D", "handle": "sample_trader_d", "avatar": null, "verified": true },
    "targetSig": "3xT…", "targetTs": 1759559800, "targetSlot": 3100,
    "side": "buy", "tokenMint": "Bq…pump", "coin": { "mint": "Bq…pump", "name": "Frog", "symbol": "FROG", "image": null },
    "targetSolLamports": "2000000000", "targetTokens": "35000000000000",
    "status": "copied", "reason": null, "error": null,
    "vaultSig": "5Kq…", "vaultTs": 1759559801, "vaultSlot": 3103,
    "vaultSolLamports": "1000000000", "vaultTokens": "3480000000000", "pnlLamports": null, "forced": false,
    "lagMs": 1000, "lagSlots": 3, "sizeBps": 5000
  },
  {
    "id": "7Hk3…pump:4aB…:Fr…pump", "status": "skipped", "reason": "signal_below_min", "vaultSig": null, "lagMs": null, "…": "…"
  }
]
```

## `GET /api/copiers/:mint/trades?limit=50` → `VaultTrade[]`

Every `CopierBuy` / `CopierSell` of the vault (forced exits included), newest first.

```json
[{ "copier": "7Hk3…pump", "signature": "5Kq…", "slot": 3103, "ts": 1759559801, "side": "sell", "target": "D1YL…",
   "tokenMint": "Bq…pump", "coin": { "mint": "Bq…pump", "name": "Frog", "symbol": "FROG", "image": null }, "venue": "curve",
   "solLamports": "1300000000", "tokens": "3480000000000", "costRemovedLamports": "1000000000", "pnlLamports": "300000000",
   "realizedPnlLamports": "1500000000", "hwmLamports": "1500000000", "forced": false, "equityLamports": null,
   "signalLamports": null, "targetBalance": null, "targetSignature": "3xT…" }]
```

## `GET /api/copiers/:mint/equity?range=1h|24h|7d|30d|all` → `EquityPoint[]`

`[ts, navLamports]`, default `7d`. Buckets: 1h → 15 s, 24h → 5 min, 7d → 30 min, 30d → 2 h, all → history ÷ 400.

```json
[[1759473600, "5000000000"], [1759475400, "5120000000"], [1759477200, "5080000000"]]
```

## `GET /api/copiers/:mint/candles?interval=60&range=24h` → `Candle[]`

Own-coin price candles from the 15 s samples (`interval` ∈ 60, 300, 900, 3600, 14400, 86400 seconds; `range` as above,
default `24h`). `o/h/l/c` in lamports per whole token, `mcap` at close. At most 1500 candles: when the window does not
fit at the requested interval, the next larger interval that fits is used. 1-minute candles are kept 30 days; older
ones are folded into hourly candles (so old history is hourly even at `interval=60`).

```json
[{ "t": 1759559700, "o": 40.1, "h": 42.0, "l": 39.8, "c": 41.7, "mcap": "41700000000" }]
```

## `GET /api/copies?limit=50` → `Copy[]`

The latest copies across every copier.

## `GET /api/traders?q=&source=&tag=&sort=score&offset=0&limit=50` → `DirectoryPage`

The wallet directory: every KOL / top-trader wallet the sources list, one row per wallet (a person's other wallets
share `personId`). Identity is merged per address (curated > kolscan > GMGN > pump.fun > kolexplorer > FOMO), stats
per field (kolscan > GMGN > pump.fun > kolexplorer > FOMO), avatars are the indexer's cached WebP (`avatar`, 128 px;
null until cached → render a monogram).

| param | |
|---|---|
| `q` | name, X handle (`@` optional), display name or address prefix; case-insensitive; exact > prefix > substring first |
| `source` | comma list of `kolscan`, `pump`, `gmgn`, `kolexplorer`, `fomo`, `curated`, `localnet` (any of) |
| `tag` | comma list (≤ 8); all required; `-tag` excludes (`tag=-hft`) |
| `sort` | `score` (default: copyability), `pnl30d`, `pnl7d`, `pnl1d`, `winrate`, `followers`, `copiers`, `rank`; nulls last, ties by score |
| `offset`, `limit` | paging (`limit` 1..200, default 50) |

`facets` count sources/tags over the `q`-filtered set (before `source`/`tag`), for chip counts. `refreshedAt` is the
last successful fetch per remote source (crawl or snapshot).

```json
{
  "items": [{
    "address": "8deJ9xeUvXSJwicYptA9mHsU2rN2pDx37KWzkDkEXhU6", "name": "Cooker", "handle": "CookerFlips",
    "xUrl": "https://x.com/CookerFlips", "displayName": "Cooker.hl", "avatar": "https://idx/files/avatars/3f2a…-128.webp",
    "followers": 70412, "followersOn": "x", "sources": ["curated", "kolscan", "gmgn", "kolexplorer"],
    "personId": "cookerflips", "walletCount": 1,
    "stats": { "pnl1dUsd": 78007, "pnl7dUsd": 52634, "pnl30dUsd": 591407, "winRate7d": 0.82, "winRate30d": 0.61,
               "trades7d": 461, "trades30d": 1620, "avgHoldSecs": 2400, "lastActiveTs": 1791145973 },
    "tradesPerDay": 54, "score": 31,
    "scoreNotes": ["~54 trades/day — high-frequency, hard to copy", "+$591k PnL (30d)", "61% win rate"],
    "rank": { "source": "kolscan", "rank": 6 }, "tags": ["hft"], "notes": null,
    "copiersCount": 0, "earnedLamports": "0"
  }],
  "total": 2875, "offset": 0, "limit": 50,
  "facets": { "sources": { "kolscan": 570, "pump": 1400, "gmgn": 1100 }, "tags": { "hft": 230, "caller": 500 } },
  "totals": { "wallets": 2875, "persons": 2790 },
  "refreshedAt": { "kolscan": 1791150000, "pump": 1791150100 }
}
```

**Copyability score** (0–100, `directory-merge.ts` `copyScore`): `100 × quality × gate`. Fidelity `f` = the worse of
trades/day (1.0 for 0.5–8/day → 0 at 100/day) and average hold (0 at ≤ 30 s → 1.0 at ≥ 4 h); gate = 0.25 + 0.75 f
(0.7 when unknown). Quality = weighted mean of 30d PnL (log, $0 → 0, $200k → 1; 40%), share of profitable windows
(20%), win rate shrunk toward 45% by 20 pseudo-trades (30% → 0, 70% → 1; 25%) and recency (15%). Null without data.
Derived tags: `hft` (> 50 trades/day or hold < 60 s), `low-frequency` (≤ 3/day), `inactive` (0 trades in 7d),
`multi-wallet`; source tags: `caller` (pump.fun payouts), `mayhem`, `kol`, `smart-money`, `bot`, `fresh-wallet`.

## `GET /api/traders/:address` → `TraderProfile`

Any valid wallet returns 200 (`entry`/`person` null outside the directory, `sources` empty); 400 for an invalid
address. `person.wallets` lists every directory wallet sharing the X handle (this one first); `sources` is every
source's own view (`listed: false` = profile enrichment only, e.g. its pump.fun profile).

```json
{
  "address": "D1YL…",
  "entry": { "address": "D1YL…", "name": "Sample Trader D", "…": "DirectoryEntry" },
  "person": { "id": "sample_trader_d", "name": "Sample Trader D", "handle": "sample_trader_d", "xUrl": "https://x.com/sample_trader_d",
              "displayName": null, "avatar": "…-128.webp", "avatarLarge": "…-256.webp", "followers": 41000,
              "followersOn": "x", "wallets": [{ "address": "D1YL…", "…": "DirectoryEntry" }] },
  "sources": [{ "source": "kolscan", "rank": 41, "url": "https://kolscan.io/account/D1YL…", "name": "Sample Trader D",
                "handle": "sample_trader_d", "followers": null, "stats": { "…": "TraderStats" }, "tags": [], "notes": null,
                "fetchedAt": 1791150000, "listed": true }],
  "copiers": [{ "mint": "7Hk3…pump", "…": "CopierSummary" }],
  "earnedLamports": "720000000",
  "earnings": [{ "copier": "7Hk3…pump", "symbol": "CSAMPD", "lamports": "720000000", "distributions": 17 }],
  "verifiedOn": ["7Hk3…pump"],
  "recentTrades": [{ "copier": "7Hk3…pump", "target": "D1YL…", "signature": "3xT…", "slot": 3100, "blockTime": 1759559800,
                     "side": "buy", "tokenMint": "Bq…pump", "coin": { "…": "…" }, "tokenDelta": "35000000000000",
                     "solDelta": "-2000000000", "targetSolBefore": "61000000000", "priceLamportsPerToken": 0.0000571,
                     "venue": "curve", "status": "copied", "reason": null, "error": null, "vaultSignature": "5Kq…",
                     "detectedAt": 1759559800350, "decidedAt": 1759559800410, "source": "keeper" }],
  "stats": { "observed": 142, "copied": 41, "skipped": 98, "failed": 3 }
}
```

`TraderRef` (copier `targets`, copy `target`, the platform token targets) carries the same identity: `name`, `handle`, `xUrl`,
`displayName`, `avatar`, `followers`, `followersOn`, `sources`, plus `verified`.

## `GET /api/burns?mint=&kind=coin|platform&limit=50` → `Burn[]`

Newest first. `mint` filters by `Burn.copier` (the platform token copier's own buybacks and the burn pool's the platform token burns
both carry it).

```json
[
  { "kind": "coin", "signature": "2Pa…", "slot": 3050, "ts": 1759559000, "copier": "7Hk3…pump", "mint": "7Hk3…pump",
    "symbol": "CSAMPD", "image": "https://…", "solLamports": "150000000", "tokens": "3600000000000", "totalBurned": "12000000000000" },
  { "kind": "platform", "signature": "6Rz…", "slot": 3060, "ts": 1759559100, "copier": "Ix9…pump", "mint": "Ix9…pump",
    "symbol": "copy-vault", "image": "https://…", "solLamports": "50000000", "tokens": "900000000000", "totalBurned": null }
]
```

## `GET /api/feed?mint=&types=copy,burn,launch,fees,profit&limit=50` → `FeedItem[]`

Merged, newest first. `{ type, id, ts, mint, data }` with `data`: `Copy` | `Burn` | `CopierSummary` (launch) |
`FeeEvent` | `ProfitEvent`. `fees` items are pump distributions (`kind: "distribution"`) and deposits
(`"deposit"`); with `mint` set they also include the program's `FeesSynced` bookings (`"sync"`).

```json
[
  { "type": "fees", "id": "fees:distribution:4Lm…:7Hk3…pump", "ts": 1759559700, "mint": "7Hk3…pump",
    "data": { "kind": "distribution", "copier": "7Hk3…pump", "symbol": "CSAMPD", "signature": "4Lm…", "slot": 3080, "ts": 1759559700,
              "lamports": "282000000", "toVaultLamports": "239700000", "toTargetsLamports": "42300000", "totalFeesInLamports": null, "from": null } },
  { "type": "profit", "id": "profit:5Kq…:1", "ts": 1759559650, "mint": "7Hk3…pump",
    "data": { "copier": "7Hk3…pump", "symbol": "CSAMPD", "signature": "5Kq…", "slot": 3075, "ts": 1759559650,
              "excessLamports": "200000000", "toBuybackLamports": "150000000", "toPlatformLamports": "50000000" } }
]
```

## `GET /api/governance` → `Governance`

Timelocked admin changes (`propose_*` → anyone may `execute_pending` within `[eta, expiresAt]`, expiresAt = eta + 7
days; the admin may `cancel_pending`; anyone may `discard_pending` a superseded or expired change), the keeper and
its liveness. Built from `ChangeProposed` / `ChangeExecuted` / `ChangeCancelled` / `ChangeInvalidated` /
`ChangeDiscarded` / `KeeperPaused`, the Config account (`latest_change_ids`) and the `PendingChange` accounts
(payload, proposer, schedule; re-read after each change event and every full refresh).

`status` follows the program (SDK `pendingChangeStatus`): `executed` / `cancelled` / `discarded` once closed;
`superseded` when a `ChangeInvalidated` was seen (reason `superseded` by a newer proposal of the kind, `keeperPaused`,
`adminChanged`) or the change is no longer `latest_change_ids[kind]`; `expired` after `expiresAt`; `queued` before
`eta`; else `executable`. `pending` lists every open change (superseded / expired ones until someone discards them);
`/api/stats.pendingChanges` counts only `queued` + `executable`. `summary` diffs the payload against the current
config. `keeperStale` = now − `keeper_heartbeat_ts` > `keeper_grace_secs` (permissionless exits allowed for targets
that sold out). Every `ChangeProposed` (with its execution window) and `KeeperPaused` logs a warn line and posts to
`ALERT_WEBHOOK_URL`.

```json
{
  "timelockSecs": 86400, "admin": "Ad1…", "pendingAdmin": null, "pendingAdminEta": null,
  "keeper": "Kp1…", "keeperPaused": false, "keeperHeartbeatTs": 1759559900, "keeperGraceSecs": 3600, "keeperStale": false,
  "pending": [{ "id": 3, "kind": "params", "status": "queued", "proposer": "Ad1…", "proposedAt": 1759559000,
                "eta": 1759645400, "expiresAt": 1760250200, "invalidation": null,
                "resolvedAt": null, "proposeSig": "2Hq…", "resolveSig": null,
                "payload": { "kind": "params", "params": { "maxTradeBps": 2500, "…": "…" } },
                "summary": ["maxTradeBps 1000 → 2500"] }],
  "history": [{ "id": 2, "kind": "keeper", "status": "executed", "resolvedAt": 1759400000, "…": "…" }],
  "keeperPauses": [{ "signature": "5Zp…", "ts": 1759300000, "keeper": "OldK…" }]
}
```

## `GET /api/platform-token` → `PlatformTokenInfo`

`mint`/`copier` are null until `set_platform_mint` is indexed. Target `weightBps` = the target's share of the vault's
open cost basis (positions opened on its trades), equal split while flat. `seedLamports` is the vault's on-chain
`capital_in` (every `deposit`).

```json
{
  "mint": "Ix9…pump",
  "copier": { "mint": "Ix9…pump", "kind": "index", "…": "CopierDetail" },
  "targets": [{ "address": "D1YL…", "name": "Sample Trader D", "handle": "sample_trader_d", "avatar": null, "verified": false, "index": 0,
                "weightBps": 6200, "copies": 12, "pnlLamports": "300000000", "openPositions": 2, "lastTradeTs": 1759559800 }],
  "seedLamports": "30000000000",
  "burnPool": "BuRn…",
  "burnPoolLamports": "12000000",
  "totalBurnedTokens": "4200000000000",
  "platformBurnLamports": "140000000",
  "burns": [{ "kind": "platform", "…": "Burn" }]
}
```

## `POST /api/upload` (multipart/form-data) → `UploadResponse`

Fields: `image` (file, PNG/JPEG/GIF/WebP sniffed by magic bytes, ≤ 4 MiB), `name` (≤ 32 bytes), `symbol` (≤ 10
bytes), optional `description` (≤ 1000 chars), `twitter`, `telegram` (handle or x.com / t.me URL), `website` (URL).
Stores the image and pump.fun-style metadata JSON `{ name, symbol, description, image, showName: true, createdOn:
"https://pump.fun", twitter?, telegram?, website? }`:

- `UPLOAD_STORAGE=pinata` (default when `PINATA_JWT` is set): Pinata v3 public IPFS, URIs on `PINATA_GATEWAY`
  (default `https://ipfs.io/ipfs`);
- `pump` (default otherwise on a non-local RPC): pump.fun's `https://pump.fun/api/ipfs`;
- `local` (default on a localhost RPC): files under `FILES_DIR` served at `${PUBLIC_URL}/files/…`.

```bash
curl -F image=@coin.png -F name="Sample D Copier" -F symbol=CSAMPD -F description="Copies Sample Trader D" http://127.0.0.1:8790/api/upload
```

```json
{ "uri": "https://ipfs.io/ipfs/bafkrei…", "image": "https://ipfs.io/ipfs/bafybei…" }
```

## `POST /internal/target-trades` (keeper) → `TargetTradesIngestResponse`

`Authorization: Bearer <INDEXER_INGEST_TOKEN>` (on a localhost RPC it defaults to `copier-localnet-ingest`). Body
`TargetTradesIngestBody` = `{ trades: TargetTradeIngest[] }`, 1..50 trades, ≤ 256 KiB. Every trade is validated
(base58 keys and signatures, integer strings, enums, `reason` required when skipped, `vaultSignature` required when
copied); one invalid entry rejects the batch (400). Upsert on `(copier, signature, tokenMint)`: one row per token leg
of the target tx (a routed swap or sell-A-buy-B tx has two legs); a later report of a leg replaces its
decision (e.g. `failed` → retried → `copied`). Each stored report is pushed on `/ws` as a `copy`. `Copy.id` =
`<copier>:<target sig>:<tokenMint>`.

```json
{ "trades": [{
  "copier": "7Hk3…pump", "target": "D1YL…", "signature": "3xT…", "slot": 3100, "blockTime": 1759559800,
  "side": "buy", "tokenMint": "Bq…pump", "tokenDelta": "35000000000000", "solDelta": "-2000000000",
  "targetSolBefore": "61000000000", "priceLamportsPerToken": 0.0000571, "venue": "curve",
  "status": "copied", "reason": null, "error": null, "vaultSignature": "5Kq…", "vaultSolIn": "1000000000",
  "vaultTokensIn": null, "detectedAt": 1759559800350, "decidedAt": 1759559800410 }] }
```

→ `{ "accepted": 1 }`

## `GET /files/img/:id`, `GET /files/meta/:id.json`, `GET /files/avatars/:sha-{128,256}.webp`

Local uploads and the directory's cached profile pictures (content-addressed, immutable, cached for a year). Avatars
are fetched over https only, from hosts whose every resolved address is public (no loopback/private/CGNAT/link-local/
ULA or `*.internal`/`*.local`), following at most 3 re-vetted redirects, ≤ 5 MiB decoded, ≤ 3 attempts per URL.

## WebSocket `/ws` → `WsMessage`

Server → client only, JSON text frames `{ type, data }`:

| type | data | when |
|---|---|---|
| `copy` | `Copy` | keeper report stored, or a memo-linked vault trade indexed |
| `trade` | `VaultTrade` | `CopierBuy` / `CopierSell` indexed |
| `burn` | `Burn` | `BuybackBurned` / `PlatformBurned` indexed |
| `launch` | `CopierSummary` | new copier registered |
| `fees` | `FeeEvent` | pump distribution, `FeesSynced` or `Deposited` indexed |
| `stats` | `Stats` | after every indexed tx and every 15 s market sample |
| `copier` | `CopierSummary` | a copier's summary changed (trade, price/NAV sample, metadata, verification) |
| `reset` | `{ genesisHash }` | the chain was reset and re-indexed: drop cached data and refetch |
| `governance` | `Governance` | an admin change was proposed / executed / cancelled, or the keeper was paused |

Clients are pinged every 30 s; a client buffering > 1 MiB is dropped (reconnect and refetch).

## Environment

| var | default | |
|---|---|---|
| `RPC_URL` | `http://127.0.0.1:8899` | HTTP JSON-RPC |
| `WS_URL` | RPC port + 1 | pubsub |
| `PORT` / `HOST` | `8790` / `0.0.0.0` | |
| `PUBLIC_URL` | `http://127.0.0.1:$PORT` | base of local upload URLs |
| `DB_PATH` | `apps/indexer/data/indexer.db` | SQLite (WAL); rebuilt from chain on schema change / chain reset |
| `FILES_DIR` | `apps/indexer/data/files` | local uploads |
| `INDEXER_INGEST_TOKEN` | `copier-localnet-ingest` on localhost, else required | keeper ingest bearer |
| `PINATA_JWT`, `PINATA_GATEWAY`, `UPLOAD_STORAGE` | | see `/api/upload` |
| `LOCALNET_KOLS` | `.localnet/seed.json` when present on localnet | extra directory KOLs |
| `DIRECTORY_REFRESH` | on | `off` serves the committed snapshot + stored crawl only (no crawling, no avatar fetches) |
| `DIRECTORY_GMGN` | on | `off` skips GMGN (needs a `curl` binary; Cloudflare blocks Node's TLS client) |
| `DIRECTORY_GMGN_ENRICH` | 150 | GMGN wallet-detail calls per run (X followers), rotating |
| `FOMOAPI_KEY` | unset | enables the FOMO source via fomoapi.io |
| `POLL_MS` | 2000 localnet / 10000 | program signature poll (websocket gap filler) |
| `SNAPSHOT_MS` | 15000 | market + NAV samples |
| `REFRESH_MS` | 60000 | full account refresh |
| `FEES_POLL_MS` | 5000 localnet / 30000 | sharing-config distribution scan |
| `CHAIN_CHECK_MS` | 30000 | genesis / cursor check (wipe + re-index on reset) |
| `RATE_LIMIT_PER_MIN`, `UPLOAD_LIMIT_PER_MIN` | 600, 10 | 0 disables |
| `TRUST_PROXY` | unset | `true` or a list of proxy addresses (X-Forwarded-For) |
| `ALERT_WEBHOOK_URL` | unset | Slack/Discord webhook; one POST `{text, content}` per fee-routing flip (changed / restored). Best effort, logged on failure |
| `LOG_LEVEL` | `info` | |
