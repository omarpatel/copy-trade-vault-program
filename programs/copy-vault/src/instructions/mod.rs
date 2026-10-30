pub mod admin;
pub mod burn;
pub mod register;
pub mod trade;
pub mod vault;

pub use admin::*;
pub use burn::*;
pub use register::*;
pub use trade::*;
pub use vault::*;

use anchor_lang::prelude::*;
use anchor_spl::associated_token::get_associated_token_address;

use crate::errors::CopierError;
use crate::events::FeesSynced;
use crate::pump;
use crate::state::Copier;

/// Rent-exempt minimum of a zero-data account (the vault and the burn pool never go below it).
pub fn zero_rent() -> Result<u64> {
    Ok(Rent::get()?.minimum_balance(0))
}

/// Vault lamports plus the lamports at its canonical wSOL address (an open wSOL account's rent and
/// wrapped amount, or lamports someone sent to the not-yet-created address): all of it reaches the
/// vault when a pool trade closes the account.
pub fn vault_total(vault: &AccountInfo, vault_wsol: &AccountInfo) -> u64 {
    vault.lamports().saturating_add(pump::wsol_address_lamports(vault_wsol))
}

/// `vault_wsol` must be the vault's canonical wSOL ATA (it may not exist).
pub fn check_vault_wsol(vault: &Pubkey, vault_wsol: &AccountInfo) -> Result<()> {
    require_keys_eq!(
        vault_wsol.key(),
        get_associated_token_address(vault, &pump::WSOL_MINT),
        CopierError::TokenAccountMismatch
    );
    Ok(())
}

/// Books every lamport (and wrapped lamport) on the vault the program did not move itself as fee
/// income. Runs first in every instruction that touches the vault.
pub fn sync_vault(copier: &mut Copier, vault: &AccountInfo, vault_wsol: &AccountInfo) -> Result<u64> {
    check_vault_wsol(vault.key, vault_wsol)?;
    let total = vault_total(vault, vault_wsol);
    require!(total >= copier.accounted_lamports, CopierError::AccountingBroken);
    let fees = total - copier.accounted_lamports;
    if fees > 0 {
        copier.fees_in = copier.fees_in.checked_add(fees).ok_or(CopierError::MathOverflow)?;
        copier.accounted_lamports = total;
        emit!(FeesSynced {
            mint: copier.mint,
            lamports: fees,
            total: copier.fees_in,
            ts: Clock::get()?.unix_timestamp,
        });
    }
    Ok(fees)
}
