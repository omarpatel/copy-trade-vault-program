# copy-vault — system spec (contract for every component)

Research behind the pump integration: `docs/research/{pump-integration,fee-sharing}.md`.

## 0. Product rules (user requirements — not negotiable)

1. Anyone launches a pump.fun coin tied to one public wallet (the **target**, usually a KOL).
2. The coin's creator fees fund an on-chain **vault** that copy-trades the target in real time.
3. The launcher picks the target's cut of creator fees: **1%–25%** (100–2500 bps). The rest goes to the vault.
4. When the vault realizes profit (above its high-water mark): **75% buys back & burns the coin**, **25% buys back &
   burns the platform token**.
5. **the platform token** is the platform coin: an *index copier* that copies a basket of KOL wallets, seeded with 30 SOL
   (`deposit`) plus 100% of its own creator fees (target cut 0). Its 25% profit share buys back the platform token itself.
6. No withdraw instruction exists. No one can take vault SOL out except through copier trades, buybacks/burns.

## 1. Fee routing (pump-native fee sharing, decided)

Launch tx (one v0 tx, signers launcher + mint keypair, Copier platform ALT):
`ComputeBudget` → pump `create_v2(name, symbol, uri, creator=launcher, mayhem=false, cashback=[false], creator_fee_bps=[0], holder_reward=[false])`
→ pump_fees `create_fee_sharing_config` → pump_fees `update_fee_shares_v2([{target, X}, {vault, 10000−X}])`
(admin revoked ⇒ split immutable) → copier `register_copier(X)`.
Optional dev buy = second tx (Jito bundle when `JITO_URL` set, else sent right after). Index copiers (admin):
shareholders `[{vault, 10000}]`.

Fees are paid by pump's permissionless `distribute_creator_fees_v2` (keeper crank: prepend `sweep_creator_fee`
(curve) and, after graduation, pool `sweep_creator_fee` + `transfer_creator_fees_to_pump_v2`). The target receives
SOL directly from pump; the vault receives SOL as lamports on its zero-data PDA. The program books any lamports on
the vault it did not move itself as **fee income** (`sync`, run at the top of every vault instruction).

## 2. Program `programs/copy-vault` (Anchor 0.31.1, id `9R8g8JtEqRAh5yZ4aXbf1mWcfgLq9kAo6fmx93MSK9k7`)

Keypair: generate one outside the repo and copy it to `target/deploy/copy_vault-keypair.json` before a deploy build.
Build: `anchor build` (Linux, macOS or WSL).

### PDAs
| Account | Seeds | Kind |
|---|---|---|
| `Config` | `["config"]` | program-owned data |
| `Copier` | `["copier", mint]` | program-owned data (state) |
| vault | `["vault", mint]` | **system-owned, zero data**; holds SOL, signs pump trades, owns ATAs (wSOL + positions + own-coin for burn) |
| `Position` | `["position", mint, token_mint]` | program-owned data; one per (copier, traded mint) |
| burn pool | `["platform-burn"]` | system-owned zero data; receives the 25% the platform token share, buys + burns the platform token |

### Config (admin = deployer, later a multisig; every change timelocked)
`admin, pending_admin, pending_admin_eta, keeper, keeper_heartbeat_ts, timelock_secs, next_change_id, platform_mint
(Pubkey::default until set once), params, descriptors: Vec<TradeDescriptor> (≤ 32), last_platform_burn_ts, bumps`.
`params` (changed only via `propose_params` → timelock → `execute_pending`, inside the inclusive ranges in `constants.rs`):
| param | default | range |
|---|---|---|
| `max_trade_bps` (of vault equity per buy) | 1000 | 1–2500 |
| `max_position_bps` (cost basis per mint, of equity) | 2000 | 1–3500 |
| `max_open_positions` | 12 | 1–24 |
| `min_trade_lamports` | 10_000_000 | 1e6–1e9 |
| `min_signal_lamports` (target delta × spot) | 50_000_000 | 1e6–1e10 |
| `signal_multiple_bps` (vault buy ≤ this × signal) | 10000 | 1–10000 (anti-bait c ≤ 1) |
| `max_impact_bps` (sol_in vs venue real quote reserves) | 300 | 50–1000 |
| `slippage_bps` (program floor vs fee-free quote) | 500 | 300–1500 |
| `vault_floor_lamports` (never spent) | 20_000_000 | 5e6–1e9 |
| `max_hold_secs` (sell allowed regardless of target) | 604_800 | 86_400–2_592_000 |
| `keeper_grace_secs` (heartbeat age before exits turn permissionless) | 3_600 | 600–604_800 |
| `spend_window_secs` | 3_600 | 600–86_400 |
| `max_window_spend_bps` (buys per window, of window-start equity) | 3000 | 500–5000 |
Fixed constants (user rules): `TRADER_MIN_BPS=100`, `TRADER_MAX_BPS=2500`, `PROFIT_PLATFORM_BPS=2500`,
`PROFIT_BUYBACK_BPS=7500`, `MAX_INDEX_TARGETS=16`.

`TradeDescriptor { program: Pubkey (pump|pump_amm only), disc: [u8;8], side: Buy|Sell, venue: Curve|Pool, user_idx: u8,
base_mint_idx: u8, venue_idx: u8 (curve or pool account), min_accounts: u8 }`. Seeded by `initialize_config` with
pump `buy_v3`, `sell_v3`, `buy_exact_quote_in_v3`, `buy_v2`, `sell_v2`, `buy_exact_quote_in_v2` and pump_amm
`buy_exact_quote_in_v2`, `sell_v2`, `buy_exact_quote_in`, `sell` (indices from `docs/research/pump-integration.md` §2–3).
Never whitelisted: create*, extend*, *volume_accumulator*, migrate, deposit, withdraw, create_pool, admin ixs.

### Copier (state)
`mint, launcher, kind: Single|Index, targets: Vec<Pubkey> (1 for Single, ≤16 for Index), trader_bps: u16,
verified: u16 bitmask (target i signed verify_trader), vault_bump, created_at, sharing_config,
accounted_lamports (vault lamports + wSOL the program knows about), fees_in, capital_in, open_cost, open_positions,
realized_pnl: i64, hwm: i64, buyback_pool, platform_sent, burned (own-coin tokens), buyback_spent, trades, last_keeper_ts,
graduated_pool: Pubkey (default until seen)`.
Equity (lamports) = vault free SOL (lamports − rent − buyback_pool) + wSOL + `open_cost`.

### Instructions
| ix | signer | rules |
|---|---|---|
| `initialize_config(keeper, timelock_secs)` | upgrade authority | once; seeds descriptors + default params immediately; `timelock_secs` 60..=604800 |
| `propose_keeper` / `propose_params` / `propose_descriptors` / `propose_index_targets` | admin | stores a `PendingChange` PDA `["pending", id]` with `eta = now + timelock`; params two-sided ranges, descriptors keep ≥1 buy + ≥1 sell per venue. Emits `ChangeProposed` |
| `execute_pending` / `cancel_pending` | anyone after ETA / admin | applies or drops the change. Emits `ChangeExecuted` / `ChangeCancelled` |
| `pause_keeper` | admin | **instant**: keeper → default (only removes power). Emits `KeeperPaused` |
| `keeper_heartbeat` | keeper | updates `Config.keeper_heartbeat_ts` (permissionless exits key off it) |
| `propose_admin` / `accept_admin` | admin / pending admin | two-step; accept waits for the timelock |
| `set_platform_mint(mint)` | admin | once; mint must be a registered Index copier |
| `register_copier(trader_bps)` | launcher | checks in `docs/research/fee-sharing.md` §7 verbatim (sharing_config v2, Active, admin_revoked, exactly 2 shareholders = target X / vault 10000−X, 100 ≤ X ≤ 2500; bonding curve creator == sharing_config, !complete, !mayhem, !cashback, !holder_reward, SOL quote; mint owner Token-2022; target system-owned & not executable; vault PDA zero data). Funds vault rent from launcher. Emits `CopierRegistered` |
| `register_index(targets)` | admin | same checks with shareholders `[vault 10000]`, trader_bps 0 |
| `propose_index_targets(targets)` | admin | Index only; ≤16; cannot remove a target that has open positions (timelocked as above) |
| `deposit(lamports)` | anyone | capital (not profit). Emits `Deposited` |
| `sync` | anyone | books unexplained vault lamports as `fees_in`. Emits `FeesSynced` if > 0 |
| `verify_trader(target_idx)` / `unverify_trader` | target wallet | sets/clears bit. Emits `TraderVerified` |
| `copier_buy(target_idx, descriptor_idx, sol_in, min_tokens_out, ix_data)` + remaining = venue ix accounts | keeper | see below |
| `copier_sell(target_idx, descriptor_idx, tokens_in, min_sol_out, ix_data)` + remaining | keeper; anyone if `now − config.keeper_heartbeat_ts > keeper_grace_secs` **and** target balance == 0 (then ≤ one impact-capped slice per copier per slot) | see below |
| `buyback_burn(descriptor_idx, sol_in, min_tokens_out, ix_data)` + remaining | keeper | spends `buyback_pool` on the copier's own mint, ≤ `max_impact_bps` of venue real SOL per call, burns everything bought (Token-2022 `burn_checked`, vault signs). Floor: ≥ (10000−slippage_bps) of fee-free quote. ≥ 60s between calls. Emits `BuybackBurned` |
| `fund_platform_burn` | anyone | moves this copier's pending 25% share to the burn pool (also done inline on profit). |
| `burn_platform(descriptor_idx, sol_in, min_tokens_out, ix_data)` + remaining | keeper | burn pool buys `config.platform_mint` (≤ impact cap per call, ≥ 60 s apart) and burns. Emits `PlatformBurned` |

**Transaction guard** (`copier_buy`, `copier_sell`, `buyback_burn`, `burn_platform`; instructions sysvar as the last
named account): the instruction must be top-level and the only copy-vault trade/burn in the tx; every other instruction
must be ComputeBudget, SPL Memo, ATA `create_idempotent` or System `transfer`, and none may list the curve/pool
(`VenueTouchedInTx`). **Spend window:** buys within `spend_window_secs` spend ≤ `max_window_spend_bps` of the equity
at the window's start (`SpendWindowExceeded`). Full trust model: `docs/PROGRAM.md`.

**copier_buy checks** (all on-chain): `sync`; descriptor whitelisted & side Buy; `remaining[user_idx] == vault`
and vault appears nowhere else, is the only signer; `remaining[base_mint_idx] == token_mint`; venue account is the
canonical curve/pool PDA for `token_mint`, SOL-quoted, not mayhem; `token_mint != copier.mint`; target ATA
(canonical for target + token program) balance `now > position.target_snapshot`; signal =
`(now − snapshot) × spot_price(venue)` ≥ `min_signal_lamports`; `sol_in ≤ signal × signal_multiple_bps/1e4`,
`sol_in ≤ equity × max_trade_bps/1e4`, `position.cost + sol_in ≤ equity × max_position_bps/1e4`,
`sol_in ≤ venue_real_quote × max_impact_bps/1e4`, `sol_in ≥ min_trade_lamports`, free SOL after ≥ `vault_floor`,
`open_positions < max` for new positions. Pool venue: program wraps `sol_in` into the vault wSOL ATA
(system transfer + sync_native). CPI with vault signer. After: Δtokens ≥ max(min_tokens_out, program floor),
Δ(lamports+wSOL) ≤ sol_in + rent allowance (UVA/ATA rent ≤ 0.01 SOL, booked as cost). Update position
(tokens, cost, target_snapshot = target_peak = now, vault_peak = tokens). Emits `CopierBuy`.

**copier_sell checks:** `sync`; descriptor Sell; same account-role checks; position exists; target balance `now`:
allowed = `tokens − floor(vault_peak × now / target_peak)` when `now < target_snapshot`; or all tokens when
`now_ts − position.opened_at > max_hold_secs`; `tokens_in ≤ allowed`. After CPI: Δtokens == tokens_in (± 0),
proceeds = Δ(lamports + wSOL) ≥ max(min_sol_out, program floor). Cost removed = `cost × tokens_in / tokens`
(rounded up). `pnl = proceeds − cost_removed`; `realized_pnl += pnl`; if `realized_pnl > hwm`:
`excess = realized_pnl − hwm; hwm = realized_pnl; buyback_pool += excess×75%; transfer excess×25% to burn pool
(Index copier whose mint == config.platform_mint: 100% to its own buyback_pool)`. `target_snapshot = now`.
Close position when tokens == 0 (rent back to vault). Emits `CopierSell` + `ProfitSplit` when excess > 0.

### Events (exact names; indexer contract)
`CopierRegistered{mint, launcher, kind, targets, trader_bps, sharing_config, ts}`, `FeesSynced{mint, lamports, total, ts}`,
`Deposited{mint, from, lamports, ts}`, `TraderVerified{mint, target, verified, ts}`,
`CopierBuy{mint, target, token_mint, venue, sol_in, tokens_out, target_balance, signal_lamports, equity, ts}`,
`CopierSell{mint, target, token_mint, venue, tokens_in, sol_out, cost_removed, pnl, realized_pnl, hwm, forced: bool, ts}`,
`ProfitSplit{mint, excess, to_buyback, to_platform, ts}`, `BuybackBurned{mint, sol_in, tokens_burned, total_burned, ts}`,
`PlatformBurned{sol_in, tokens_burned, ts}`, `ParamsUpdated{...}`, `IndexTargetsSet{mint, targets}`,
`ChangeProposed{id, kind, eta, ts}`, `ChangeExecuted{id, kind, ts}`, `ChangeCancelled{id, kind, ts}`, `KeeperPaused{keeper, ts}`.
The keeper adds an SPL Memo `copier:<target_signature>` to each `copier_buy`/`copier_sell` tx so the copy is
publicly linked to the target trade it answers (indexer derives copy lag = vault block time − target block time).

### Tests (`tests/program`, litesvm; fixtures dumped from mainnet)
Must cover: launch tx end-to-end (create_v2 + fee sharing + register) and every register rejection; fee
distribution lands in vault and `sync` books it; copier_buy happy path on curve (v3) and pool (AMM v2 after
graduation); every copier_buy rejection (no target increase, airdrop-only small signal, caps, vault elsewhere in
accounts, non-whitelisted disc, wrong mint, own mint); proportional copier_sell; forced exit after max_hold;
permissionless exit after keeper grace only when target balance 0; HWM split math (loss then win); buyback_burn
reduces supply; burn_platform; invariant after every step: vault lamports ≥ rent + floor-or-less-only-by-trades, no
instruction moves SOL to any account other than venue accounts, burn pool, or position rent.

## 3. SDK `packages/sdk` (`@copy-trade-vault/sdk`, TS, web3.js 1.99 + @coral-xyz/anchor 0.31.1, bigint math)

Exports (names are the contract):
- consts: `COPIER_PROGRAM_ID, PUMP_PROGRAM_ID, PUMP_AMM_PROGRAM_ID, PUMP_FEES_PROGRAM_ID, WSOL_MINT, TOKEN_2022_PROGRAM_ID, TRADER_MIN_BPS, TRADER_MAX_BPS, PROFIT_PLATFORM_BPS, PROFIT_BUYBACK_BPS`
- PDAs: `configPda(), copierPda(mint), vaultPda(mint), positionPda(mint, tokenMint), burnPoolPda(), bondingCurvePda(mint), sharingConfigPda(mint), creatorVaultPda(creator), canonicalPoolPda(mint), ammCreatorVaultAuthority(coinCreator)`
- decoders: `decodeConfig, decodeCopier, decodePosition, decodeBondingCurve, decodePool, decodeSharingConfig`
- math: `curveBuyQuote(curve, solIn, feeBps)`, `curveSellQuote`, `poolBuyQuote`, `poolSellQuote`, `spotPriceLamportsPerToken`, `marketCapLamports`, `allowedSell(position, targetNow)`, `profitSplit(realized, hwm, pnl)`, `estimateCreatorFees(volumeLamports, mcapLamports)` (fee tiers from research §4)
- builders (return `TransactionInstruction[]`): `buildLaunchIxs({launcher, mint, name, symbol, uri, target, traderBps})`, `buildDevBuyIxs`, `buildCopierBuyIx({keeper, mint, targetIdx, tokenMint, solIn, minTokensOut, venue})`, `buildCopierSellIx`, `buildBuybackBurnIx`, `buildBurnPlatformIx`, `buildDistributeFeesIxs({payer, mint, graduated})`, `buildSyncIx`, `buildDepositIx`, `buildVerifyTraderIx`, `buildRegisterIndexIx`, admin builders
- venue: `resolveVenue(conn, tokenMint) → {kind: 'curve'|'pool'|'unsupported', accounts, reserves}` (curve PDA exists & !complete → curve v3; else canonical pool → AMM v2; else unsupported)
- events: `parseCopierEvents(logs: string[]) → CopierEvent[]` (typed union of §2 events)
- format: `fmtSol, fmtPct, shortAddr, fmtCompact`
- `idl/copy_vault.json` + `idl/copy_vault.ts` synced from `target/` by `pnpm --filter @copy-trade-vault/sdk sync-idl`.
Unit tests (`node --test` via tsx) for math vs. program semantics.

## 4. Keeper `apps/watcher` (`@copy-trade-vault/watcher`)

Env: `RPC_URL`, `WS_URL?`, `GRPC_URL?`/`GRPC_TOKEN?`, `KEEPER_KEYPAIR` (path) or `KEEPER_SECRET_KEY` (value), `INDEXER_URL`, `INDEXER_INGEST_TOKEN`,
`JITO_URL?`, `JITO_TIP_LAMPORTS?`, `PRIORITY_MICROLAMPORTS?`, `STATUS_PORT=8792`. Indexer listens on 8790.
- **Detection**: per target wallet `accountSubscribe(lamports)` + `programSubscribe`
  (Token & Token-2022, memcmp owner@32 = target); on change, confirm with `getSignaturesForAddress(<token account>)`
  + raw JSON-RPC `getTransaction(maxSupportedTransactionVersion: 1)` (do not parse v1 txs with web3.js); poll
  fallback; optional Yellowstone gRPC when `GRPC_URL` set. Dedup by signature; persist cursor (node:sqlite).
- **Classify**: target must be a signer; balance deltas with wSOL folded;
  BUY / SELL / TRANSFER / AIRDROP; target spent SOL, price.
- **Policy**: skip with a recorded reason when: unsupported venue, signal < min, cap hit, max positions, own mint,
  target == token creator, token dead. Size = `min(equity × max_trade, target_spent × signal_multiple, impact cap,
  position cap)` scaled by conviction (`target_spent / target_sol_before`). Sell = `allowedSell`.
- **Execute**: build via SDK, simulate, set CU = simulated × 1.1, memo `copier:<sig>`, send (Jito when configured).
- **Cranks**: every 60s per copier: distribute fees (when distributable) + `sync`; `buyback_burn` when pool ≥ 0.05 SOL;
  `burn_platform` when burn pool ≥ 0.05 SOL and platform_mint set; max-hold exits.
- **Reports** every observed target trade + decision (copied with vault sig / skipped with reason) to indexer
  `POST /internal/target-trades` (bearer `INDEXER_INGEST_TOKEN`). Status API `GET /status`.

## 5. Indexer + API `apps/indexer` (`@copy-trade-vault/indexer`, fastify, node:sqlite)

Backfill + live `logsSubscribe(mentions program)` + poller for the program, decode events
via SDK, maintain tables: copiers, positions, trades (vault), target_trades (from keeper ingest), fees, burns,
deposits, coin_snapshots (own-coin price/mcap/supply each 15s from curve/pool), candles (1m from vault equity and
coin price), traders (directory). Curated directory rows come from `apps/indexer/src/kols.json` (a synthetic sample; replace with your own list).
Uploads: `POST /api/upload` (image + metadata JSON → IPFS via Pinata when `PINATA_JWT`, else pump.fun `/api/ipfs`).

REST (JSON, lamports as strings, timestamps unix seconds):
- `GET /api/stats` → `{copiers, tvlLamports, feesLamports, burnedValueLamports, platformBurnLamports, copies24h, avgLagMs}`
- `GET /api/copiers?sort=pnl|tvl|new|fees&kind=&q=` → `CopierSummary[]`
- `GET /api/copiers/:mint` → `CopierDetail` (summary + targets + verified + params snapshot + coin metadata)
- `GET /api/copiers/:mint/positions` → `Position[]` (with mark price, unrealized)
- `GET /api/copiers/:mint/copies?limit=` → `Copy[]` (target trade ↔ vault trade, lag, status copied|skipped, reason)
- `GET /api/copiers/:mint/equity?range=` → `[ts, equityLamports][]`; `/candles` own-coin price candles
- `GET /api/traders/:address` → profile (directory entry, copiers tracking it, total earned from fee share, recent trades)
- `GET /api/traders?q=` → directory (for the launch wizard)
- `GET /api/burns` → recent burns (both kinds); `GET /api/feed` → global live feed (copies, burns, launches)
- `GET /api/platform-token` → the platform token index: targets with weights/PnL, burn pool, total burned, seed capital
- `POST /api/upload`, `POST /internal/target-trades` (auth)
- WS `/ws` → messages `{type: 'copy'|'trade'|'burn'|'launch'|'fees'|'stats', data}`

Types `CopierSummary`, `CopierDetail`, `Position`, `Copy`, ... are defined once in `packages/sdk/src/api.ts` and
imported by the indexer and the scripts.

## 6. Localnet `scripts/`
`localnet.mjs` (WSL `solana-test-validator` with mainnet pump/pump_amm/pump_fees programs + required accounts
cloned/dumped, deploy copier), `setup.ts` (config, ALT, keeper), `seed.ts` (KOL test keypairs, launches, the platform token
index + 30 SOL deposit, target trades), `simulate.ts` (continuous random target trades + public volume on the
copier coins so fees flow).
