# @copy-trade-vault/watcher — the copy-vault keeper

Watches every target wallet of every on-chain Copier, classifies what the wallet did, and copies qualifying trades
into the copier's vault with `copier_buy` / `copier_sell`. It also runs the maintenance cranks (creator-fee
distribution + `sync`, `buyback_burn`, `burn_platform`, max-hold exits) and reports every observed target trade and
decision to the indexer. Contract: `docs/SPEC.md` §4.

```
pnpm --filter @copy-trade-vault/watcher dev     # tsx watch, restarts on edits
pnpm --filter @copy-trade-vault/watcher start   # production
pnpm --filter @copy-trade-vault/watcher test    # classifier (recorded mainnet txs) + policy
curl http://127.0.0.1:8792/status
```

## How it works

```
copiers (getProgramAccounts, every 30 s) ──► targets ──► Detector ──► Keeper.onTx ──► policy ──► executor
                                                          │ ws: accountSubscribe(target)          │
                                                          │     programSubscribe(Token, Token-2022, owner = target)
                                                          │ poll: getSignaturesForAddress(target | token account)
                                                          │ gRPC (optional): Yellowstone transactions
                                                          ▼
                                                raw getTransaction (v1)  →  classifier  →  decisions (SQLite)  →  indexer
```

- **Targets** come from the chain only: every `Copier` account (index copiers contribute up to 16 targets each),
  re-read every `COPIER_REFRESH_MS`. Open `Position`s are read with them; the targets' canonical token accounts of
  those mints are tracked so sells are seen even without token-program subscriptions.
- **Detection** is state-based, not mention-based: top KOL wallets are mentioned by ~1,000 mostly failed spam
  transactions per 15 s, so the keeper watches the wallet's lamports and its token accounts and confirms a change
  through the token account's own (low-noise) signature list. Transactions are fetched with raw JSON-RPC
  `getTransaction(maxSupportedTransactionVersion: 1)` because mainnet serves v1 transactions web3.js 1.x cannot
  parse. A poll fallback (target signatures since a persisted cursor + tracked token accounts) runs every
  `POLL_MS`, every `POLL_FALLBACK_MS` while the socket is down or the provider refuses `programSubscribe`, and on
  every websocket reconnect (gap backfill). Every path is deduplicated by signature in SQLite.
- **Durability and order**: each address (a target wallet, or one of its token accounts) is drained on its
  target's serial lane — every signature since the persisted cursor, walked back page by page until the cursor
  (resumed by the next poll when the gap is longer than 5 × 1,000 signatures), then handled oldest first, one at a
  time. The cursor moves to a signature only after it was handled, so a crash re-reads whatever was not; a
  target's sell is never decided before the buy it follows; different targets run in parallel. An RPC outage stops
  the drain before the failed signature (no give-up); a transaction the node keeps not serving (or whose handling
  keeps throwing) is given up after 5 polls (`signature_given_up`).
- **Classification** diffs balances, not instruction layouts: the target must sign; token deltas are grouped by
  owner and mint; wSOL is folded into SOL; rent of token accounts opened/closed in the transaction is removed from
  the SOL side. Results: `buy`, `sell`, `transfer_in`, `transfer_out` (also unsigned decreases: delegate/limit
  fills), `airdrop` (unsigned increase — never copied).
- **Policy** (`src/policy.ts`) sizes buys as
  `min(equity × max_trade, signal × signal_multiple × 95%, venue real SOL × max_impact, position room, free SOL − floor − 0.01 SOL rent, spend window left − 0.01 SOL rent)`
  scaled by conviction `clamp(k × target_spent / target_sol_before, floor, 1)`, never below `min_trade` when the
  caps allow it. `signal = min(SOL the target spent, Δtokens × spot)`, so a bait/airdrop-sized position can only
  pull a proportionally small copy. Sells are `allowedSell(position, target balance now)` from the SDK —
  proportional to what the target kept of its peak, everything after `max_hold_secs`. Every skip has a reason
  (`SkipReason` in `packages/sdk/src/api.ts`). The spend window is the program's rolling cap: buys within
  `spend_window_secs` may spend at most `max_window_spend_bps` of the equity at the window's start
  (`spendWindowRemaining` from the SDK; skip reason `spend_window`). A cap the program enforces but the keeper's
  read missed (`SpendWindowExceeded`, `ExceedsImpact` in simulation) is reported as the matching skip, not a failure.
- **Execution** builds the instruction with the SDK, simulates at 1.4M CU, sets the limit to simulated × 1.1, bids
  the 75th percentile of recent fees for the written accounts (clamped to the configured bounds), and appends the SPL
  memo `copier:<target signature>` so the indexer links the copy to the trade it answers. With `JITO_URL` the
  transaction is sent only as a Jito bundle with a tip transfer that also lists the read-only
  `jitodontfront111111111111111111111111111111` account (no transaction may be placed ahead of it in the bundle).
  Every copy-vault trade or burn goes in its own transaction (the program rejects any other venue or copy-vault instruction
  beside it): only compute budget, the memo and the Jito tip share it.
- **Cranks** (every `CRANK_MS`, per copier, keeper key required): distribute creator fees when a simulation shows
  the vault gaining ≥ `DISTRIBUTE_MIN_LAMPORTS` (else a bare `sync` if lamports arrived otherwise),
  `fund_platform_burn` for a pending the platform token share, `buyback_burn` when the pool holds ≥ 0.05 SOL (sized to the
  impact cap), `burn_platform` when the burn pool holds ≥ 0.05 SOL and `config.platform_mint` is set, and sells of any
  position whose `allowedSell` is positive (max-hold exits, sells the detector missed). Failures back off per
  (copier, crank, and per position for exits) up to an hour. `burn_platform` waits the program's 60 s between calls
  (`config.last_platform_burn_ts`); buyback and burn sizes are capped at `max_impact_bps` of the venue's real SOL.
- **Heartbeat**: `keeper_heartbeat` every 60 s unless a keeper-signed trade or burn landed within the minute (those
  refresh `config.keeper_heartbeat_ts` too). Without one for `keeper_grace_secs`, anyone may exit positions whose
  target holds nothing. `/status` → `heartbeat` shows the last attempt and the on-chain timestamp.
- **Reporting**: each decision is queued in a SQLite outbox and POSTed in batches of ≤ 50 to
  `${INDEXER_URL}/internal/target-trades` with `Authorization: Bearer ${INDEXER_INGEST_TOKEN}`. The indexer upserts
  on (copier, signature), so retries are harmless; outages only delay reports.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `RPC_URL` | `http://127.0.0.1:8899` | JSON-RPC endpoint |
| `WS_URL` | derived (`https→wss`, port + 1) | JSON-RPC websocket |
| `GRPC_URL`, `GRPC_TOKEN` | off | Yellowstone gRPC endpoint and x-token (Triton, Helius LaserStream, QuickNode, Shyft…) |
| `KEEPER_SECRET_KEY` | unset | keeper secret key as a value: the 64-byte JSON array of a keypair file, or base58 (wallet export). For hosts that inject secrets as variables (Railway). Parsed at startup, never logged; garbage fails the start. Set it **or** `KEEPER_KEYPAIR`, not both |
| `KEEPER_KEYPAIR` | localnet: `.localnet/keeper.json`; off localnet one of the two is required | keeper keypair JSON (path, relative to the repo root) |
| `INDEXER_URL` | localnet: `http://127.0.0.1:8790`; required elsewhere | indexer base URL |
| `INDEXER_INGEST_TOKEN` | localnet: `copier-localnet-ingest` | bearer for `/internal/target-trades` |
| `JITO_URL`, `JITO_TIP_LAMPORTS` | off, `1000000` | Jito block engine (e.g. `https://mainnet.block-engine.jito.wtf`) and tip |
| `PRIORITY_MICROLAMPORTS` | `10000` (localnet `0`) | priority fee floor (µlamports/CU) |
| `MAX_PRIORITY_MICROLAMPORTS` | `2000000` (localnet `0`) | priority fee cap |
| `STATUS_PORT`, `STATUS_HOST` | `8792`, `127.0.0.1` | status API (`PORT` is honoured on PaaS, then host `0.0.0.0`; the Docker image sets `::`) |
| `KEEPER_DB` | `apps/watcher/.keeper.db` (localnet `.keeper-localnet.db`; Docker image `/data/keeper.db`) | SQLite state |
| `COMMITMENT` | `confirmed` | reads, subscriptions, confirmation |
| `DRY_RUN` | off | decide and report (`skipped`/`paused`), never send |
| `COPIER_ALT` | localnet: `.localnet/config.json` `alt` | lookup table for v0 sends |
| `COPIER_REFRESH_MS` | `30000` | copier/position reload |
| `CRANK_MS` | `60000` | crank round |
| `POLL_MS`, `POLL_FALLBACK_MS` | `15000`, `3000` | poll cadence healthy / degraded |
| `FETCH_CONCURRENCY` | `4` | parallel `getTransaction` |
| `MAX_SIGNAL_AGE_SECS` | `90` | older buys are `stale_signal` |
| `CONVICTION_K`, `CONVICTION_FLOOR_BPS` | `4`, `2500` | conviction scaling |
| `DEAD_QUOTE_LAMPORTS` | `200000000` | venue real SOL below this is `token_dead` |
| `REENTRY_COOLDOWN_SECS` | `120` | repeat buys of a mint within this are `reentry_cooldown`; on an index copier a buy of a token whose position another basket wallet opened is `held_by_other_target` (one target per position, enforced on-chain) |
| `BUYBACK_MIN_LAMPORTS` | `50000000` | buyback / burn-pool threshold |
| `DISTRIBUTE_MIN_LAMPORTS` | `1000000` | minimum vault gain to send the fee crank |

Never put keyed RPC URLs in logs: the keeper only ever logs URL origins.

## Operations

- **Modes** (`/status` → `mode`): `live` (key loaded and equal to `config.keeper`), `paused` (the admin ran
  `pause_keeper`: `config.keeper` is unset; nothing is sent, decisions are reported `skipped` / `paused`), `observe`
  (no key yet, or a different key: detection, decisions and reports run; every would-be trade is reported `skipped`
  with `keeper_not_authorized` and the planned size), `dry-run` (`DRY_RUN=1`, reason `paused`). The keypair file is
  re-read every refresh until it exists, so starting before `pnpm setup:localnet` is fine.
- **Pre-launch**: before the program is deployed or its Config initialized, the keeper starts normally in `observe`
  and re-checks every `COPIER_REFRESH_MS`; `/status` → `program` is `{ deployed, configInitialized }` and each change
  logs `program_state`. Once both appear (and `config.keeper` is this key) it turns `live` without a restart.
- **`GET /status`**: keeper key, mode, program state, config params, copiers/targets, detector health (websocket connected/healthy,
  subscriptions, refused subscriptions, poll cadence, fetch queue, per-source counts, gRPC state), counters (all
  time and last 24 h by status), the last 50 decisions, the last 50 crank attempts, reporter backlog, send settings.
- **Logs** are one JSON object per line (`event` field): `program_state`, `targets_loaded`, `target_trade`, `decision`, `crank`,
  `ws_reconnect`, `ws_subscribe_refused`, `poll_failed`, `report_retry`, `grpc_*`.
- **Keeper wallet**: pays fees, priority fees and Jito tips (never trade size — that is vault SOL). Keep it funded;
  `/status` decisions turn `failed` with `send_failed` when it runs dry.
- **Restarts** are safe: seen signatures, poll cursors and the report outbox live in SQLite. On start the keeper
  backfills from each target's cursor; buys older than `MAX_SIGNAL_AGE_SECS` are reported `stale_signal`, sells
  converge from state anyway. A new target's history is never replayed (its cursor is primed at the newest
  signature).

## Failure modes

| Symptom | Cause | Behaviour / action |
|---|---|---|
| `ws_subscribe_refused` for `programSubscribe` | provider blocks token-program subscriptions | polling switches to `POLL_FALLBACK_MS`; lamport changes still trigger a re-read of tracked token accounts. Prefer a provider that allows it, or set `GRPC_URL` |
| `ws_reconnect` loops | websocket down/stale (no slot for 10 s) | exponential back-off to 30 s; fast polling meanwhile; every reconnect backfills |
| `grpc_unavailable` | the Yellowstone N-API binding is not published for this OS (Windows) | websocket + poll detection continue; run on Linux/macOS for gRPC |
| decisions `failed` / `simulation_failed` | the program would reject (price moved, target sold before we landed, cap changed) | nothing sent, no fee spent; the detail carries the program error |
| decisions `failed` / `send_failed` | expired blockhash, landed-but-failed, RPC/Jito error, keeper out of SOL | the vault state is unchanged; sells converge on the next crank round |
| `skipped` / `migrating` on a sell | coin graduated, pool not created yet | the exit crank retries every round |
| `report_retry` | indexer unreachable or rejecting | reports stay in the outbox with back-off up to 5 min; a single invalid report (HTTP 400) is dropped and logged |
| `refresh_failed` | RPC unreachable | last good registry stays active; retried every refresh |
| `program_state` `not deployed` / `config not initialized` | pre-launch | normal: `observe`, re-checked every refresh; nothing to do until setup runs |
| `signature_given_up` | a transaction could not be fetched 5 times | logged and marked seen; state-based sells still converge |
| mode stays `observe` | key missing or ≠ `config.keeper` | run `pnpm setup:localnet` (localnet), or the admin proposes this key (`propose_keeper`) and anyone runs `execute_pending` after the timelock |
| mode `paused` | the admin ran `pause_keeper` | nothing is sent; a keeper comes back only through `propose_keeper` + timelock |
| `heartbeat_failed` | keeper out of SOL, RPC down, keeper removed | fund / fix it before `keeper_grace_secs` passes, or exits turn permissionless |
| `cluster_changed` | the RPC serves a different genesis (localnet wiped and re-seeded) | seen signatures, cursors, decisions and pending reports are dropped, targets re-primed, lookup table reloaded — no restart needed |
| `cursor_reset` | a stored cursor signature is unknown to the node (-32020: pruned history / other ledger) | the cursor is dropped and the address re-primed |

MEV notes: the vault's reaction to a target trade is public and predictable. Mitigations in place: on-chain
`min_tokens_out` / `min_sol_out` from fresh reserves less `slippage_bps`, the impact cap, the signal cap (c ≤ 1),
the re-entry cooldown, and Jito bundles with `jitodontfront` when `JITO_URL` is set. Separate front-running
transactions earlier in the same slot remain possible; the slippage bound turns them into a skipped copy, not a loss.
