//! Events (names and fields are the indexer contract, docs/SPEC.md §2). Emitted with `emit!`
//! (`Program data:` log lines).

use anchor_lang::prelude::*;

use crate::state::{ChangeKind, InvalidationReason, CopierKind, Params, Venue};

#[event]
pub struct CopierRegistered {
    pub mint: Pubkey,
    pub launcher: Pubkey,
    pub kind: CopierKind,
    pub targets: Vec<Pubkey>,
    pub trader_bps: u16,
    pub sharing_config: Pubkey,
    pub ts: i64,
}

/// Lamports found on the vault that the program did not move itself (creator fees).
#[event]
pub struct FeesSynced {
    pub mint: Pubkey,
    pub lamports: u64,
    /// `fees_in` after booking.
    pub total: u64,
    pub ts: i64,
}

#[event]
pub struct Deposited {
    pub mint: Pubkey,
    pub from: Pubkey,
    pub lamports: u64,
    pub ts: i64,
}

#[event]
pub struct TraderVerified {
    pub mint: Pubkey,
    pub target: Pubkey,
    pub verified: bool,
    pub ts: i64,
}

#[event]
pub struct CopierBuy {
    pub mint: Pubkey,
    pub target: Pubkey,
    pub token_mint: Pubkey,
    pub venue: Venue,
    /// Lamports the buy cost the vault (venue spend plus any rent it paid), booked as cost.
    pub sol_in: u64,
    pub tokens_out: u64,
    pub target_balance: u64,
    pub signal_lamports: u64,
    /// Vault equity before the buy.
    pub equity: u64,
    pub ts: i64,
}

#[event]
pub struct CopierSell {
    pub mint: Pubkey,
    pub target: Pubkey,
    pub token_mint: Pubkey,
    pub venue: Venue,
    pub tokens_in: u64,
    /// Lamports back on the vault: venue proceeds plus rent refunded on a closing sell.
    pub sol_out: u64,
    pub cost_removed: u64,
    pub pnl: i64,
    pub realized_pnl: i64,
    pub hwm: i64,
    /// Exit by max-hold or by a non-keeper after the keeper grace period.
    pub forced: bool,
    pub ts: i64,
}

#[event]
pub struct ProfitSplit {
    pub mint: Pubkey,
    pub excess: u64,
    pub to_buyback: u64,
    pub to_platform: u64,
    pub ts: i64,
}

#[event]
pub struct BuybackBurned {
    pub mint: Pubkey,
    pub sol_in: u64,
    pub tokens_burned: u64,
    pub total_burned: u64,
    pub ts: i64,
}

#[event]
pub struct PlatformBurned {
    pub sol_in: u64,
    pub tokens_burned: u64,
    pub ts: i64,
}

/// Any config change (params, keeper, descriptors, admin handover, the platform token mint).
#[event]
pub struct ParamsUpdated {
    pub params: Params,
    pub admin: Pubkey,
    pub pending_admin: Pubkey,
    pub keeper: Pubkey,
    pub platform_mint: Pubkey,
    pub descriptors: u8,
    pub ts: i64,
}

#[event]
pub struct IndexTargetsSet {
    pub mint: Pubkey,
    pub targets: Vec<Pubkey>,
}

/// An admin change was queued (`propose_*`); executable by anyone from `eta` until `expires_at`
/// unless superseded first.
#[event]
pub struct ChangeProposed {
    pub id: u64,
    pub kind: ChangeKind,
    pub eta: i64,
    pub expires_at: i64,
    pub ts: i64,
}

/// Change `id` can no longer execute (a newer proposal of its kind, a keeper pause or an admin
/// handover). Its account stays until `discard_pending` / `cancel_pending`.
#[event]
pub struct ChangeInvalidated {
    pub id: u64,
    pub kind: ChangeKind,
    pub reason: InvalidationReason,
    pub ts: i64,
}

/// A superseded or expired change's account was closed (`discard_pending`, permissionless).
#[event]
pub struct ChangeDiscarded {
    pub id: u64,
    pub kind: ChangeKind,
    pub ts: i64,
}

#[event]
pub struct ChangeExecuted {
    pub id: u64,
    pub kind: ChangeKind,
    pub ts: i64,
}

#[event]
pub struct ChangeCancelled {
    pub id: u64,
    pub kind: ChangeKind,
    pub ts: i64,
}

/// The admin removed the keeper instantly (`pause_keeper`); a new one needs a timelocked
/// `propose_keeper`.
#[event]
pub struct KeeperPaused {
    pub keeper: Pubkey,
    pub ts: i64,
}
