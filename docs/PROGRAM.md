# copy-vault on-chain program (`programs/copy-vault`)

Anchor 0.31.1, program id `9R8g8JtEqRAh5yZ4aXbf1mWcfgLq9kAo6fmx93MSK9k7`. This document covers the
implemented program; the contract it follows is `docs/SPEC.md` §2 and the research behind it is in
`docs/research/{pump-integration,fee-sharing}.md`.

```
programs/copy-vault/src/
  lib.rs            instruction entry points
  constants.rs      seeds, the product-rule constants, parameter defaults and two-sided ranges
  state.rs          Config / Params / TradeDescriptor, PendingChange, Copier, Position
  guard.rs          same-transaction isolation of trades and burns (instructions sysvar)
  events.rs         the indexer-facing events
  errors.rs         CopierError
  pump.rs           pump / pump_amm / pump_fees ids, PDAs, account views, forbidden discriminators
  math.rs           u128 overflow-checked arithmetic (constant-product quotes, bps, floors)
  venue.rs          the generic pass-through venue CPI (checks, wSOL wrap/unwrap, burn)
  instructions/     admin.rs, register.rs, vault.rs, trade.rs, burn.rs
tests/program/      litesvm suite against the mainnet pump programs (fixtures/ + dump-fixtures.sh)
```

## Build and test

```bash
anchor build                         # → target/deploy/copy_vault.so, target/idl/copy_vault.json
cargo test -p copy-vault-tests
bash tests/program/dump-fixtures.sh   # refresh the mainnet program + account fixtures (WSL, solana CLI)
```

Set `COPIER_LOGS=1` to print the logs of every copy-vault instruction the suite sends; run with
`-- --nocapture` to see the `CU <label> <units>` lines.

## Accounts

| Account | Seeds | Owner / kind | Contents |
|---|---|---|---|
| `Config` | `["config"]` | program | `admin, pending_admin, keeper, platform_mint, params, descriptors (≤ 32), bump, burn_pool_bump, platform_burned, platform_burn_spent, timelock_secs, next_change_id, pending_admin_eta, keeper_heartbeat_ts, last_platform_burn_ts, latest_change_ids[4], descriptors_proven` |
| `PendingChange` | `["pending", id u64 LE]` | program | `id, kind (Keeper / Params / Descriptors / IndexTargets), proposer, proposed_at, eta, expires_at, keeper, params, descriptors (≤ 32), copier, targets (≤ 16), bump`; only the payload of its kind is meaningful; closed (rent to the proposer) on execute / cancel / discard |
| `Copier` | `["copier", mint]` | program | `mint, launcher, kind (Single/Index), targets (≤ 16), trader_bps, verified (bitmask), vault_bump, bump, created_at, sharing_config, accounted_lamports, fees_in, capital_in, open_cost, open_positions, realized_pnl, hwm, buyback_pool, platform_sent, burned, buyback_spent, trades, last_keeper_ts, graduated_pool, platform_pending, last_buyback_ts, target_positions[16], window_start, window_spent, window_equity, last_public_sell_slot` |
| vault | `["vault", mint]` | System, **zero data** | the copier's SOL; pump `user` for every trade; owns its token accounts |
| `Position` | `["position", mint, token_mint]` | program | `mint, token_mint, target, tokens, cost, target_snapshot, target_peak, vault_peak, opened_at, last_trade_ts, bump` |
| burn pool | `["platform-burn"]` | System, zero data | the 25% the platform token share; pump `user` for `burn_platform` |

The vault and burn pool are system-owned so pump can move SOL out of them with System `transfer`
while copy-vault signs (`invoke_signed`). All state lives in the separate program-owned accounts.

Fields beyond the SPEC list: `Copier.platform_pending` (the 25% share not yet moved to the burn
pool), `Copier.last_buyback_ts` (60 s buyback spacing), `Copier.target_positions` (open positions
per target index, so an IndexTargets change can't drop a target with open positions), the spend
window (`window_*`), `last_public_sell_slot` (one permissionless slice per slot),
`Config.burn_pool_bump / platform_burned / platform_burn_spent`, the timelock and liveness fields, and
`Position.target / last_trade_ts / bump`.

## Accounting

`accounted_lamports` = vault lamports + the lamports at the vault's canonical wSOL ATA address, as
last left by the program. That address counts whether it holds an open wSOL account (wrapped amount
and rent) or is still uncreated but was sent lamports (system-owned, no data): either way a pool
trade's open → close returns all of it to the vault (`pump::wsol_address_lamports`). Anything above
`accounted_lamports` is fee income: `sync` (run at the top of every vault instruction) books it into
`fees_in` and emits `FeesSynced`, so before / after measurements of a trade stay symmetric and
donations never count as trading PnL. Between instructions the vault holds no wSOL account; a pool
buy wraps only the shortfall over what the address already holds. Lamports someone pre-sends to a
position PDA are kept up to its rent and the rest moves to the vault as `fees_in` when the position
opens. The burn pool's wSOL address is counted the same way for `burn_platform`.

- **free SOL** = lamports + wSOL address − rent(0 bytes) − `buyback_pool` − `platform_pending`
- **equity** = free SOL + `open_cost`
- **cost basis** of a buy = everything it cost the vault: the venue spend plus any rent it paid
  (position account, its token account, the venue's user-volume accumulator on the first trade).
- **sell proceeds** (`sol_out`) = everything that came back: the venue proceeds, plus the token
  account and position rent when the position closes. `pnl = sol_out − cost_removed`, with
  `cost_removed = ceil(cost × tokens_in / tokens)`.

Ledger identity, asserted after every step of the test suite:

```
accounted_lamports = rent + capital_in + fees_in + realized_pnl − open_cost − platform_sent − buyback_spent
```

## Instructions

| Instruction | Signer | Effect |
|---|---|---|
| `initialize_config(keeper, timelock_secs)` | program upgrade authority | creates `Config` with default params, the 10 seeded descriptors and the keeper (all immediate); `timelock_secs` ∈ 60..=604 800, fixed forever; funds the burn pool to rent |
| `propose_keeper(k)` / `propose_params(p)` / `propose_descriptors(v)` / `propose_index_targets(t)` | admin | validates the payload and stores it in `PendingChange ["pending", next_change_id]` with `eta = now + timelock_secs`, `expires_at = eta + 7 days`; it becomes the only executable proposal of its kind (`Config.latest_change_ids[kind]`), superseding the previous one (`ChangeInvalidated{reason: Superseded}`); emits `ChangeProposed{id, kind, eta, expires_at}` |
| `execute_pending` | **anyone**, `eta ≤ now ≤ expires_at` | only the live proposal of its kind (`PendingChangeSuperseded`, `PendingChangeExpired`); re-validates and applies the change (a new keeper gets a fresh heartbeat), closes the pending account; emits `ChangeExecuted` (+ `ParamsUpdated` / `IndexTargetsSet`) |
| `cancel_pending` | admin | closes the pending account; emits `ChangeCancelled` |
| `discard_pending` | **anyone** | closes a superseded / invalidated or expired change (`PendingChangeLive` otherwise), rent to its proposer; emits `ChangeDiscarded` |
| `pause_keeper` | admin, **instant** | `keeper = Pubkey::default()` and invalidates a queued Keeper change (`ChangeInvalidated{reason: KeeperPaused}`); emits `KeeperPaused` |
| `keeper_heartbeat` | keeper | `keeper_heartbeat_ts = now` (every keeper trade / burn does the same) |
| `propose_admin(a)` / `accept_admin` | admin / pending admin | two-step handover; accept only after `pending_admin_eta = proposal + timelock_secs`; accepting invalidates every change the previous admin queued (`ChangeInvalidated{reason: AdminChanged}`) |
| `set_platform_mint(mint)` | admin | once; the mint's copier must be `Index` |
| `register_copier(trader_bps)` | launcher | last ix of the launch tx; checks below; funds the vault to rent; emits `CopierRegistered` |
| `register_index(targets)` | admin | same checks with shareholders `[vault 10000]`; 1–16 distinct targets |
| `deposit(lamports)` | anyone | capital (not profit); emits `Deposited` |
| `sync` | anyone | books unexplained vault balance as `fees_in` |
| `verify_trader(i)` / `unverify_trader(i)` | `targets[i]` | sets / clears bit i; emits `TraderVerified` |
| `fund_platform_burn` | anyone | moves `platform_pending` (as far as lamports above rent allow) to the burn pool |
| `copier_buy(target_idx, descriptor_idx, sol_in, min_tokens_out, ix_data)` | keeper | see below |
| `copier_sell(target_idx, descriptor_idx, tokens_in, min_sol_out, ix_data)` | keeper; anyone once the keeper heartbeat is older than `keeper_grace_secs` **and** the target holds 0 (impact-capped slices, one per slot) | see below |
| `buyback_burn(descriptor_idx, sol_in, min_tokens_out, ix_data)` | keeper | `sol_in ≤ min(buyback_pool, max_impact_bps × venue real SOL)`; ≥ 60 s apart; buys the copier's own coin and `burn_checked`s everything bought; emits `BuybackBurned` |
| `burn_platform(descriptor_idx, sol_in, min_tokens_out, ix_data)` | keeper | `sol_in ≤ min(burn pool, max_impact_bps × venue real SOL)`; ≥ 60 s apart; the burn pool buys `config.platform_mint` and burns it; emits `PlatformBurned` |

### Parameters (`Params`, every one inside a two-sided range, `ParamOutOfRange` otherwise)

| param | range | default |
|---|---|---|
| `max_trade_bps` (of equity per buy) | 1 – 2 500 | 1 000 |
| `max_position_bps` (cost basis per mint) | 1 – 3 500 | 2 000 |
| `max_open_positions` | 1 – 24 | 12 |
| `min_trade_lamports` | 1e6 – 1e9 | 1e7 |
| `min_signal_lamports` | 1e6 – 1e10 | 5e7 |
| `signal_multiple_bps` | 1 – 10 000 | 10 000 |
| `max_impact_bps` (of venue real SOL) | 50 – 1 000 | 300 |
| `slippage_bps` (vs fee-free quote; must cover pump fees) | 300 – 1 500 | 500 |
| `vault_floor_lamports` | 5e6 – 1e9 | 2e7 |
| `max_hold_secs` | 1 day – 30 days | 7 days |
| `keeper_grace_secs` | 10 min – 7 days | 1 h |
| `spend_window_secs` | 10 min – 1 day | 1 h |
| `max_window_spend_bps` (of equity at window start) | 500 – 5 000 | 3 000 |

The descriptor whitelist (≤ 32): only pump (Curve) / pump_amm (Pool); never one of the 64 non-trade
discriminators of either program (`pump::FORBIDDEN_DISCRIMINATORS`: create*, extend*, volume
accumulators, migrate*, deposit, withdraw, create_pool, sweeps, claims, admin, Anchor IDL/event
tags); indices distinct and `< min_accounts ≤ 40`; at least one Buy and one Sell descriptor for both
venues (`DescriptorsIncomplete`); and, for each venue, at least one Sell descriptor byte-identical to
a **proven** descriptor of the current list (`DescriptorsDropProvenExit`). A descriptor is proven
when it was seeded by `initialize_config` (the mainnet-tested list) or a trade through it succeeded
(`Config.descriptors_proven`, bits carried over to identical descriptors when a list is replaced).
So a proposal can never leave a venue whose only exits have never worked: an exit can be retired
only after a replacement has executed a real sell. This guarantees descriptors that worked once,
not that pump keeps supporting them.

**Pending change status** (for indexers / UIs): a `PendingChange` account is *superseded* when
`Config.latest_change_ids[kind] != id` (a newer proposal of the kind, a keeper pause for Keeper
changes, an admin handover for all), *expired* after `expires_at`, *queued* before `eta`, otherwise
*executable*. Superseded and expired accounts can be closed by anyone with `discard_pending`.
One live proposal per kind at a time: Index target changes for two copiers must be queued one
after the other.

### `register_copier` checks (`docs/research/fee-sharing.md` §7)

- `sharing_config` = `PDA(["sharing-config", mint], pump_fees)`, owned by pump_fees, SharingConfig
  discriminator, version 2, status Active, `mint` matches, `admin_revoked` (the split is final),
  exactly two shareholders `{target: X, vault: 10000 − X}` in any order; `100 ≤ X ≤ 2500`.
- `bonding_curve` = `PDA(["bonding-curve", mint], pump)`, owned by pump, ≥ 125 bytes, creator ==
  sharing config, not complete, not mayhem, not cashback, not holder-reward, SOL-quoted.
- mint: Token-2022, initialized, no mint authority, no freeze authority, none of the extensions
  TransferFee, DefaultAccountState, NonTransferable, PermanentDelegate, TransferHook, Pausable.
- target: system-owned, not executable, not the vault. Vault: system-owned, zero data.

### Venue pass-through (`venue.rs`)

`remaining_accounts` = the exact account list of the pump / pump_amm instruction; `ix_data` = its
full data (discriminator included), forwarded verbatim. Before the CPI the program checks:

1. the descriptor exists and has the instruction's side; `ix_data[..8]` = its discriminator;
   `remaining.len() ≥ min_accounts`; the descriptor's program is among the accounts;
2. `remaining[user_idx]` is the vault (burn pool for `burn_platform`), writable, and appears nowhere
   else; it is the only account forwarded as a signer;
3. `remaining[base_mint_idx]` is the traded mint; `remaining[venue_idx]` is the canonical bonding
   curve (`!complete`, SOL-quoted, not mayhem) or the canonical PumpSwap pool (base = mint, quote =
   wSOL, not mayhem) of that mint;
4. no writable token account owned by the PDA other than its canonical token account for the
   traded mint and its wSOL account;
5. reserves for the program's own quote: curve virtual reserves, or pool quote balance + signed
   `virtual_quote_reserves` / base balance.

**Transaction isolation (`guard.rs`).** `copier_buy`, `copier_sell`, `buyback_burn` and
`burn_platform` read the instructions sysvar (their last named account) and fail with
`VenueTouchedInTx` unless every other instruction of the transaction is ComputeBudget, SPL Memo, ATA
`create_idempotent` or System `transfer` (a Jito tip) and none of them lists the venue account; they
must be top-level (`NotTopLevel`). Nothing in the same transaction can move the reserves the price
guards read, and there is exactly one copy-vault trade or burn per transaction.

Pool venues: the program creates the PDA's wSOL ATA if needed, wraps `sol_in` (System transfer +
`sync_native`), CPIs, then closes the wSOL account back into lamports. Fills are measured from the
PDA's lamports + wSOL and its token balance, never from the venue's own limits.

### `copier_buy`

`sync` → own mint refused → target is `targets[target_idx]`, its canonical ATA balance `now` >
`position.target_snapshot` (0 for a new position) → `signal = (now − snapshot) × spot` ≥
`min_signal_lamports` → `min_trade ≤ sol_in ≤ signal × signal_multiple_bps`, `sol_in ≤ equity ×
max_trade_bps`, `position.cost + sol_in ≤ equity × max_position_bps`, `sol_in ≤ venue real quote ×
max_impact_bps`, `open_positions < max_open_positions` for a new position → the transaction guard →
open a new spend window if `spend_window_secs` have passed (base = current equity) → create the
position (vault pays) and the vault token account if missing → CPI → `spent ≤ sol_in + 0.01 SOL`,
`window_spent + spent ≤ max_window_spend_bps × window_equity`, `tokens_out ≥ max(min_tokens_out,
(1 − slippage) × fee-free quote(sol_in))`, free SOL after ≥ `vault_floor` →
position `tokens += out, cost += spent, target_snapshot = target_peak = now, vault_peak = tokens` →
`CopierBuy`.

### `copier_sell`

`sync` → open position of this mint whose target is `targets[target_idx]` → permission (keeper, or
anyone once `now − config.keeper_heartbeat_ts > keeper_grace_secs` and the target holds 0, at most
once per copier per slot) → the transaction guard → a non-keeper slice's fee-free value must be ≤
`max_impact_bps` of the venue's real SOL → allowed =
`tokens − floor(vault_peak × now / target_peak)` when the target holds less than at the last copy
(or nothing), all tokens after `max_hold_secs`, else 0 → CPI → sold exactly `tokens_in`, proceeds ≥
`max(min_sol_out, (1 − slippage) × fee-free quote)` → cost basis, PnL, HWM split → closing sell
closes the empty token account and the position (rent back to the vault) → `CopierSell` (`forced`
for max-hold or non-keeper exits) and `ProfitSplit` when the HWM rises.

Profit split when `realized_pnl > hwm`: `excess = realized_pnl − hwm`, `hwm = realized_pnl`,
`buyback_pool += floor(excess × 7500 / 10000)`, the rest goes to the burn pool in the same
instruction (`platform_pending` → `platform_sent`). The platform token index copier (`mint ==
config.platform_mint`) keeps 100% in its own `buyback_pool`.

## Invariants (enforced on-chain, asserted by the suite after every step)

- vault lamports + wSOL = `accounted_lamports` after every program instruction; the ledger identity
  above holds; the vault stays ≥ rent; no wSOL account between instructions.
- `open_cost` = Σ position cost; `open_positions` = number of positions = Σ `target_positions`;
  the vault holds at least every position's tokens.
- No withdraw path: SOL leaves the vault only to venue accounts (inside a measured, whitelisted
  trade), to the burn pool (profit share) or into position / token-account rent that returns on
  close. The suite checks this on every trade instruction by diffing the balance of every account
  in the transaction (`Env::send_tracked`).
- Free SOL never drops below `vault_floor_lamports` through a buy; buys within a spend window never
  exceed `max_window_spend_bps` of the window's starting equity.
- `hwm ≥ max(0, realized_pnl)` and the HWM never decreases (the suite tracks the previous value per
  copier).
- The suite's lamport diff (`Env::send_tracked` + `Env::role_accounts`) allows balance changes only
  on the trading PDA, its position and token accounts, the burn pool, and the venue role accounts
  derived independently of the forwarded list: the canonical curve / pool and its vaults, the
  listed pump / PumpSwap fee recipients and their wSOL accounts, the creator vaults and the PDA's
  volume accumulators. Any other account in the transaction changing balance fails the test.

## Trust model

**Keeper (hot key, compromised = worst realistic case).** It can only call `copier_buy`,
`copier_sell`, `buyback_burn`, `burn_platform` and `keeper_heartbeat`, all bounded on-chain:
- It cannot sandwich inside its own transaction (transaction guard). It can still bundle separate
  transactions (pump the coin, make the vault buy, dump), so the program assumes every buy can be a
  total loss and caps buys: per copier, at most `max_window_spend_bps` (30%) of the equity at the
  window's start per `spend_window_secs` (1 h). The other buy checks (each buy ≤ 10% of equity, each
  position ≤ 20%, ≤ 3% of the venue's real SOL, a target-balance increase worth ≥ the buy) are
  per-transaction sanity checks only: against a keeper bundling transactions they don't bind (an
  earlier transaction can pump the reserves that value the signal and the impact cap, and anyone
  can send tokens to the target's account, which for a new position counts in full). **The spend
  window is the bound against a bundling keeper. Max loss per window = 30% of equity** (the window's starting equity; the bound is on lamports spent,
  and a sandwiched buy loses at most what it spent). Windows are back-to-back, so any 1 h interval
  touches at most two windows: ≤ 2 × 30%. Equity is book value (open positions at cost, not marked
  down by a sandwich), so a keeper left running could drain free SOL down to `vault_floor_lamports`
  in about four windows; `pause_keeper` stops it instantly and the windows give the admin hours, not
  seconds, to react.
- Sells only happen when the target sold (proportionally) or after `max_hold_secs`; the floor is
  95% of the pre-trade fee-free quote with no same-transaction manipulation, so a cross-transaction
  sandwich costs at most the value of the positions the keeper is allowed to sell at that moment.
- Buybacks / the platform token burns spend only profit shares (`buyback_pool`, the burn pool), ≤ 3% of the
  venue's real SOL per call and one call per minute each.
- No instruction pays the keeper anything; it never holds vault funds.

**Admin (cold key / multisig).** No instruction moves funds. Everything that grants or shapes the
keeper's power — keeper, params, venue whitelist, Index targets — waits `timelock_secs` in a public
`PendingChange` (`ChangeProposed{id, kind, eta, expires_at}`) that anyone can watch and that
executes only from `eta`, only within 7 days after it, and only while it is the latest proposal of
its kind (a stale or corrected proposal can't be replayed, a pause can't be undone by a queued
keeper change, a handover voids the old admin's queue); the admin handover is timelocked the same
way. Nothing the admin does takes effect faster
than the timelock except `pause_keeper`, which only removes power; with no keeper, positions whose
target exited become permissionless exits after `keeper_grace_secs`. Two-sided ranges stop the admin
from freezing funds through parameters (slippage ≥ 3% covers pump's fees, grace ≤ 7 days, max hold
≤ 30 days, impact ≥ 0.5%) or delisting exits (each venue keeps a proven Sell descriptor; a new
exit has to sell for real before an old one can go). Use a timelock of ≥ 24 h in
production.

**Upgrade authority.** Whoever can upgrade the program can replace it with one that withdraws every
vault. Before accepting deposits the upgrade authority must be a multisig with its own timelock
(e.g. Squads + time lock ≥ the config timelock), or the program must be made final
(`solana program set-upgrade-authority --final`). Until then every bound above is only as strong
as that key.

## Compute units (litesvm, mainnet pump programs as of 2026-10-04)

Measured by the test suite (`-- --nocapture` prints `CU <label> <units>`); ranges come from
different PDA bumps and first-time rent (the vault's pump / PumpSwap user-volume accumulator, token
account and position are created on the opening buy). Trades and burns include the
instructions-sysvar guard (~3–8k depending on the transaction's other instructions).

| Instruction | CU |
|---|---|
| launch tx: create_v2 + create_fee_sharing_config + update_fee_shares_v2 + register_copier | 292k – 382k |
| `register_copier` (inside the launch tx) | 23k – 40k |
| `copier_buy` curve `buy_exact_quote_in_v3`, opening | 131k – 182k |
| `copier_buy` curve `buy_exact_quote_in_v3`, top-up | ~106k |
| `copier_buy` curve with memo + ATA create + tip in the same tx | ~127k |
| `copier_buy` pool AMM `buy_exact_quote_in_v2`, opening / top-up | 162k – 189k / ~153k |
| `copier_buy` pool AMM legacy `buy_exact_quote_in`, opening | ~240k |
| `copier_sell` curve `sell_v3` (partial / closing) | ~104k / 102k – 126k |
| `copier_sell` permissionless slice (curve) | 117k – 121k |
| `copier_sell` pool AMM `sell_v2` (partial / closing) | 133k – 147k / ~150k |
| `copier_sell` pool AMM legacy `sell`, closing | ~171k |
| `buyback_burn` curve / pool | 110k – 155k / 142k – 165k |
| `burn_platform` curve / pool | ~130k / 130k – 157k |
| `keeper_heartbeat` | ~10k |
| `deposit` | 11k – 16k |
| `sync` | 9k – 10k |
| `fund_platform_burn` | 18k – 20k |
| `verify_trader` / `unverify_trader` | ~5k |
| fee crank (pump sweep + distribute_creator_fees_v2) | ~63k |
| fee crank after graduation (+ pool sweep + transfer_creator_fees_to_pump_v2) | ~154k |

The upper ends of the pool rows are the paths that adopt lamports pre-sent to the wSOL address.
Pump's own share of a v3 trade is ~50–60k; copy-vault adds the canonical-address derivations, the
reserve read, the transaction guard, the CPI account forwarding and the bookkeeping. Keepers should
simulate and set the limit to the simulated value + 10% (legacy AMM instructions exceed a 200k
default).

## Tests (`tests/program/tests`)

| File | Tests |
|---|---|
| `admin.rs` | `initialize_config_only_by_upgrade_authority_once_with_a_bounded_timelock`, `every_param_has_a_two_sided_range` (every bound and one past it), `param_changes_wait_for_the_timelock_and_can_be_cancelled`, `descriptor_whitelist_rules_and_timelock` (min_accounts ≤ 40, complete-but-never-working exit lists and laundering them through an intermediate list refused), `keeper_changes_are_timelocked_but_pause_is_instant`, `admin_handover_is_two_step_and_timelocked`, `a_newer_proposal_supersedes_an_older_one_of_the_same_kind` (executing the superseded change fails, discard), `pending_changes_expire_after_the_execute_window`, `pause_keeper_invalidates_queued_keeper_changes`, `admin_handover_invalidates_everything_the_old_admin_queued` |
| `launch.rs` | `launch_tx_end_to_end`, `register_rejections`, `index_copier_registration_and_targets` (timelocked target changes) |
| `guards.rs` | `trades_and_burns_must_be_alone_with_their_venue` (same-tx pre-buy before `copier_buy`, `buyback_burn`, `burn_platform`, dump before `copier_sell`, other copy-vault / token / ATA-create / transfer-to-venue instructions; memo + ATA + tip allowed), `trades_refuse_to_run_as_a_cpi` (`NotTopLevel` through the `cpi-wrapper` fixture program), `buys_are_capped_per_spend_window`, `spends_straddling_a_window_boundary_stay_within_two_caps` |
| `fees.rs` | `creator_fees_reach_the_vault_and_sync_books_them`, `creator_fees_after_graduation_reach_the_vault` |
| `trade_curve.rs` | `copy_buy_then_proportional_sells_on_the_curve`, `copier_buy_rejections`, `copier_sell_rejections`, `buys_never_spend_below_the_vault_floor`, `forced_exit_after_max_hold`, `permissionless_exit_needs_a_dead_keeper_and_a_flat_target_and_goes_in_slices`, `prefunded_position_account_is_booked_as_income`, `high_water_mark_split_loss_then_win`, `index_copier_positions_belong_to_their_target`, `a_new_exit_descriptor_counts_once_it_has_sold` |
| `trade_pool.rs` | `copy_trade_on_a_graduated_pool` (curve bought out in-test, pump `migrate_v2`), `pool_venue_account_tampering_is_refused`, `donated_wsol_account_is_booked_as_income`, `lamports_sent_to_the_uncreated_wsol_address_are_fees` (pool buy, pool sell, pool `buyback_burn`, pool `burn_platform`), `copy_trade_on_the_legacy_amm_instructions` |
| `burn.rs` | `buyback_burn_reduces_supply_on_the_curve_and_the_pool`, `burn_platform_buys_and_burns_platform_token`, `copier_index_keeps_its_profit_share_for_its_own_buyback`, `fund_platform_burn_moves_a_pending_share` |

Fixtures (`tests/program/fixtures`, refreshed by `dump-fixtures.sh` from mainnet): the pump,
pump_amm, pump_fees, mayhem, SPL Token (p-token), Token-2022 and ATA programs; pump `Global`, both
`FeeConfig`s, PumpSwap `GlobalConfig`, both global volume accumulators, the wSOL mint, pump's
withdraw authority, mayhem global params / SOL vault, and the wSOL accounts of the 8 buyback and
8 PumpSwap protocol fee recipients. `fixtures/cpi_wrapper.so` is built from
`tests/program/cpi-wrapper` (a 20-line program that forwards its instruction via CPI) by
`tests/program/cpi-wrapper/build.sh`.

Operational notes found by the suite:
- After graduation, prepend PumpSwap `sweep_creator_fee` + `transfer_creator_fees_to_pump_v2` to the
  fee crank only when `Pool.creator_fees` (u64 at 279) > 0 or the AMM creator-vault wSOL account
  exists; otherwise the transfer fails with `AccountNotInitialized`.
- Graduated `create_v2` coins migrate with pump `migrate_v2` plus the two boost accounts
  (`["boost_vault", pool]` and its wSOL ATA) as remaining accounts.
- The burn pool fronts the transient wSOL account and its first PumpSwap volume accumulator on pool
  venues: keep ~0.01 SOL of headroom over `sol_in`.
- The keeper must send `keeper_heartbeat` (or any keeper trade) more often than `keeper_grace_secs`,
  and keep the fee crank, `sync` and pump trades out of its trade transactions.
