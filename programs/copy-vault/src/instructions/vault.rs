//! Vault bookkeeping anyone (or the target) can call: `deposit`, `sync`, `verify_trader`,
//! `unverify_trader`, `fund_platform_burn`. None of them can move vault SOL anywhere but the
//! the platform token burn pool.

use anchor_lang::prelude::*;
use anchor_lang::system_program;

use crate::constants::*;
use crate::errors::CopierError;
use crate::events::{Deposited, TraderVerified};
use crate::state::{Config, Copier};

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub depositor: Signer<'info>,
    #[account(mut, seeds = [COPIER_SEED, copier.mint.as_ref()], bump = copier.bump)]
    pub copier: Account<'info, Copier>,
    #[account(mut, seeds = [VAULT_SEED, copier.mint.as_ref()], bump = copier.vault_bump)]
    pub vault: SystemAccount<'info>,
    /// CHECK: the vault's canonical wSOL ATA (may not exist); checked in `sync_vault`.
    pub vault_wsol: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SyncVault<'info> {
    #[account(mut, seeds = [COPIER_SEED, copier.mint.as_ref()], bump = copier.bump)]
    pub copier: Account<'info, Copier>,
    #[account(seeds = [VAULT_SEED, copier.mint.as_ref()], bump = copier.vault_bump)]
    pub vault: SystemAccount<'info>,
    /// CHECK: the vault's canonical wSOL ATA (may not exist); checked in `sync_vault`.
    pub vault_wsol: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct VerifyTrader<'info> {
    pub target: Signer<'info>,
    #[account(mut, seeds = [COPIER_SEED, copier.mint.as_ref()], bump = copier.bump)]
    pub copier: Account<'info, Copier>,
}

#[derive(Accounts)]
pub struct FundPlatformBurn<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [COPIER_SEED, copier.mint.as_ref()], bump = copier.bump)]
    pub copier: Account<'info, Copier>,
    #[account(mut, seeds = [VAULT_SEED, copier.mint.as_ref()], bump = copier.vault_bump)]
    pub vault: SystemAccount<'info>,
    /// CHECK: the vault's canonical wSOL ATA (may not exist); checked in `sync_vault`.
    pub vault_wsol: UncheckedAccount<'info>,
    #[account(mut, seeds = [BURN_POOL_SEED], bump = config.burn_pool_bump)]
    pub burn_pool: SystemAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn deposit(ctx: Context<Deposit>, lamports: u64) -> Result<()> {
    require!(lamports > 0, CopierError::ZeroAmount);
    let a = ctx.accounts;
    super::sync_vault(&mut a.copier, &a.vault, &a.vault_wsol)?;
    system_program::transfer(
        CpiContext::new(
            a.system_program.to_account_info(),
            system_program::Transfer { from: a.depositor.to_account_info(), to: a.vault.to_account_info() },
        ),
        lamports,
    )?;
    let copier = &mut a.copier;
    copier.capital_in = copier.capital_in.checked_add(lamports).ok_or(CopierError::MathOverflow)?;
    copier.accounted_lamports = super::vault_total(&a.vault, &a.vault_wsol);
    emit!(Deposited {
        mint: copier.mint,
        from: a.depositor.key(),
        lamports,
        ts: Clock::get()?.unix_timestamp,
    });
    Ok(())
}

pub fn sync(ctx: Context<SyncVault>) -> Result<()> {
    let a = ctx.accounts;
    super::sync_vault(&mut a.copier, &a.vault, &a.vault_wsol)?;
    Ok(())
}

fn set_verified(ctx: Context<VerifyTrader>, target_idx: u8, verified: bool) -> Result<()> {
    let copier = &mut ctx.accounts.copier;
    let i = target_idx as usize;
    require!(i < copier.targets.len(), CopierError::TargetIndex);
    require_keys_eq!(copier.targets[i], ctx.accounts.target.key(), CopierError::TargetMismatch);
    if verified {
        copier.verified |= 1 << i;
    } else {
        copier.verified &= !(1 << i);
    }
    emit!(TraderVerified {
        mint: copier.mint,
        target: ctx.accounts.target.key(),
        verified,
        ts: Clock::get()?.unix_timestamp,
    });
    Ok(())
}

pub fn verify_trader(ctx: Context<VerifyTrader>, target_idx: u8) -> Result<()> {
    set_verified(ctx, target_idx, true)
}

pub fn unverify_trader(ctx: Context<VerifyTrader>, target_idx: u8) -> Result<()> {
    set_verified(ctx, target_idx, false)
}

/// Moves as much of the copier's pending the platform token share as the vault's lamports above rent allow
/// to the burn pool. Returns the amount moved.
pub fn flush_copier_share<'info>(
    copier: &mut Copier,
    vault: &AccountInfo<'info>,
    burn_pool: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
) -> Result<u64> {
    let spare = vault.lamports().saturating_sub(super::zero_rent()?);
    let amount = copier.platform_pending.min(spare);
    if amount == 0 {
        return Ok(0);
    }
    let mint = copier.mint;
    let seeds: &[&[u8]] = &[VAULT_SEED, mint.as_ref(), &[copier.vault_bump]];
    system_program::transfer(
        CpiContext::new_with_signer(
            system_program.clone(),
            system_program::Transfer { from: vault.clone(), to: burn_pool.clone() },
            &[seeds],
        ),
        amount,
    )?;
    copier.platform_pending -= amount;
    copier.platform_sent = copier.platform_sent.checked_add(amount).ok_or(CopierError::MathOverflow)?;
    Ok(amount)
}

pub fn fund_platform_burn(ctx: Context<FundPlatformBurn>) -> Result<()> {
    let a = ctx.accounts;
    super::sync_vault(&mut a.copier, &a.vault, &a.vault_wsol)?;
    flush_copier_share(
        &mut a.copier,
        &a.vault.to_account_info(),
        &a.burn_pool.to_account_info(),
        &a.system_program.to_account_info(),
    )?;
    a.copier.accounted_lamports = super::vault_total(&a.vault, &a.vault_wsol);
    Ok(())
}
