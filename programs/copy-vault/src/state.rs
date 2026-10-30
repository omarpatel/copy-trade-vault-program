use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::CopierError;
use crate::pump;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum Side {
    Buy,
    Sell,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum Venue {
    /// pump.fun bonding curve; `venue_idx` points at the `["bonding-curve", mint]` PDA.
    Curve,
    /// PumpSwap canonical pool; `venue_idx` points at the canonical pool PDA.
    Pool,
}

/// One whitelisted venue instruction. The keeper forwards that instruction's exact account list
/// as remaining accounts and its full data (discriminator included); the program checks the roles
/// below, signs as `remaining[user_idx]` and measures the fill from balance deltas.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub struct TradeDescriptor {
    /// pump or pump_amm only.
    pub program: Pubkey,
    pub disc: [u8; 8],
    pub side: Side,
    pub venue: Venue,
    pub user_idx: u8,
    pub base_mint_idx: u8,
    pub venue_idx: u8,
    pub min_accounts: u8,
}

impl TradeDescriptor {
    pub fn validate(&self) -> Result<()> {
        let program_ok = match self.venue {
            Venue::Curve => self.program == pump::PUMP_PROGRAM_ID,
            Venue::Pool => self.program == pump::PUMP_AMM_PROGRAM_ID,
        };
        require!(program_ok, CopierError::DescriptorProgramNotAllowed);
        require!(!pump::FORBIDDEN_DISCRIMINATORS.contains(&self.disc), CopierError::DescriptorDiscForbidden);
        let max = self.user_idx.max(self.base_mint_idx).max(self.venue_idx);
        require!(
            max < self.min_accounts
                && self.min_accounts <= MAX_DESCRIPTOR_ACCOUNTS
                && self.user_idx != self.base_mint_idx
                && self.user_idx != self.venue_idx
                && self.base_mint_idx != self.venue_idx,
            CopierError::DescriptorIndices
        );
        Ok(())
    }
}

/// Admin-settable trading parameters; `validate` enforces the two-sided ranges in
/// `constants.rs`. Changed only through the timelocked `propose_params` → `execute_pending`.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub struct Params {
    /// Max lamports per buy, in bps of vault equity.
    pub max_trade_bps: u16,
    /// Max cost basis per traded mint, in bps of vault equity.
    pub max_position_bps: u16,
    pub max_open_positions: u8,
    pub min_trade_lamports: u64,
    /// Min (target token increase × spot price) for a buy to count as a signal.
    pub min_signal_lamports: u64,
    /// A vault buy may spend at most this multiple (bps) of the signal.
    pub signal_multiple_bps: u16,
    /// Max lamports per buy in bps of the venue's real quote reserves.
    pub max_impact_bps: u16,
    /// Program-side floor: fills must reach (10000 − slippage_bps) of the fee-free quote.
    pub slippage_bps: u16,
    /// Free SOL a buy may never spend below.
    pub vault_floor_lamports: u64,
    /// After this long a position may be exited regardless of the target.
    pub max_hold_secs: i64,
    /// After this long without a keeper heartbeat (`Config.keeper_heartbeat_ts`), exits are
    /// permissionless for positions whose target holds 0, in impact-capped slices.
    pub keeper_grace_secs: i64,
    /// Length of a copier's buy spend window.
    pub spend_window_secs: i64,
    /// Max lamports `copier_buy` may spend per window, in bps of equity at the window's start.
    pub max_window_spend_bps: u16,
}

impl Default for Params {
    fn default() -> Self {
        Self {
            max_trade_bps: DEFAULT_MAX_TRADE_BPS,
            max_position_bps: DEFAULT_MAX_POSITION_BPS,
            max_open_positions: DEFAULT_MAX_OPEN_POSITIONS,
            min_trade_lamports: DEFAULT_MIN_TRADE_LAMPORTS,
            min_signal_lamports: DEFAULT_MIN_SIGNAL_LAMPORTS,
            signal_multiple_bps: DEFAULT_SIGNAL_MULTIPLE_BPS,
            max_impact_bps: DEFAULT_MAX_IMPACT_BPS,
            slippage_bps: DEFAULT_SLIPPAGE_BPS,
            vault_floor_lamports: DEFAULT_VAULT_FLOOR_LAMPORTS,
            max_hold_secs: DEFAULT_MAX_HOLD_SECS,
            keeper_grace_secs: DEFAULT_KEEPER_GRACE_SECS,
            spend_window_secs: DEFAULT_SPEND_WINDOW_SECS,
            max_window_spend_bps: DEFAULT_MAX_WINDOW_SPEND_BPS,
        }
    }
}

fn within<T: PartialOrd>(v: T, (lo, hi): (T, T)) -> bool {
    lo <= v && v <= hi
}

impl Params {
    pub fn validate(&self) -> Result<()> {
        require!(
            within(self.max_trade_bps, RANGE_MAX_TRADE_BPS)
                && within(self.max_position_bps, RANGE_MAX_POSITION_BPS)
                && within(self.max_open_positions, RANGE_MAX_OPEN_POSITIONS)
                && within(self.min_trade_lamports, RANGE_MIN_TRADE_LAMPORTS)
                && within(self.min_signal_lamports, RANGE_MIN_SIGNAL_LAMPORTS)
                && within(self.signal_multiple_bps, RANGE_SIGNAL_MULTIPLE_BPS)
                && within(self.max_impact_bps, RANGE_MAX_IMPACT_BPS)
                && within(self.slippage_bps, RANGE_SLIPPAGE_BPS)
                && within(self.vault_floor_lamports, RANGE_VAULT_FLOOR_LAMPORTS)
                && within(self.max_hold_secs, RANGE_MAX_HOLD_SECS)
                && within(self.keeper_grace_secs, RANGE_KEEPER_GRACE_SECS)
                && within(self.spend_window_secs, RANGE_SPEND_WINDOW_SECS)
                && within(self.max_window_spend_bps, RANGE_MAX_WINDOW_SPEND_BPS),
            CopierError::ParamOutOfRange
        );
        Ok(())
    }
}

/// Checks a whitelist the admin wants to install and returns its `proven` mask (bit i: `v[i]` is
/// known to work).
///
/// - ≤ 32 individually valid descriptors with at least one Buy and one Sell for both venues;
/// - when replacing `current` (with its proven mask): for each venue at least one Sell descriptor
///   byte-identical to a *proven* descriptor of the current list. A descriptor is proven when it
///   was seeded at initialization or a trade through it succeeded, so a proposal can never leave a
///   venue with only exits that have never worked; an exit can only be retired once a replacement
///   has executed a real sell.
///
/// Proven bits carry over to byte-identical descriptors of the new list.
pub fn validate_descriptors(v: &[TradeDescriptor], current: Option<(&[TradeDescriptor], u32)>) -> Result<u32> {
    require!(v.len() <= MAX_DESCRIPTORS, CopierError::TooManyDescriptors);
    v.iter().try_for_each(TradeDescriptor::validate)?;
    for venue in [Venue::Curve, Venue::Pool] {
        for side in [Side::Buy, Side::Sell] {
            require!(
                v.iter().any(|d| d.venue == venue && d.side == side),
                CopierError::DescriptorsIncomplete
            );
        }
    }
    let Some((cur, cur_proven)) = current else {
        // Initialization: the seeded list is the mainnet-tested baseline.
        return Ok(if v.len() >= 32 { u32::MAX } else { (1u32 << v.len()) - 1 });
    };
    let proven_in_current = |d: &TradeDescriptor| {
        cur.iter().enumerate().any(|(j, c)| c == d && cur_proven & (1 << j) != 0)
    };
    let mut mask = 0u32;
    for (i, d) in v.iter().enumerate() {
        if proven_in_current(d) {
            mask |= 1 << i;
        }
    }
    for venue in [Venue::Curve, Venue::Pool] {
        require!(
            v.iter()
                .enumerate()
                .any(|(i, d)| d.venue == venue && d.side == Side::Sell && mask & (1 << i) != 0),
            CopierError::DescriptorsDropProvenExit
        );
    }
    Ok(mask)
}

/// Seeded descriptors (indices fixed: SDK and keeper rely on them).
/// 0 pump buy_v3, 1 pump sell_v3, 2 pump buy_exact_quote_in_v3, 3 pump buy_v2, 4 pump sell_v2,
/// 5 pump buy_exact_quote_in_v2, 6 amm buy_exact_quote_in_v2, 7 amm sell_v2,
/// 8 amm buy_exact_quote_in, 9 amm sell.
pub fn default_descriptors() -> Vec<TradeDescriptor> {
    let curve = |disc, side, user_idx, venue_idx, min_accounts| TradeDescriptor {
        program: pump::PUMP_PROGRAM_ID,
        disc,
        side,
        venue: Venue::Curve,
        user_idx,
        base_mint_idx: 1,
        venue_idx,
        min_accounts,
    };
    let pool = |disc, side, min_accounts| TradeDescriptor {
        program: pump::PUMP_AMM_PROGRAM_ID,
        disc,
        side,
        venue: Venue::Pool,
        user_idx: 1,
        base_mint_idx: 3,
        venue_idx: 0,
        min_accounts,
    };
    vec![
        curve(pump::IX_BUY_V3, Side::Buy, 8, 5, 17),
        curve(pump::IX_SELL_V3, Side::Sell, 8, 5, 17),
        curve(pump::IX_BUY_EXACT_QUOTE_IN_V3, Side::Buy, 8, 5, 17),
        curve(pump::IX_BUY_V2, Side::Buy, 13, 10, 27),
        curve(pump::IX_SELL_V2, Side::Sell, 13, 10, 26),
        curve(pump::IX_BUY_EXACT_QUOTE_IN_V2, Side::Buy, 13, 10, 27),
        pool(pump::IX_BUY_EXACT_QUOTE_IN_V2, Side::Buy, 17),
        pool(pump::IX_SELL_V2, Side::Sell, 17),
        pool(pump::IX_AMM_BUY_EXACT_QUOTE_IN, Side::Buy, 23),
        pool(pump::IX_AMM_SELL, Side::Sell, 21),
    ]
}

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub pending_admin: Pubkey,
    pub keeper: Pubkey,
    /// the platform token; `Pubkey::default()` until `set_platform_mint` (once).
    pub platform_mint: Pubkey,
    pub params: Params,
    #[max_len(32)]
    pub descriptors: Vec<TradeDescriptor>,
    pub bump: u8,
    pub burn_pool_bump: u8,
    /// the platform token tokens the burn pool bought and burned (`burn_platform`).
    pub platform_burned: u64,
    /// Lamports the burn pool spent on those buys.
    pub platform_burn_spent: u64,
    /// Seconds between an admin proposal and its earliest execution (fixed at initialization).
    pub timelock_secs: i64,
    /// Id of the next `PendingChange`.
    pub next_change_id: u64,
    /// Earliest time `accept_admin` may run for `pending_admin`.
    pub pending_admin_eta: i64,
    /// Last keeper-signed instruction (any trade, burn or `keeper_heartbeat`).
    pub keeper_heartbeat_ts: i64,
    /// Last `burn_platform`.
    pub last_platform_burn_ts: i64,
    /// Per `ChangeKind` (in enum order): the id of the only proposal of that kind that may
    /// execute, or `NO_CHANGE`. A newer proposal supersedes the older one; `pause_keeper` clears the
    /// Keeper entry, `accept_admin` clears all of them.
    pub latest_change_ids: [u64; 4],
    /// Bit i: `descriptors[i]` is proven (seeded, or a trade through it succeeded).
    pub descriptors_proven: u32,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum ChangeKind {
    Keeper,
    Params,
    Descriptors,
    IndexTargets,
}

impl ChangeKind {
    pub const ALL: [ChangeKind; 4] = [ChangeKind::Keeper, ChangeKind::Params, ChangeKind::Descriptors, ChangeKind::IndexTargets];

    pub fn index(self) -> usize {
        self as usize
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum InvalidationReason {
    /// A newer proposal of the same kind.
    Superseded,
    /// `pause_keeper` (Keeper changes only).
    KeeperPaused,
    /// `accept_admin`: every change the previous admin queued.
    AdminChanged,
}

/// A timelocked admin change `["pending", id]`. Anyone may execute it from `eta` to `expires_at`
/// while it is still the live proposal of its kind (`Config.latest_change_ids[kind] == id`); a newer
/// proposal of the same kind, `pause_keeper` (Keeper changes) or `accept_admin` (all) supersede
/// it. Status for indexers: superseded if not the live id, expired after `expires_at`, queued
/// before `eta`, executable otherwise. The admin may cancel it; anyone may discard it once
/// superseded or expired. Only the payload field of its `kind` is meaningful.
#[account]
#[derive(InitSpace)]
pub struct PendingChange {
    pub id: u64,
    pub kind: ChangeKind,
    pub proposer: Pubkey,
    pub proposed_at: i64,
    pub eta: i64,
    /// Last moment it can execute (`eta + EXECUTE_WINDOW_SECS`).
    pub expires_at: i64,
    pub keeper: Pubkey,
    pub params: Params,
    #[max_len(32)]
    pub descriptors: Vec<TradeDescriptor>,
    /// The Index copier whose targets change (`IndexTargets`).
    pub copier: Pubkey,
    #[max_len(16)]
    pub targets: Vec<Pubkey>,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum CopierKind {
    /// Copies one target wallet, which takes `trader_bps` of creator fees.
    Single,
    /// Copies a basket of up to 16 wallets; the vault takes 100% of creator fees.
    Index,
}

#[account]
#[derive(InitSpace)]
pub struct Copier {
    pub mint: Pubkey,
    pub launcher: Pubkey,
    pub kind: CopierKind,
    #[max_len(16)]
    pub targets: Vec<Pubkey>,
    pub trader_bps: u16,
    /// Bit i set: targets[i] signed `verify_trader`.
    pub verified: u16,
    pub vault_bump: u8,
    pub bump: u8,
    pub created_at: i64,
    pub sharing_config: Pubkey,
    /// Vault lamports + vault wSOL the program knows about; anything above is fee income (`sync`).
    pub accounted_lamports: u64,
    pub fees_in: u64,
    pub capital_in: u64,
    /// Cost basis of all open positions (lamports, rent included).
    pub open_cost: u64,
    pub open_positions: u8,
    pub realized_pnl: i64,
    pub hwm: i64,
    /// Earmarked for buying back & burning the copier's own coin (75% of profit above the HWM).
    pub buyback_pool: u64,
    /// Lamports sent to the platform token burn pool (25% of profit above the HWM).
    pub platform_sent: u64,
    /// Own-coin tokens bought back and burned.
    pub burned: u64,
    /// Lamports spent on own-coin buybacks.
    pub buyback_spent: u64,
    pub trades: u64,
    pub last_keeper_ts: i64,
    /// Canonical PumpSwap pool of the own coin once a buyback has seen it graduated.
    pub graduated_pool: Pubkey,
    /// the platform token share not yet moved to the burn pool (`fund_platform_burn`).
    pub platform_pending: u64,
    pub last_buyback_ts: i64,
    /// Open positions per target index (parallel to `targets`).
    pub target_positions: [u8; 16],
    /// Start of the current buy spend window.
    pub window_start: i64,
    /// Lamports `copier_buy` spent in the current window.
    pub window_spent: u64,
    /// Equity at the start of the current window (the window cap's base).
    pub window_equity: u64,
    /// Slot of the last permissionless `copier_sell` (one slice per slot).
    pub last_public_sell_slot: u64,
}

impl Copier {
    /// Lamports the vault may spend on trades: its balance (lamports + wSOL) above rent minus the
    /// earmarked buyback pool and pending the platform token share.
    pub fn free_sol(&self, vault_total: u64, rent: u64) -> u64 {
        vault_total
            .saturating_sub(rent)
            .saturating_sub(self.buyback_pool)
            .saturating_sub(self.platform_pending)
    }

    /// Equity = free SOL + open cost basis.
    pub fn equity(&self, vault_total: u64, rent: u64) -> u64 {
        self.free_sol(vault_total, rent).saturating_add(self.open_cost)
    }

    pub fn target_index(&self, target: &Pubkey) -> Option<usize> {
        self.targets.iter().position(|t| t == target)
    }
}

#[account]
#[derive(InitSpace)]
pub struct Position {
    /// The copier's mint.
    pub mint: Pubkey,
    /// The traded coin.
    pub token_mint: Pubkey,
    /// The target this position copies.
    pub target: Pubkey,
    pub tokens: u64,
    /// Cost basis (lamports spent, rent included).
    pub cost: u64,
    /// Target's balance after the last copied trade.
    pub target_snapshot: u64,
    /// Target's balance at the last vault buy; with `vault_peak` sets the proportional sell.
    pub target_peak: u64,
    pub vault_peak: u64,
    pub opened_at: i64,
    pub last_trade_ts: i64,
    pub bump: u8,
}

impl Position {
    pub const SPACE: usize = 8 + Position::INIT_SPACE;
}
