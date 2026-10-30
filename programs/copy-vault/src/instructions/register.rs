//! `register_copier` / `register_index`: bind a freshly launched pump coin to a vault. Runs last in
//! the launch transaction, after pump `create_v2` → pump_fees `create_fee_sharing_config` →
//! `update_fee_shares_v2`, and checks on-chain that the coin's creator fees are routed, immutably,
//! as the product promises (`docs/research/fee-sharing.md` §7).

use anchor_lang::prelude::*;
use anchor_lang::system_program;

use crate::constants::*;
use crate::errors::CopierError;
use crate::events::{IndexTargetsSet, CopierRegistered};
use crate::pump::{self, BondingCurve, SharingConfig};
use crate::state::{Config, Copier, CopierKind};

#[derive(Accounts)]
pub struct RegisterCopier<'info> {
    #[account(mut)]
    pub launcher: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    /// CHECK: Token-2022 mint created by pump `create_v2`; checked in `check_launch`.
    pub mint: UncheckedAccount<'info>,
    /// CHECK: pump `["bonding-curve", mint]`; checked in `check_launch`.
    pub bonding_curve: UncheckedAccount<'info>,
    /// CHECK: pump_fees `["sharing-config", mint]`; checked in `check_launch`.
    pub sharing_config: UncheckedAccount<'info>,
    /// CHECK: the copied wallet (shareholder); must be a system-owned, non-executable account.
    pub target: UncheckedAccount<'info>,
    /// CHECK: system-owned zero-data PDA; checked in `check_launch` and funded to rent here.
    #[account(mut, seeds = [VAULT_SEED, mint.key().as_ref()], bump)]
    pub vault: UncheckedAccount<'info>,
    #[account(init, payer = launcher, space = 8 + Copier::INIT_SPACE, seeds = [COPIER_SEED, mint.key().as_ref()], bump)]
    pub copier: Account<'info, Copier>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RegisterIndex<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ CopierError::NotAdmin)]
    pub config: Account<'info, Config>,
    /// CHECK: Token-2022 mint created by pump `create_v2`; checked in `check_launch`.
    pub mint: UncheckedAccount<'info>,
    /// CHECK: pump `["bonding-curve", mint]`; checked in `check_launch`.
    pub bonding_curve: UncheckedAccount<'info>,
    /// CHECK: pump_fees `["sharing-config", mint]`; checked in `check_launch`.
    pub sharing_config: UncheckedAccount<'info>,
    /// CHECK: system-owned zero-data PDA; checked in `check_launch` and funded to rent here.
    #[account(mut, seeds = [VAULT_SEED, mint.key().as_ref()], bump)]
    pub vault: UncheckedAccount<'info>,
    #[account(init, payer = admin, space = 8 + Copier::INIT_SPACE, seeds = [COPIER_SEED, mint.key().as_ref()], bump)]
    pub copier: Account<'info, Copier>,
    pub system_program: Program<'info, System>,
}

/// Token-2022 extension types that could block or claw back the vault's tokens or burns:
/// TransferFeeConfig, DefaultAccountState, NonTransferable, PermanentDelegate, TransferHook,
/// Pausable.
const UNSAFE_EXTENSIONS: [u16; 6] = [1, 6, 9, 12, 14, 26];

/// The mint must be a Token-2022 mint without mint / freeze authority and without an extension
/// that can block transfers or burns.
fn check_mint(mint: &AccountInfo) -> Result<()> {
    require_keys_eq!(*mint.owner, pump::TOKEN_2022_PROGRAM_ID, CopierError::MintNotToken2022);
    let d = mint.try_borrow_data()?;
    require!(d.len() >= 82 && d[45] == 1, CopierError::MintNotToken2022);
    // COption tags of mint_authority (0..4) and freeze_authority (46..50).
    require!(d[0..4] == [0; 4] && d[46..50] == [0; 4], CopierError::MintUnsafe);
    if d.len() > 165 {
        require!(d[165] == 1, CopierError::MintNotToken2022);
        let mut at = 166;
        while at + 4 <= d.len() {
            let ty = u16::from_le_bytes([d[at], d[at + 1]]);
            let len = u16::from_le_bytes([d[at + 2], d[at + 3]]) as usize;
            if ty == 0 {
                break;
            }
            require!(!UNSAFE_EXTENSIONS.contains(&ty), CopierError::MintUnsafe);
            at += 4 + len;
        }
    }
    Ok(())
}

/// Everything both registrations check: the sharing config (canonical, v2, active, admin revoked,
/// exactly `expected` shareholders), the bonding curve (canonical, creator == sharing config, not
/// complete, not mayhem / cashback / holder-reward, SOL-quoted), the mint and the vault PDA.
fn check_launch(
    mint: &AccountInfo,
    bonding_curve: &AccountInfo,
    sharing_config: &AccountInfo,
    vault: &AccountInfo,
    expected: &[(Pubkey, u16)],
) -> Result<()> {
    require_keys_eq!(
        sharing_config.key(),
        pump::sharing_config_pda(mint.key),
        CopierError::SharingConfigMismatch
    );
    let sc = SharingConfig::load(sharing_config)?;
    require!(sc.version == 2, CopierError::SharingConfigVersion);
    require!(sc.status == 1, CopierError::SharingConfigNotActive);
    require_keys_eq!(sc.mint, mint.key(), CopierError::SharingConfigMismatch);
    require!(sc.admin_revoked, CopierError::SharingConfigAdminNotRevoked);
    require!(sc.shareholders.len() == expected.len(), CopierError::ShareholdersMismatch);
    // Every expected (address, bps) exactly once, in any order.
    for e in expected {
        require!(
            sc.shareholders.iter().filter(|s| *s == e).count() == 1,
            CopierError::ShareholdersMismatch
        );
    }

    require_keys_eq!(
        bonding_curve.key(),
        pump::bonding_curve_pda(mint.key),
        CopierError::BondingCurveMismatch
    );
    let bc = BondingCurve::load(bonding_curve)?;
    require!(bonding_curve.data_len() >= 125, CopierError::BondingCurveInvalid);
    require_keys_eq!(bc.creator, sharing_config.key(), CopierError::CreatorNotSharingConfig);
    require!(!bc.complete, CopierError::CurveComplete);
    require!(!bc.is_mayhem_mode, CopierError::MayhemCoin);
    require!(!bc.is_cashback_coin, CopierError::CashbackCoin);
    require!(!bc.is_holder_reward, CopierError::HolderRewardCoin);
    require_keys_eq!(bc.quote_mint, Pubkey::default(), CopierError::NotSolQuoted);

    check_mint(mint)?;

    require!(
        *vault.owner == system_program::ID && vault.data_len() == 0,
        CopierError::VaultInvalid
    );
    Ok(())
}

/// Tops the vault up to the zero-data rent minimum from `payer`.
fn fund_vault<'info>(
    payer: &AccountInfo<'info>,
    vault: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
) -> Result<()> {
    let rent = super::zero_rent()?;
    let have = vault.lamports();
    if have < rent {
        system_program::transfer(
            CpiContext::new(
                system_program.clone(),
                system_program::Transfer { from: payer.clone(), to: vault.clone() },
            ),
            rent - have,
        )?;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn init_copier(
    copier: &mut Copier,
    mint: Pubkey,
    launcher: Pubkey,
    kind: CopierKind,
    targets: Vec<Pubkey>,
    trader_bps: u16,
    vault_bump: u8,
    bump: u8,
    sharing_config: Pubkey,
    vault: &AccountInfo,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let rent = super::zero_rent()?;
    copier.mint = mint;
    copier.launcher = launcher;
    copier.kind = kind;
    copier.targets = targets;
    copier.trader_bps = trader_bps;
    copier.verified = 0;
    copier.vault_bump = vault_bump;
    copier.bump = bump;
    copier.created_at = now;
    copier.sharing_config = sharing_config;
    copier.last_keeper_ts = now;
    copier.graduated_pool = Pubkey::default();
    copier.target_positions = [0; 16];
    // The vault's rent is neither capital nor fees; anything already above it is fee income.
    copier.fees_in = vault.lamports().saturating_sub(rent);
    copier.accounted_lamports = vault.lamports();
    emit!(CopierRegistered {
        mint,
        launcher,
        kind,
        targets: copier.targets.clone(),
        trader_bps,
        sharing_config,
        ts: now,
    });
    Ok(())
}

pub fn register_copier(ctx: Context<RegisterCopier>, trader_bps: u16) -> Result<()> {
    require!(
        (TRADER_MIN_BPS..=TRADER_MAX_BPS).contains(&trader_bps),
        CopierError::TraderBpsOutOfRange
    );
    let a = &ctx.accounts;
    let target = a.target.key();
    require!(
        *a.target.owner == system_program::ID && !a.target.executable && target != a.vault.key(),
        CopierError::TargetInvalid
    );
    check_launch(
        &a.mint,
        &a.bonding_curve,
        &a.sharing_config,
        &a.vault,
        &[(target, trader_bps), (a.vault.key(), BPS as u16 - trader_bps)],
    )?;
    fund_vault(&a.launcher, &a.vault, &a.system_program)?;
    init_copier(
        &mut ctx.accounts.copier,
        ctx.accounts.mint.key(),
        ctx.accounts.launcher.key(),
        CopierKind::Single,
        vec![target],
        trader_bps,
        ctx.bumps.vault,
        ctx.bumps.copier,
        ctx.accounts.sharing_config.key(),
        &ctx.accounts.vault,
    )
}

fn validate_targets(targets: &[Pubkey], vault: &Pubkey) -> Result<()> {
    require!(
        !targets.is_empty()
            && targets.len() <= MAX_INDEX_TARGETS
            && targets.iter().all(|t| *t != Pubkey::default() && t != vault)
            && targets.iter().enumerate().all(|(i, t)| !targets[..i].contains(t)),
        CopierError::InvalidTargets
    );
    Ok(())
}

pub fn register_index(ctx: Context<RegisterIndex>, targets: Vec<Pubkey>) -> Result<()> {
    let a = &ctx.accounts;
    validate_targets(&targets, a.vault.key)?;
    check_launch(&a.mint, &a.bonding_curve, &a.sharing_config, &a.vault, &[(a.vault.key(), BPS as u16)])?;
    fund_vault(&a.admin, &a.vault, &a.system_program)?;
    init_copier(
        &mut ctx.accounts.copier,
        ctx.accounts.mint.key(),
        ctx.accounts.admin.key(),
        CopierKind::Index,
        targets,
        0,
        ctx.bumps.vault,
        ctx.bumps.copier,
        ctx.accounts.sharing_config.key(),
        &ctx.accounts.vault,
    )
}

/// Index copier `copier` may take `targets`: Index kind, 1–16 distinct targets, not the vault.
pub fn check_index_targets(copier: &Copier, targets: &[Pubkey]) -> Result<()> {
    require!(copier.kind == CopierKind::Index, CopierError::NotIndex);
    let vault = Pubkey::create_program_address(
        &[VAULT_SEED, copier.mint.as_ref(), &[copier.vault_bump]],
        &crate::ID,
    )
    .map_err(|_| error!(CopierError::VaultInvalid))?;
    validate_targets(targets, &vault)
}

/// Replaces an Index copier's targets (executed `IndexTargets` change). Verification bits and
/// open-position counters follow their target; a target with open positions cannot be dropped.
pub fn apply_index_targets(copier: &mut Copier, targets: Vec<Pubkey>) -> Result<()> {
    check_index_targets(copier, &targets)?;
    let mut positions = [0u8; 16];
    let mut verified = 0u16;
    for (i, old) in copier.targets.iter().enumerate() {
        match targets.iter().position(|t| t == old) {
            Some(j) => {
                positions[j] = copier.target_positions[i];
                if copier.verified & (1 << i) != 0 {
                    verified |= 1 << j;
                }
            }
            None => require!(copier.target_positions[i] == 0, CopierError::TargetHasOpenPositions),
        }
    }
    copier.targets = targets;
    copier.target_positions = positions;
    copier.verified = verified;
    emit!(IndexTargetsSet { mint: copier.mint, targets: copier.targets.clone() });
    Ok(())
}
