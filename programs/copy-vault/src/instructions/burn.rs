//! Buybacks: `buyback_burn` spends a copier's buyback pool (75% of its profit above the HWM) on
//! its own coin; `burn_platform` spends the burn pool (25% of every copier's profit) on the platform token.
//! Everything bought is burned in the same instruction (`burn_checked`, the buying PDA signing).

use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::CopierError;
use crate::events::{BuybackBurned, PlatformBurned};
use crate::guard;
use crate::math;
use crate::state::{Config, Copier, Params, Side, Venue};
use crate::venue::Trader;

#[derive(Accounts)]
pub struct BuybackBurn<'info> {
    pub keeper: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, constraint = config.keeper == keeper.key() @ CopierError::NotKeeper)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [COPIER_SEED, mint.key().as_ref()], bump = copier.bump)]
    pub copier: Box<Account<'info, Copier>>,
    #[account(mut, seeds = [VAULT_SEED, mint.key().as_ref()], bump = copier.vault_bump)]
    pub vault: SystemAccount<'info>,
    /// CHECK: the copier's own coin (`copier.mint` by the seeds above); burned from.
    #[account(mut)]
    pub mint: UncheckedAccount<'info>,
    /// CHECK: ATA(vault, mint, Token-2022); created by the program when missing.
    #[account(mut)]
    pub vault_token_account: UncheckedAccount<'info>,
    /// CHECK: ATA(vault, wSOL, SPL Token); opened and closed around pool buys.
    #[account(mut)]
    pub vault_wsol: UncheckedAccount<'info>,
    /// CHECK: owner program of `mint`, checked by `Trader`.
    pub token_program: UncheckedAccount<'info>,
    /// CHECK: SPL Token, checked by `Trader`.
    pub quote_token_program: UncheckedAccount<'info>,
    pub associated_token_program: Program<'info, anchor_spl::associated_token::AssociatedToken>,
    pub system_program: Program<'info, System>,
    /// CHECK: the instructions sysvar (address-checked by `guard::check_isolated`).
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct BurnPlatform<'info> {
    pub keeper: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, constraint = config.keeper == keeper.key() @ CopierError::NotKeeper)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [BURN_POOL_SEED], bump = config.burn_pool_bump)]
    pub burn_pool: SystemAccount<'info>,
    /// CHECK: must be `config.platform_mint`; burned from.
    #[account(mut, constraint = platform_mint.key() == config.platform_mint @ CopierError::PlatformMintNotSet)]
    pub platform_mint: UncheckedAccount<'info>,
    /// CHECK: ATA(burn_pool, platform_mint, Token-2022); created by the program when missing.
    #[account(mut)]
    pub burn_pool_token_account: UncheckedAccount<'info>,
    /// CHECK: ATA(burn_pool, wSOL, SPL Token); opened and closed around pool buys.
    #[account(mut)]
    pub burn_pool_wsol: UncheckedAccount<'info>,
    /// CHECK: owner program of `platform_mint`, checked by `Trader`.
    pub token_program: UncheckedAccount<'info>,
    /// CHECK: SPL Token, checked by `Trader`.
    pub quote_token_program: UncheckedAccount<'info>,
    pub associated_token_program: Program<'info, anchor_spl::associated_token::AssociatedToken>,
    pub system_program: Program<'info, System>,
    /// CHECK: the instructions sysvar (address-checked by `guard::check_isolated`).
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions: UncheckedAccount<'info>,
}

/// Buys with `trader` per `desc` / `ix_data` spending `sol_in` (alone in its transaction, at most
/// `max_impact_bps` of the venue's real quote reserves), checks the fill against the program
/// floor, then burns everything bought. Returns (lamports spent, tokens burned, venue, venue key).
#[allow(clippy::too_many_arguments)]
fn buy_and_burn(
    trader: &Trader,
    instructions: &AccountInfo,
    desc: &crate::state::TradeDescriptor,
    sol_in: u64,
    min_tokens_out: u64,
    ix_data: Vec<u8>,
    params: &Params,
    check_wsol: bool,
) -> Result<(u64, u64, Venue, Pubkey)> {
    require!(sol_in > 0, CopierError::ZeroAmount);
    trader.check_accounts(check_wsol)?;
    let quote = trader.inspect(desc, Side::Buy, &ix_data)?;
    guard::check_isolated(instructions, &quote.venue_key)?;
    require!(
        sol_in <= math::bps_of(quote.real_quote, params.max_impact_bps as u64)?,
        CopierError::ExceedsImpact
    );
    let slippage_bps = params.slippage_bps;
    let total_before = trader.sol_balance();
    let tokens_before = trader.token_balance();
    trader.buy(desc, sol_in, ix_data)?;
    let spent = total_before.checked_sub(trader.sol_balance()).ok_or(CopierError::Overspent)?;
    require!(spent <= sol_in.saturating_add(RENT_ALLOWANCE_LAMPORTS), CopierError::Overspent);
    let tokens_out = trader.token_balance().saturating_sub(tokens_before);
    let floor = math::floor_after_slippage(quote.buy_quote(sol_in)?, slippage_bps)?;
    require!(tokens_out > 0 && tokens_out >= floor.max(min_tokens_out), CopierError::SlippageTokens);
    trader.burn(tokens_out)?;
    Ok((spent, tokens_out, quote.venue, quote.venue_key))
}

pub fn buyback_burn<'info>(
    ctx: Context<'_, '_, 'info, 'info, BuybackBurn<'info>>,
    descriptor_idx: u8,
    sol_in: u64,
    min_tokens_out: u64,
    ix_data: Vec<u8>,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let a = ctx.accounts;
    super::sync_vault(&mut a.copier, &a.vault, &a.vault_wsol)?;
    require!(
        now.saturating_sub(a.copier.last_buyback_ts) >= BUYBACK_INTERVAL_SECS,
        CopierError::BuybackTooSoon
    );
    require!(sol_in <= a.copier.buyback_pool, CopierError::ExceedsBuybackPool);
    let desc = *a.config.descriptors.get(descriptor_idx as usize).ok_or(CopierError::DescriptorIndex)?;
    let mint = a.copier.mint;
    let vault_seeds: &[&[u8]] = &[VAULT_SEED, mint.as_ref(), &[a.copier.vault_bump]];
    let vault_info = a.vault.to_account_info();
    let trader = Trader {
        actor: &vault_info,
        actor_seeds: vault_seeds,
        token_mint: &a.mint,
        actor_tokens: &a.vault_token_account,
        actor_wsol: &a.vault_wsol,
        token_program: &a.token_program,
        quote_token_program: &a.quote_token_program,
        associated_token_program: a.associated_token_program.as_ref(),
        system_program: a.system_program.as_ref(),
        remaining: ctx.remaining_accounts,
    };
    let (spent, burned, venue, venue_key) =
        buy_and_burn(&trader, &a.instructions, &desc, sol_in, min_tokens_out, ix_data, &a.config.params, false)?;

    let m = &mut a.copier;
    // `sol_in` ≤ the pool was checked up front; rent a first buy pays on top (the vault's token
    // account, the venue's volume accumulator) comes out of free SOL.
    m.buyback_pool -= spent.min(m.buyback_pool);
    m.buyback_spent = m.buyback_spent.checked_add(spent).ok_or(CopierError::MathOverflow)?;
    m.burned = m.burned.checked_add(burned).ok_or(CopierError::MathOverflow)?;
    m.last_buyback_ts = now;
    m.last_keeper_ts = now;
    a.config.keeper_heartbeat_ts = now;
    a.config.descriptors_proven |= 1 << descriptor_idx;
    if venue == Venue::Pool {
        m.graduated_pool = venue_key;
    }
    m.accounted_lamports = super::vault_total(&vault_info, &a.vault_wsol);
    emit!(BuybackBurned { mint, sol_in: spent, tokens_burned: burned, total_burned: m.burned, ts: now });
    Ok(())
}

pub fn burn_platform<'info>(
    ctx: Context<'_, '_, 'info, 'info, BurnPlatform<'info>>,
    descriptor_idx: u8,
    sol_in: u64,
    min_tokens_out: u64,
    ix_data: Vec<u8>,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let a = ctx.accounts;
    require_keys_neq!(a.config.platform_mint, Pubkey::default(), CopierError::PlatformMintNotSet);
    require!(
        now.saturating_sub(a.config.last_platform_burn_ts) >= BUYBACK_INTERVAL_SECS,
        CopierError::PlatformBurnTooSoon
    );
    let desc = *a.config.descriptors.get(descriptor_idx as usize).ok_or(CopierError::DescriptorIndex)?;
    let pool_info = a.burn_pool.to_account_info();
    let available = pool_info
        .lamports()
        .saturating_add(crate::pump::wsol_address_lamports(&a.burn_pool_wsol))
        .saturating_sub(super::zero_rent()?);
    require!(sol_in <= available, CopierError::ExceedsBurnPool);
    let seeds: &[&[u8]] = &[BURN_POOL_SEED, &[a.config.burn_pool_bump]];
    let trader = Trader {
        actor: &pool_info,
        actor_seeds: seeds,
        token_mint: &a.platform_mint,
        actor_tokens: &a.burn_pool_token_account,
        actor_wsol: &a.burn_pool_wsol,
        token_program: &a.token_program,
        quote_token_program: &a.quote_token_program,
        associated_token_program: a.associated_token_program.as_ref(),
        system_program: a.system_program.as_ref(),
        remaining: ctx.remaining_accounts,
    };
    let (spent, burned, _, _) =
        buy_and_burn(&trader, &a.instructions, &desc, sol_in, min_tokens_out, ix_data, &a.config.params, true)?;
    require!(spent <= available, CopierError::ExceedsBurnPool);
    let config = &mut a.config;
    config.platform_burned = config.platform_burned.checked_add(burned).ok_or(CopierError::MathOverflow)?;
    config.platform_burn_spent = config.platform_burn_spent.checked_add(spent).ok_or(CopierError::MathOverflow)?;
    config.last_platform_burn_ts = now;
    config.keeper_heartbeat_ts = now;
    config.descriptors_proven |= 1 << descriptor_idx;
    emit!(PlatformBurned { sol_in: spent, tokens_burned: burned, ts: now });
    Ok(())
}
