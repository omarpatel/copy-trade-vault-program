//! copy-vault: a pump.fun coin tied to one public wallet (the target). The coin's creator fees are
//! split by pump's fee sharing between the target (1–25%) and a vault PDA that copy-trades the
//! target on pump.fun / PumpSwap. Realized profit above the vault's high-water mark buys back and
//! burns the coin (75%) and the platform token (25%). No instruction withdraws vault SOL.
#![allow(unexpected_cfgs)]
use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod events;
pub mod guard;
pub mod instructions;
pub mod math;
pub mod pump;
pub mod state;
pub mod venue;

use instructions::*;
use state::{Params, TradeDescriptor};

declare_id!("9R8g8JtEqRAh5yZ4aXbf1mWcfgLq9kAo6fmx93MSK9k7");

#[program]
pub mod copy_vault {
    use super::*;

    // ---------------- config (admin) ----------------

    /// Once, by the program's upgrade authority: default params, the seeded venue whitelist, the
    /// admin timelock (60 s – 7 days) and the funded platform-token burn pool.
    pub fn initialize_config(ctx: Context<InitializeConfig>, keeper: Pubkey, timelock_secs: i64) -> Result<()> {
        admin::initialize_config(ctx, keeper, timelock_secs)
    }

    /// Queues a keeper change (executable after the timelock).
    pub fn propose_keeper(ctx: Context<ProposeChange>, keeper: Pubkey) -> Result<()> {
        admin::propose_keeper(ctx, keeper)
    }

    /// Queues a parameter change (validated against the ranges now and at execution).
    pub fn propose_params(ctx: Context<ProposeChange>, params: Params) -> Result<()> {
        admin::propose_params(ctx, params)
    }

    /// Queues a venue whitelist change.
    pub fn propose_descriptors(ctx: Context<ProposeChange>, descriptors: Vec<TradeDescriptor>) -> Result<()> {
        admin::propose_descriptors(ctx, descriptors)
    }

    /// Queues an Index copier's new target list.
    pub fn propose_index_targets(ctx: Context<ProposeIndexTargets>, targets: Vec<Pubkey>) -> Result<()> {
        admin::propose_index_targets(ctx, targets)
    }

    /// Anyone, once the change's timelock has passed.
    pub fn execute_pending(ctx: Context<ExecutePending>) -> Result<()> {
        admin::execute_pending(ctx)
    }

    pub fn cancel_pending(ctx: Context<CancelPending>) -> Result<()> {
        admin::cancel_pending(ctx)
    }

    /// Anyone closes a superseded or expired change (rent to its proposer).
    pub fn discard_pending(ctx: Context<DiscardPending>) -> Result<()> {
        admin::discard_pending(ctx)
    }

    /// Instant: removes the keeper.
    pub fn pause_keeper(ctx: Context<AdminOnly>) -> Result<()> {
        admin::pause_keeper(ctx)
    }

    /// The keeper's liveness signal (every keeper-signed trade or burn also counts).
    pub fn keeper_heartbeat(ctx: Context<KeeperHeartbeat>) -> Result<()> {
        admin::keeper_heartbeat(ctx)
    }

    pub fn propose_admin(ctx: Context<AdminOnly>, new_admin: Pubkey) -> Result<()> {
        admin::propose_admin(ctx, new_admin)
    }

    /// The proposed admin takes over, after the timelock.
    pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
        admin::accept_admin(ctx)
    }

    /// Once: names the registered Index copier whose coin is the platform token.
    pub fn set_platform_mint(ctx: Context<SetPlatformMint>, mint: Pubkey) -> Result<()> {
        admin::set_platform_mint(ctx, mint)
    }

    // ---------------- registration ----------------

    /// Last instruction of the launch tx: checks the fee-sharing split
    /// `[target trader_bps, vault 10000 − trader_bps]` is final and creates the copier.
    pub fn register_copier(ctx: Context<RegisterCopier>, trader_bps: u16) -> Result<()> {
        register::register_copier(ctx, trader_bps)
    }

    /// Admin: an index copier (vault takes 100% of creator fees) copying up to 16 wallets.
    pub fn register_index(ctx: Context<RegisterIndex>, targets: Vec<Pubkey>) -> Result<()> {
        register::register_index(ctx, targets)
    }

    // ---------------- vault bookkeeping ----------------

    /// Anyone adds capital (not profit) to a vault.
    pub fn deposit(ctx: Context<Deposit>, lamports: u64) -> Result<()> {
        vault::deposit(ctx, lamports)
    }

    /// Books lamports that reached the vault without the program (creator fees) as fee income.
    pub fn sync(ctx: Context<SyncVault>) -> Result<()> {
        vault::sync(ctx)
    }

    pub fn verify_trader(ctx: Context<VerifyTrader>, target_idx: u8) -> Result<()> {
        vault::verify_trader(ctx, target_idx)
    }

    pub fn unverify_trader(ctx: Context<VerifyTrader>, target_idx: u8) -> Result<()> {
        vault::unverify_trader(ctx, target_idx)
    }

    /// Moves the copier's pending 25% profit share to the platform token burn pool.
    pub fn fund_platform_burn(ctx: Context<FundPlatformBurn>) -> Result<()> {
        vault::fund_platform_burn(ctx)
    }

    // ---------------- trading (remaining accounts = the venue instruction's accounts) ----------------

    pub fn copier_buy<'info>(
        ctx: Context<'_, '_, 'info, 'info, CopierBuyAccounts<'info>>,
        target_idx: u8,
        descriptor_idx: u8,
        sol_in: u64,
        min_tokens_out: u64,
        ix_data: Vec<u8>,
    ) -> Result<()> {
        trade::copier_buy(ctx, target_idx, descriptor_idx, sol_in, min_tokens_out, ix_data)
    }

    pub fn copier_sell<'info>(
        ctx: Context<'_, '_, 'info, 'info, CopierSellAccounts<'info>>,
        target_idx: u8,
        descriptor_idx: u8,
        tokens_in: u64,
        min_sol_out: u64,
        ix_data: Vec<u8>,
    ) -> Result<()> {
        trade::copier_sell(ctx, target_idx, descriptor_idx, tokens_in, min_sol_out, ix_data)
    }

    pub fn buyback_burn<'info>(
        ctx: Context<'_, '_, 'info, 'info, BuybackBurn<'info>>,
        descriptor_idx: u8,
        sol_in: u64,
        min_tokens_out: u64,
        ix_data: Vec<u8>,
    ) -> Result<()> {
        burn::buyback_burn(ctx, descriptor_idx, sol_in, min_tokens_out, ix_data)
    }

    pub fn burn_platform<'info>(
        ctx: Context<'_, '_, 'info, 'info, BurnPlatform<'info>>,
        descriptor_idx: u8,
        sol_in: u64,
        min_tokens_out: u64,
        ix_data: Vec<u8>,
    ) -> Result<()> {
        burn::burn_platform(ctx, descriptor_idx, sol_in, min_tokens_out, ix_data)
    }
}
