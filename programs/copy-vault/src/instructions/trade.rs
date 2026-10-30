//! `copier_buy` / `copier_sell`: the vault copies its target through a whitelisted pump venue
//! instruction. Every limit is enforced on-chain from the target's token balance, the venue's
//! reserves and the vault's measured balance deltas; the keeper only chooses when and how much
//! within them.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::solana_program::system_instruction;
use anchor_lang::system_program;
use anchor_spl::associated_token::get_associated_token_address_with_program_id;

use crate::constants::*;
use crate::errors::CopierError;
use crate::events::{CopierBuy, CopierSell, ProfitSplit};
use crate::guard;
use crate::math;
use crate::pump;
use crate::state::{Config, Copier, CopierKind, Position, Side};
use crate::venue::Trader;

#[derive(Accounts)]
pub struct CopierBuyAccounts<'info> {
    pub keeper: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, constraint = config.keeper == keeper.key() @ CopierError::NotKeeper)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [COPIER_SEED, copier.mint.as_ref()], bump = copier.bump)]
    pub copier: Box<Account<'info, Copier>>,
    #[account(mut, seeds = [VAULT_SEED, copier.mint.as_ref()], bump = copier.vault_bump)]
    pub vault: SystemAccount<'info>,
    /// CHECK: the copied coin; its owner must be `token_program` (checked by `Trader`).
    pub token_mint: UncheckedAccount<'info>,
    /// CHECK: PDA `["position", copier.mint, token_mint]` (checked in the handler with the stored
    /// bump once it exists); created by the program on the first buy.
    #[account(mut)]
    pub position: UncheckedAccount<'info>,
    /// CHECK: must be `copier.targets[target_idx]`.
    pub target: UncheckedAccount<'info>,
    /// CHECK: the target's canonical ATA for `token_mint` (may not exist).
    pub target_token_account: UncheckedAccount<'info>,
    /// CHECK: ATA(vault, token_mint, token_program); created by the program when missing.
    #[account(mut)]
    pub vault_token_account: UncheckedAccount<'info>,
    /// CHECK: ATA(vault, wSOL, SPL Token); opened and closed around pool trades.
    #[account(mut)]
    pub vault_wsol: UncheckedAccount<'info>,
    /// CHECK: owner program of `token_mint` (SPL Token or Token-2022), checked by `Trader`.
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
pub struct CopierSellAccounts<'info> {
    /// The keeper, or anyone once the keeper heartbeat is older than `keeper_grace_secs` and the
    /// target holds 0 (then in impact-capped slices, one per slot).
    pub authority: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [COPIER_SEED, copier.mint.as_ref()], bump = copier.bump)]
    pub copier: Box<Account<'info, Copier>>,
    #[account(mut, seeds = [VAULT_SEED, copier.mint.as_ref()], bump = copier.vault_bump)]
    pub vault: SystemAccount<'info>,
    #[account(mut, seeds = [BURN_POOL_SEED], bump = config.burn_pool_bump)]
    pub burn_pool: SystemAccount<'info>,
    /// CHECK: the coin being sold; its owner must be `token_program` (checked by `Trader`).
    pub token_mint: UncheckedAccount<'info>,
    /// `["position", copier.mint, token_mint]`: the open position being sold.
    #[account(
        mut,
        seeds = [POSITION_SEED, copier.mint.as_ref(), token_mint.key().as_ref()],
        bump = position.bump,
        constraint = position.tokens > 0 @ CopierError::NoPosition
    )]
    pub position: Box<Account<'info, Position>>,
    /// CHECK: must be `copier.targets[target_idx]` and the position's target.
    pub target: UncheckedAccount<'info>,
    /// CHECK: the target's canonical ATA for `token_mint` (may not exist).
    pub target_token_account: UncheckedAccount<'info>,
    /// CHECK: ATA(vault, token_mint, token_program).
    #[account(mut)]
    pub vault_token_account: UncheckedAccount<'info>,
    /// CHECK: ATA(vault, wSOL, SPL Token); opened and closed around pool trades.
    #[account(mut)]
    pub vault_wsol: UncheckedAccount<'info>,
    /// CHECK: owner program of `token_mint`, checked by `Trader`.
    pub token_program: UncheckedAccount<'info>,
    /// CHECK: SPL Token, checked by `Trader`.
    pub quote_token_program: UncheckedAccount<'info>,
    pub associated_token_program: Program<'info, anchor_spl::associated_token::AssociatedToken>,
    pub system_program: Program<'info, System>,
    /// CHECK: the instructions sysvar (address-checked by `guard::check_isolated`).
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions: UncheckedAccount<'info>,
}

/// The target at `target_idx` and its current balance of `token_mint` (0 when its canonical ATA
/// does not exist).
fn target_balance(
    copier: &Copier,
    target_idx: u8,
    target: &AccountInfo,
    target_token_account: &AccountInfo,
    token_mint: &AccountInfo,
) -> Result<(usize, u64)> {
    let i = target_idx as usize;
    require!(i < copier.targets.len(), CopierError::TargetIndex);
    require_keys_eq!(copier.targets[i], target.key(), CopierError::TargetMismatch);
    require_keys_eq!(
        target_token_account.key(),
        get_associated_token_address_with_program_id(target.key, token_mint.key, token_mint.owner),
        CopierError::TargetTokenAccount
    );
    let balance = match pump::token_account_fields(target_token_account) {
        Some((mint, owner, amount)) if mint == token_mint.key() && owner == target.key() => amount,
        _ => 0,
    };
    Ok((i, balance))
}

fn load_position(info: &AccountInfo) -> Result<Option<Position>> {
    if *info.owner == system_program::ID && info.data_len() == 0 {
        return Ok(None);
    }
    require_keys_eq!(*info.owner, crate::ID, CopierError::PositionInvalid);
    let data = info.try_borrow_data()?;
    Ok(Some(Position::try_deserialize(&mut &data[..]).map_err(|_| error!(CopierError::PositionInvalid))?))
}

fn store_position(info: &AccountInfo, position: &Position) -> Result<()> {
    let mut data = info.try_borrow_mut_data()?;
    let mut writer: &mut [u8] = &mut data;
    position.try_serialize(&mut writer)
}

/// Creates the position account at its PDA with the vault paying the rent. Lamports someone
/// already sent to the address (which a plain `create_account` would refuse) are kept: up to
/// rent they pay the account's rent, the rest moves to the vault. Returns that excess, which the
/// caller books as fee income.
fn create_position<'info>(
    position: &AccountInfo<'info>,
    vault: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    vault_seeds: &[&[u8]],
    position_seeds: &[&[u8]],
) -> Result<u64> {
    let rent = Rent::get()?.minimum_balance(Position::SPACE);
    let have = position.lamports();
    let excess = have.saturating_sub(rent);
    if excess > 0 {
        system_program::transfer(
            CpiContext::new_with_signer(
                system_program.clone(),
                system_program::Transfer { from: position.clone(), to: vault.clone() },
                &[position_seeds],
            ),
            excess,
        )?;
    } else if have < rent {
        system_program::transfer(
            CpiContext::new_with_signer(
                system_program.clone(),
                system_program::Transfer { from: vault.clone(), to: position.clone() },
                &[vault_seeds],
            ),
            rent - have,
        )?;
    }
    let accounts = [position.clone(), system_program.clone()];
    invoke_signed(
        &system_instruction::allocate(position.key, Position::SPACE as u64),
        &accounts,
        &[position_seeds],
    )?;
    invoke_signed(&system_instruction::assign(position.key, &crate::ID), &accounts, &[position_seeds])?;
    Ok(excess)
}

#[allow(clippy::too_many_arguments)]
pub fn copier_buy<'info>(
    ctx: Context<'_, '_, 'info, 'info, CopierBuyAccounts<'info>>,
    target_idx: u8,
    descriptor_idx: u8,
    sol_in: u64,
    min_tokens_out: u64,
    ix_data: Vec<u8>,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let a = ctx.accounts;
    super::sync_vault(&mut a.copier, &a.vault, &a.vault_wsol)?;
    let params = a.config.params;
    let desc = *a.config.descriptors.get(descriptor_idx as usize).ok_or(CopierError::DescriptorIndex)?;
    let mint = a.copier.mint;
    require_keys_neq!(a.token_mint.key(), mint, CopierError::OwnMint);

    let vault_seeds: &[&[u8]] = &[VAULT_SEED, mint.as_ref(), &[a.copier.vault_bump]];
    let vault_info = a.vault.to_account_info();
    let trader = Trader {
        actor: &vault_info,
        actor_seeds: vault_seeds,
        token_mint: &a.token_mint,
        actor_tokens: &a.vault_token_account,
        actor_wsol: &a.vault_wsol,
        token_program: &a.token_program,
        quote_token_program: &a.quote_token_program,
        associated_token_program: a.associated_token_program.as_ref(),
        system_program: a.system_program.as_ref(),
        remaining: ctx.remaining_accounts,
    };
    trader.check_accounts(false)?;
    let quote = trader.inspect(&desc, Side::Buy, &ix_data)?;
    guard::check_isolated(&a.instructions, &quote.venue_key)?;

    // ---- the signal: the target's balance rose by enough value since the last copy ----
    let (ti, target_now) = target_balance(&a.copier, target_idx, &a.target, &a.target_token_account, &a.token_mint)?;
    let existing = load_position(&a.position)?;
    let token_mint_key = a.token_mint.key();
    let position_bump = match &existing {
        Some(p) => {
            require!(p.mint == mint && p.token_mint == token_mint_key, CopierError::PositionInvalid);
            let key = Pubkey::create_program_address(
                &[POSITION_SEED, mint.as_ref(), token_mint_key.as_ref(), &[p.bump]],
                &crate::ID,
            )
            .map_err(|_| error!(CopierError::PositionInvalid))?;
            require_keys_eq!(a.position.key(), key, CopierError::PositionInvalid);
            require_keys_eq!(p.target, a.target.key(), CopierError::PositionTargetMismatch);
            p.bump
        }
        None => {
            let (key, bump) =
                Pubkey::find_program_address(&[POSITION_SEED, mint.as_ref(), token_mint_key.as_ref()], &crate::ID);
            require_keys_eq!(a.position.key(), key, CopierError::PositionInvalid);
            bump
        }
    };
    let snapshot = existing.as_ref().map_or(0, |p| p.target_snapshot);
    require!(target_now > snapshot, CopierError::NoTargetIncrease);
    let signal = quote.value_of(target_now - snapshot)?;
    require!(signal >= params.min_signal_lamports, CopierError::SignalTooSmall);

    // ---- sizing caps ----
    let rent = super::zero_rent()?;
    let total_before = trader.sol_balance();
    let equity = a.copier.equity(total_before, rent);
    let position_cost = existing.as_ref().map_or(0, |p| p.cost);
    require!(sol_in >= params.min_trade_lamports, CopierError::TradeTooSmall);
    require!(
        sol_in <= math::bps_of(signal, params.signal_multiple_bps as u64)?,
        CopierError::ExceedsSignal
    );
    require!(sol_in <= math::bps_of(equity, params.max_trade_bps as u64)?, CopierError::ExceedsTradeCap);
    require!(
        position_cost.saturating_add(sol_in) <= math::bps_of(equity, params.max_position_bps as u64)?,
        CopierError::ExceedsPositionCap
    );
    require!(
        sol_in <= math::bps_of(quote.real_quote, params.max_impact_bps as u64)?,
        CopierError::ExceedsImpact
    );
    if existing.is_none() {
        require!(a.copier.open_positions < params.max_open_positions, CopierError::TooManyPositions);
    }
    // The rolling spend window: a fresh window takes the current equity as its base.
    if now.saturating_sub(a.copier.window_start) >= params.spend_window_secs {
        let m = &mut a.copier;
        m.window_start = now;
        m.window_spent = 0;
        m.window_equity = equity;
    }
    let window_cap = math::bps_of(a.copier.window_equity, params.max_window_spend_bps as u64)?;

    // ---- execute ----
    let tokens_before = trader.token_balance();
    let mut donated = 0;
    if existing.is_none() {
        let position_seeds: &[&[u8]] = &[POSITION_SEED, mint.as_ref(), token_mint_key.as_ref(), &[position_bump]];
        donated = create_position(&a.position, &vault_info, a.system_program.as_ref(), vault_seeds, position_seeds)?;
    }
    trader.buy(&desc, sol_in, ix_data)?;

    // ---- measured fill ----
    let total_after = trader.sol_balance();
    let spent = (total_before + donated).checked_sub(total_after).ok_or(CopierError::Overspent)?;
    require!(spent <= sol_in.saturating_add(RENT_ALLOWANCE_LAMPORTS), CopierError::Overspent);
    let window_spent = a.copier.window_spent.checked_add(spent).ok_or(CopierError::MathOverflow)?;
    require!(window_spent <= window_cap, CopierError::SpendWindowExceeded);
    let tokens_out = trader.token_balance().saturating_sub(tokens_before);
    let floor = math::floor_after_slippage(quote.buy_quote(sol_in)?, params.slippage_bps)?;
    require!(tokens_out > 0 && tokens_out >= floor.max(min_tokens_out), CopierError::SlippageTokens);
    require!(
        a.copier.free_sol(total_after, rent) >= params.vault_floor_lamports,
        CopierError::BelowVaultFloor
    );

    // ---- book ----
    let is_new = existing.is_none();
    let mut p = existing.unwrap_or(Position {
        mint,
        token_mint: a.token_mint.key(),
        target: a.target.key(),
        tokens: 0,
        cost: 0,
        target_snapshot: 0,
        target_peak: 0,
        vault_peak: 0,
        opened_at: now,
        last_trade_ts: now,
        bump: position_bump,
    });
    let opened = is_new;
    p.tokens = p.tokens.checked_add(tokens_out).ok_or(CopierError::MathOverflow)?;
    p.cost = p.cost.checked_add(spent).ok_or(CopierError::MathOverflow)?;
    p.target_snapshot = target_now;
    p.target_peak = target_now;
    p.vault_peak = p.tokens;
    p.last_trade_ts = now;
    store_position(&a.position, &p)?;

    let m = &mut a.copier;
    m.open_cost = m.open_cost.checked_add(spent).ok_or(CopierError::MathOverflow)?;
    m.fees_in = m.fees_in.checked_add(donated).ok_or(CopierError::MathOverflow)?;
    m.window_spent = window_spent;
    if opened {
        m.open_positions += 1;
        m.target_positions[ti] += 1;
    }
    m.trades += 1;
    m.last_keeper_ts = now;
    m.accounted_lamports = total_after;
    a.config.keeper_heartbeat_ts = now;
    a.config.descriptors_proven |= 1 << descriptor_idx;

    emit!(CopierBuy {
        mint,
        target: a.target.key(),
        token_mint: a.token_mint.key(),
        venue: quote.venue,
        sol_in: spent,
        tokens_out,
        target_balance: target_now,
        signal_lamports: signal,
        equity,
        ts: now,
    });
    Ok(())
}

/// Tokens the vault may sell now: down to `vault_peak × target_now / target_peak` once the target
/// holds less than at the last copy (or nothing at all).
pub fn allowed_sell(p: &Position, target_now: u64) -> Result<u64> {
    if target_now < p.target_snapshot || target_now == 0 {
        let keep = math::mul_div(p.vault_peak, target_now, p.target_peak)?;
        Ok(p.tokens.saturating_sub(keep))
    } else {
        Ok(0)
    }
}

#[allow(clippy::too_many_arguments)]
pub fn copier_sell<'info>(
    ctx: Context<'_, '_, 'info, 'info, CopierSellAccounts<'info>>,
    target_idx: u8,
    descriptor_idx: u8,
    tokens_in: u64,
    min_sol_out: u64,
    ix_data: Vec<u8>,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let a = ctx.accounts;
    super::sync_vault(&mut a.copier, &a.vault, &a.vault_wsol)?;
    let params = a.config.params;
    let desc = *a.config.descriptors.get(descriptor_idx as usize).ok_or(CopierError::DescriptorIndex)?;
    let mint = a.copier.mint;
    require!(tokens_in > 0, CopierError::ZeroAmount);

    let mut p: Position = (**a.position).clone();
    require!(p.mint == mint && p.token_mint == a.token_mint.key(), CopierError::NoPosition);
    let (ti, target_now) = target_balance(&a.copier, target_idx, &a.target, &a.target_token_account, &a.token_mint)?;
    require_keys_eq!(p.target, a.target.key(), CopierError::PositionTargetMismatch);

    // ---- who may sell how much ----
    let is_keeper = a.authority.key() == a.config.keeper;
    if !is_keeper {
        // The keeper is gone (no keeper-signed instruction for the grace period, or paused) and
        // the target has exited: anyone may unwind, one slice per slot.
        require!(
            now.saturating_sub(a.config.keeper_heartbeat_ts) > params.keeper_grace_secs && target_now == 0,
            CopierError::SellNotPermitted
        );
        let slot = Clock::get()?.slot;
        require!(slot > a.copier.last_public_sell_slot, CopierError::PublicSellRateLimited);
        a.copier.last_public_sell_slot = slot;
    }
    let proportional = allowed_sell(&p, target_now)?;
    let held_too_long = now.saturating_sub(p.opened_at) > params.max_hold_secs;
    let allowed = if held_too_long { p.tokens } else { proportional };
    require!(tokens_in <= allowed, CopierError::SellNotAllowed);
    let forced = !is_keeper || tokens_in > proportional;

    let vault_seeds: &[&[u8]] = &[VAULT_SEED, mint.as_ref(), &[a.copier.vault_bump]];
    let vault_info = a.vault.to_account_info();
    let trader = Trader {
        actor: &vault_info,
        actor_seeds: vault_seeds,
        token_mint: &a.token_mint,
        actor_tokens: &a.vault_token_account,
        actor_wsol: &a.vault_wsol,
        token_program: &a.token_program,
        quote_token_program: &a.quote_token_program,
        associated_token_program: a.associated_token_program.as_ref(),
        system_program: a.system_program.as_ref(),
        remaining: ctx.remaining_accounts,
    };
    trader.check_accounts(false)?;
    let quote = trader.inspect(&desc, Side::Sell, &ix_data)?;
    guard::check_isolated(&a.instructions, &quote.venue_key)?;
    if !is_keeper {
        // Permissionless slices stay small against the venue.
        require!(
            quote.sell_quote(tokens_in)? <= math::bps_of(quote.real_quote, params.max_impact_bps as u64)?,
            CopierError::ExceedsImpact
        );
    }

    // ---- execute and measure ----
    let total_before = trader.sol_balance();
    let tokens_before = trader.token_balance();
    trader.sell(&desc, ix_data)?;
    let proceeds = trader.sol_balance().checked_sub(total_before).ok_or(CopierError::SlippageSol)?;
    let sold = tokens_before.checked_sub(trader.token_balance()).ok_or(CopierError::SellAmountMismatch)?;
    require!(sold == tokens_in, CopierError::SellAmountMismatch);
    let floor = math::floor_after_slippage(quote.sell_quote(tokens_in)?, params.slippage_bps)?;
    require!(proceeds >= floor.max(min_sol_out), CopierError::SlippageSol);

    // ---- cost basis and position ----
    let cost_removed = math::mul_div_ceil(p.cost, tokens_in, p.tokens)?.min(p.cost);
    p.tokens -= tokens_in;
    p.cost -= cost_removed;
    p.target_snapshot = target_now;
    p.last_trade_ts = now;
    let closing = p.tokens == 0;
    let mut sol_out = proceeds;
    if closing && trader.token_balance() == 0 {
        // The vault's token account rent (booked as cost when it was opened) comes back.
        let before = vault_info.lamports();
        trader.close_token_account()?;
        sol_out += vault_info.lamports() - before;
    }
    let position_rent = if closing { a.position.to_account_info().lamports() } else { 0 };
    sol_out += position_rent;

    // ---- realized PnL, high-water mark and the profit split ----
    let pnl = math::signed_diff(sol_out, cost_removed)?;
    let m = &mut a.copier;
    m.realized_pnl = m.realized_pnl.checked_add(pnl).ok_or(CopierError::MathOverflow)?;
    if m.realized_pnl > m.hwm {
        let excess = (m.realized_pnl - m.hwm) as u64;
        m.hwm = m.realized_pnl;
        let own_index = m.kind == CopierKind::Index && m.mint == a.config.platform_mint;
        let (to_buyback, to_platform) = if own_index {
            (excess, 0)
        } else {
            let to_buyback = math::bps_of(excess, PROFIT_BUYBACK_BPS)?;
            (to_buyback, excess - to_buyback)
        };
        m.buyback_pool = m.buyback_pool.checked_add(to_buyback).ok_or(CopierError::MathOverflow)?;
        m.platform_pending = m.platform_pending.checked_add(to_platform).ok_or(CopierError::MathOverflow)?;
        emit!(ProfitSplit { mint, excess, to_buyback, to_platform, ts: now });
    }
    super::vault::flush_copier_share(
        m,
        &vault_info,
        &a.burn_pool.to_account_info(),
        a.system_program.as_ref(),
    )?;

    m.open_cost = m.open_cost.saturating_sub(cost_removed);
    if closing {
        m.open_positions = m.open_positions.saturating_sub(1);
        m.target_positions[ti] = m.target_positions[ti].saturating_sub(1);
        // Direct lamport move after the last CPI: rent back to the vault, account handed back to
        // the system program.
        a.position.close(vault_info.clone())?;
    } else {
        a.position.set_inner(p);
    }
    m.trades += 1;
    a.config.descriptors_proven |= 1 << descriptor_idx;
    if is_keeper {
        m.last_keeper_ts = now;
        a.config.keeper_heartbeat_ts = now;
    }
    m.accounted_lamports = super::vault_total(&vault_info, &a.vault_wsol);

    emit!(CopierSell {
        mint,
        target: a.target.key(),
        token_mint: a.token_mint.key(),
        venue: quote.venue,
        tokens_in,
        sol_out,
        cost_removed,
        pnl,
        realized_pnl: m.realized_pnl,
        hwm: m.hwm,
        forced,
        ts: now,
    });
    Ok(())
}
