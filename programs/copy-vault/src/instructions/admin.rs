//! Config administration. The admin (deployer, later a multisig) has no instruction that moves
//! funds. Everything that changes what the keeper may do — the keeper itself, the parameters, the
//! venue whitelist, an Index copier's targets — is timelocked: `propose_*` stores the change in a
//! `PendingChange` account and anyone may `execute_pending` it once `Config.timelock_secs` have
//! passed, giving depositors that long to react. The admin may `cancel_pending` before. Only
//! `pause_keeper`, which removes power, is instant.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::bpf_loader_upgradeable;
use anchor_lang::system_program;

use crate::constants::*;
use crate::errors::CopierError;
use crate::events::{
    ChangeCancelled, ChangeDiscarded, ChangeExecuted, ChangeInvalidated, ChangeProposed, KeeperPaused, ParamsUpdated,
};
use crate::state::{
    default_descriptors, validate_descriptors, ChangeKind, Config, InvalidationReason, Copier, CopierKind, Params,
    PendingChange, TradeDescriptor,
};

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = 8 + Config::INIT_SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Box<Account<'info, Config>>,
    /// The program's ProgramData: only its upgrade authority (the deployer) can initialize.
    #[account(
        seeds = [crate::ID.as_ref()],
        bump,
        seeds::program = bpf_loader_upgradeable::ID,
        constraint = program_data.upgrade_authority_address == Some(admin.key()) @ CopierError::NotUpgradeAuthority
    )]
    pub program_data: Account<'info, ProgramData>,
    /// the platform token burn pool: system-owned, zero data; funded to rent here so it can receive any share.
    #[account(mut, seeds = [BURN_POOL_SEED], bump)]
    pub burn_pool: SystemAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ CopierError::NotAdmin)]
    pub config: Box<Account<'info, Config>>,
}

#[derive(Accounts)]
pub struct AcceptAdmin<'info> {
    pub pending_admin: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        constraint = config.pending_admin == pending_admin.key() @ CopierError::NotPendingAdmin
    )]
    pub config: Box<Account<'info, Config>>,
}

#[derive(Accounts)]
pub struct KeeperHeartbeat<'info> {
    pub keeper: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, constraint = config.keeper == keeper.key() @ CopierError::NotKeeper)]
    pub config: Box<Account<'info, Config>>,
}

#[derive(Accounts)]
pub struct SetPlatformMint<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ CopierError::NotAdmin)]
    pub config: Box<Account<'info, Config>>,
    #[account(seeds = [COPIER_SEED, copier.mint.as_ref()], bump = copier.bump)]
    pub copier: Box<Account<'info, Copier>>,
}

/// `propose_keeper` / `propose_params` / `propose_descriptors`: the admin queues a change in the
/// next `["pending", id]` account (admin pays its rent, refunded on execute / cancel).
#[derive(Accounts)]
pub struct ProposeChange<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ CopierError::NotAdmin)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        init,
        payer = admin,
        space = 8 + PendingChange::INIT_SPACE,
        seeds = [PENDING_SEED, &config.next_change_id.to_le_bytes()],
        bump
    )]
    pub pending: Box<Account<'info, PendingChange>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ProposeIndexTargets<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ CopierError::NotAdmin)]
    pub config: Box<Account<'info, Config>>,
    #[account(seeds = [COPIER_SEED, copier.mint.as_ref()], bump = copier.bump)]
    pub copier: Box<Account<'info, Copier>>,
    #[account(
        init,
        payer = admin,
        space = 8 + PendingChange::INIT_SPACE,
        seeds = [PENDING_SEED, &config.next_change_id.to_le_bytes()],
        bump
    )]
    pub pending: Box<Account<'info, PendingChange>>,
    pub system_program: Program<'info, System>,
}

/// Permissionless once `pending.eta` has passed.
#[derive(Accounts)]
pub struct ExecutePending<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        mut,
        seeds = [PENDING_SEED, &pending.id.to_le_bytes()],
        bump = pending.bump,
        close = proposer
    )]
    pub pending: Box<Account<'info, PendingChange>>,
    /// CHECK: receives the pending account's rent; must be its proposer.
    #[account(mut, address = pending.proposer @ CopierError::PendingChangeInvalid)]
    pub proposer: UncheckedAccount<'info>,
    /// The Index copier of an `IndexTargets` change (omit for other kinds).
    #[account(mut)]
    pub copier: Option<Box<Account<'info, Copier>>>,
}

#[derive(Accounts)]
pub struct CancelPending<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ CopierError::NotAdmin)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        mut,
        seeds = [PENDING_SEED, &pending.id.to_le_bytes()],
        bump = pending.bump,
        close = proposer
    )]
    pub pending: Box<Account<'info, PendingChange>>,
    /// CHECK: receives the pending account's rent; must be its proposer.
    #[account(mut, address = pending.proposer @ CopierError::PendingChangeInvalid)]
    pub proposer: UncheckedAccount<'info>,
}

/// Permissionless cleanup of a change that can no longer execute (superseded or expired).
#[derive(Accounts)]
pub struct DiscardPending<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        mut,
        seeds = [PENDING_SEED, &pending.id.to_le_bytes()],
        bump = pending.bump,
        close = proposer
    )]
    pub pending: Box<Account<'info, PendingChange>>,
    /// CHECK: receives the pending account's rent; must be its proposer.
    #[account(mut, address = pending.proposer @ CopierError::PendingChangeInvalid)]
    pub proposer: UncheckedAccount<'info>,
}

/// Marks the live proposal of `kind` (if any) as no longer executable.
fn invalidate(config: &mut Config, kind: ChangeKind, reason: InvalidationReason, ts: i64) {
    let id = config.latest_change_ids[kind.index()];
    if id != NO_CHANGE {
        config.latest_change_ids[kind.index()] = NO_CHANGE;
        emit!(ChangeInvalidated { id, kind, reason, ts });
    }
}

/// The live proposal of its kind leaves the queue (executed, cancelled or discarded).
fn release(config: &mut Config, pending: &PendingChange) {
    if config.latest_change_ids[pending.kind.index()] == pending.id {
        config.latest_change_ids[pending.kind.index()] = NO_CHANGE;
    }
}

fn emit_config(config: &Config) -> Result<()> {
    emit!(ParamsUpdated {
        params: config.params,
        admin: config.admin,
        pending_admin: config.pending_admin,
        keeper: config.keeper,
        platform_mint: config.platform_mint,
        descriptors: config.descriptors.len() as u8,
        ts: Clock::get()?.unix_timestamp,
    });
    Ok(())
}

pub fn initialize_config(ctx: Context<InitializeConfig>, keeper: Pubkey, timelock_secs: i64) -> Result<()> {
    require!(
        (MIN_TIMELOCK_SECS..=MAX_TIMELOCK_SECS).contains(&timelock_secs),
        CopierError::TimelockOutOfRange
    );
    let descriptors = default_descriptors();
    let proven = validate_descriptors(&descriptors, None)?;
    let now = Clock::get()?.unix_timestamp;
    let config = &mut ctx.accounts.config;
    config.admin = ctx.accounts.admin.key();
    config.pending_admin = Pubkey::default();
    config.keeper = keeper;
    config.platform_mint = Pubkey::default();
    config.params = Params::default();
    config.descriptors = descriptors;
    config.bump = ctx.bumps.config;
    config.burn_pool_bump = ctx.bumps.burn_pool;
    config.platform_burned = 0;
    config.platform_burn_spent = 0;
    config.timelock_secs = timelock_secs;
    config.next_change_id = 0;
    config.pending_admin_eta = 0;
    config.keeper_heartbeat_ts = now;
    config.last_platform_burn_ts = 0;
    config.latest_change_ids = [NO_CHANGE; 4];
    config.descriptors_proven = proven;

    let rent = super::zero_rent()?;
    let have = ctx.accounts.burn_pool.lamports();
    if have < rent {
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.admin.to_account_info(),
                    to: ctx.accounts.burn_pool.to_account_info(),
                },
            ),
            rent - have,
        )?;
    }
    emit_config(config)
}

/// Fills the next pending change, makes it the only executable proposal of its kind (the previous
/// one, if still queued, is superseded) and advances the id counter.
fn queue(
    config: &mut Config,
    pending: &mut PendingChange,
    proposer: Pubkey,
    bump: u8,
    kind: ChangeKind,
    fill: impl FnOnce(&mut PendingChange),
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    pending.id = config.next_change_id;
    pending.kind = kind;
    pending.proposer = proposer;
    pending.proposed_at = now;
    pending.eta = now.checked_add(config.timelock_secs).ok_or(CopierError::MathOverflow)?;
    pending.expires_at = pending.eta.checked_add(EXECUTE_WINDOW_SECS).ok_or(CopierError::MathOverflow)?;
    pending.keeper = Pubkey::default();
    pending.params = config.params;
    pending.descriptors = vec![];
    pending.copier = Pubkey::default();
    pending.targets = vec![];
    pending.bump = bump;
    fill(pending);
    invalidate(config, kind, InvalidationReason::Superseded, now);
    config.latest_change_ids[kind.index()] = pending.id;
    config.next_change_id += 1;
    emit!(ChangeProposed { id: pending.id, kind, eta: pending.eta, expires_at: pending.expires_at, ts: now });
    Ok(())
}

pub fn propose_keeper(ctx: Context<ProposeChange>, keeper: Pubkey) -> Result<()> {
    let a = ctx.accounts;
    queue(&mut a.config, &mut a.pending, a.admin.key(), ctx.bumps.pending, ChangeKind::Keeper, |p| {
        p.keeper = keeper
    })
}

pub fn propose_params(ctx: Context<ProposeChange>, params: Params) -> Result<()> {
    params.validate()?;
    let a = ctx.accounts;
    queue(&mut a.config, &mut a.pending, a.admin.key(), ctx.bumps.pending, ChangeKind::Params, |p| {
        p.params = params
    })
}

pub fn propose_descriptors(ctx: Context<ProposeChange>, descriptors: Vec<TradeDescriptor>) -> Result<()> {
    let a = ctx.accounts;
    validate_descriptors(&descriptors, Some((&a.config.descriptors, a.config.descriptors_proven)))?;
    queue(&mut a.config, &mut a.pending, a.admin.key(), ctx.bumps.pending, ChangeKind::Descriptors, |p| {
        p.descriptors = descriptors
    })
}

pub fn propose_index_targets(ctx: Context<ProposeIndexTargets>, targets: Vec<Pubkey>) -> Result<()> {
    let a = ctx.accounts;
    super::register::check_index_targets(&a.copier, &targets)?;
    let copier = a.copier.key();
    queue(&mut a.config, &mut a.pending, a.admin.key(), ctx.bumps.pending, ChangeKind::IndexTargets, |p| {
        p.copier = copier;
        p.targets = targets;
    })
}

pub fn execute_pending(ctx: Context<ExecutePending>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let a = ctx.accounts;
    let pending = &a.pending;
    let config = &mut a.config;
    require!(
        config.latest_change_ids[pending.kind.index()] == pending.id,
        CopierError::PendingChangeSuperseded
    );
    require!(now >= pending.eta, CopierError::TimelockNotElapsed);
    require!(now <= pending.expires_at, CopierError::PendingChangeExpired);
    release(config, pending);
    match pending.kind {
        ChangeKind::Keeper => {
            config.keeper = pending.keeper;
            // The new keeper starts with a fresh heartbeat.
            config.keeper_heartbeat_ts = now;
            emit_config(config)?;
        }
        ChangeKind::Params => {
            pending.params.validate()?;
            config.params = pending.params;
            emit_config(config)?;
        }
        ChangeKind::Descriptors => {
            let proven =
                validate_descriptors(&pending.descriptors, Some((&config.descriptors, config.descriptors_proven)))?;
            config.descriptors = pending.descriptors.clone();
            config.descriptors_proven = proven;
            emit_config(config)?;
        }
        ChangeKind::IndexTargets => {
            let copier = a.copier.as_mut().ok_or(CopierError::PendingChangeInvalid)?;
            require_keys_eq!(copier.key(), pending.copier, CopierError::PendingChangeInvalid);
            super::register::apply_index_targets(copier, pending.targets.clone())?;
        }
    }
    emit!(ChangeExecuted { id: pending.id, kind: pending.kind, ts: now });
    Ok(())
}

pub fn cancel_pending(ctx: Context<CancelPending>) -> Result<()> {
    let p = &ctx.accounts.pending;
    release(&mut ctx.accounts.config, p);
    emit!(ChangeCancelled { id: p.id, kind: p.kind, ts: Clock::get()?.unix_timestamp });
    Ok(())
}

/// Anyone closes a change that can no longer execute: superseded / invalidated, or past
/// `expires_at`. Rent returns to its proposer.
pub fn discard_pending(ctx: Context<DiscardPending>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let p = &ctx.accounts.pending;
    let config = &mut ctx.accounts.config;
    let superseded = config.latest_change_ids[p.kind.index()] != p.id;
    require!(superseded || now > p.expires_at, CopierError::PendingChangeLive);
    release(config, p);
    emit!(ChangeDiscarded { id: p.id, kind: p.kind, ts: now });
    Ok(())
}

/// Instant: removes the keeper (only reduces power). A new keeper needs `propose_keeper`.
pub fn pause_keeper(ctx: Context<AdminOnly>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let config = &mut ctx.accounts.config;
    let keeper = config.keeper;
    config.keeper = Pubkey::default();
    // A queued keeper change was proposed before the pause: it must not re-install a keeper.
    invalidate(config, ChangeKind::Keeper, InvalidationReason::KeeperPaused, now);
    emit!(KeeperPaused { keeper, ts: now });
    emit_config(config)
}

/// The keeper proves liveness; a stale heartbeat opens permissionless exits.
pub fn keeper_heartbeat(ctx: Context<KeeperHeartbeat>) -> Result<()> {
    ctx.accounts.config.keeper_heartbeat_ts = Clock::get()?.unix_timestamp;
    Ok(())
}

/// Step one of the admin handover; `accept_admin` is possible after the timelock.
pub fn propose_admin(ctx: Context<AdminOnly>, new_admin: Pubkey) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.pending_admin = new_admin;
    config.pending_admin_eta = Clock::get()?
        .unix_timestamp
        .checked_add(config.timelock_secs)
        .ok_or(CopierError::MathOverflow)?;
    emit_config(config)
}

pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let config = &mut ctx.accounts.config;
    require!(now >= config.pending_admin_eta, CopierError::TimelockNotElapsed);
    // Nothing the previous admin queued survives the handover.
    for kind in ChangeKind::ALL {
        invalidate(config, kind, InvalidationReason::AdminChanged, now);
    }
    config.admin = ctx.accounts.pending_admin.key();
    config.pending_admin = Pubkey::default();
    config.pending_admin_eta = 0;
    emit_config(config)
}

pub fn set_platform_mint(ctx: Context<SetPlatformMint>, mint: Pubkey) -> Result<()> {
    let config = &mut ctx.accounts.config;
    require_keys_eq!(config.platform_mint, Pubkey::default(), CopierError::PlatformMintAlreadySet);
    let copier = &ctx.accounts.copier;
    require!(copier.mint == mint && copier.kind == CopierKind::Index, CopierError::PlatformMintNotIndex);
    config.platform_mint = mint;
    emit_config(config)
}
