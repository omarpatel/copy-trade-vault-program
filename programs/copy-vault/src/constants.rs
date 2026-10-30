//! Seeds, the user-rule constants, parameter defaults and the two-sided ranges every
//! admin-settable parameter must stay inside.

pub const CONFIG_SEED: &[u8] = b"config";
pub const COPIER_SEED: &[u8] = b"copier";
pub const VAULT_SEED: &[u8] = b"vault";
pub const POSITION_SEED: &[u8] = b"position";
pub const BURN_POOL_SEED: &[u8] = b"platform-burn";
pub const PENDING_SEED: &[u8] = b"pending";

pub const BPS: u64 = 10_000;

// ---------------- fixed by the product rules ----------------

/// The target's cut of creator fees is between 1% and 25%.
pub const TRADER_MIN_BPS: u16 = 100;
pub const TRADER_MAX_BPS: u16 = 2_500;
/// Of every lamport of realized profit above the high-water mark, 25% buys back & burns
/// the platform token and 75% buys back & burns the copier's own coin.
pub const PROFIT_PLATFORM_BPS: u64 = 2_500;
pub const PROFIT_BUYBACK_BPS: u64 = 7_500;
pub const MAX_INDEX_TARGETS: usize = 16;
pub const MAX_DESCRIPTORS: usize = 32;
/// Upper bound of a descriptor's `min_accounts` (pump's largest trade instruction takes 27).
pub const MAX_DESCRIPTOR_ACCOUNTS: u8 = 40;

/// Lamports a trade may cost on top of what it sends to the venue: the venue's
/// user-volume-accumulator (≈0.00184 SOL, once per venue), the vault's token account
/// (≈0.00207 SOL) and the position account. Booked as cost of the position.
pub const RENT_ALLOWANCE_LAMPORTS: u64 = 10_000_000;
/// Minimum spacing between two `buyback_burn` calls of one copier, and between two
/// `burn_platform` calls.
pub const BUYBACK_INTERVAL_SECS: i64 = 60;

/// Admin timelock (seconds between a proposal and its earliest execution), set once at
/// `initialize_config`.
pub const MIN_TIMELOCK_SECS: i64 = 60;
pub const MAX_TIMELOCK_SECS: i64 = 604_800;
/// A pending change can be executed from its `eta` until `eta + EXECUTE_WINDOW_SECS`; after that
/// it is expired and can only be discarded.
pub const EXECUTE_WINDOW_SECS: i64 = 604_800;
/// `Config.latest_change_ids` entry meaning "no live proposal of this kind".
pub const NO_CHANGE: u64 = u64::MAX;

// ---------------- parameter defaults ----------------

pub const DEFAULT_MAX_TRADE_BPS: u16 = 1_000;
pub const DEFAULT_MAX_POSITION_BPS: u16 = 2_000;
pub const DEFAULT_MAX_OPEN_POSITIONS: u8 = 12;
pub const DEFAULT_MIN_TRADE_LAMPORTS: u64 = 10_000_000;
pub const DEFAULT_MIN_SIGNAL_LAMPORTS: u64 = 50_000_000;
pub const DEFAULT_SIGNAL_MULTIPLE_BPS: u16 = 10_000;
pub const DEFAULT_MAX_IMPACT_BPS: u16 = 300;
pub const DEFAULT_SLIPPAGE_BPS: u16 = 500;
pub const DEFAULT_VAULT_FLOOR_LAMPORTS: u64 = 20_000_000;
pub const DEFAULT_MAX_HOLD_SECS: i64 = 604_800;
pub const DEFAULT_KEEPER_GRACE_SECS: i64 = 3_600;
pub const DEFAULT_SPEND_WINDOW_SECS: i64 = 3_600;
pub const DEFAULT_MAX_WINDOW_SPEND_BPS: u16 = 3_000;

// ---------------- parameter ranges (inclusive; the admin can only move inside these) ----------------

pub const RANGE_MAX_TRADE_BPS: (u16, u16) = (1, 2_500);
pub const RANGE_MAX_POSITION_BPS: (u16, u16) = (1, 3_500);
pub const RANGE_MAX_OPEN_POSITIONS: (u8, u8) = (1, 24);
pub const RANGE_MIN_TRADE_LAMPORTS: (u64, u64) = (1_000_000, 1_000_000_000);
pub const RANGE_MIN_SIGNAL_LAMPORTS: (u64, u64) = (1_000_000, 10_000_000_000);
/// Anti-bait: a vault buy may never exceed the target's own buy (c ≤ 1).
pub const RANGE_SIGNAL_MULTIPLE_BPS: (u16, u16) = (1, 10_000);
pub const RANGE_MAX_IMPACT_BPS: (u16, u16) = (50, 1_000);
/// The floor is taken on the fee-free quote, so it must leave room for pump's fees (≤ ~1.25%
/// plus price movement); below 3% every trade would revert.
pub const RANGE_SLIPPAGE_BPS: (u16, u16) = (300, 1_500);
pub const RANGE_VAULT_FLOOR_LAMPORTS: (u64, u64) = (5_000_000, 1_000_000_000);
pub const RANGE_MAX_HOLD_SECS: (i64, i64) = (86_400, 2_592_000);
pub const RANGE_KEEPER_GRACE_SECS: (i64, i64) = (600, 604_800);
pub const RANGE_SPEND_WINDOW_SECS: (i64, i64) = (600, 86_400);
pub const RANGE_MAX_WINDOW_SPEND_BPS: (u16, u16) = (500, 5_000);
