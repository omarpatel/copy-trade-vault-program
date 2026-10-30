#![allow(unexpected_cfgs)]
//! Test fixture: forwards its own instruction data and accounts to `accounts[0]` (the target
//! program) via CPI, keeping every account's signer / writable flags. The copy-vault suite uses it to
//! show that trades and burns refuse to run as a CPI (`NotTopLevel`): a calling program could
//! otherwise trade the venue before and after copy-vault inside one instruction.

use solana_program::account_info::AccountInfo;
use solana_program::entrypoint::ProgramResult;
use solana_program::instruction::{AccountMeta, Instruction};
use solana_program::program::invoke;
use solana_program::program_error::ProgramError;
use solana_program::pubkey::Pubkey;

#[cfg(not(feature = "no-entrypoint"))]
solana_program::entrypoint!(process_instruction);

pub fn process_instruction(_program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let (target, rest) = accounts.split_first().ok_or(ProgramError::NotEnoughAccountKeys)?;
    let metas = rest
        .iter()
        .map(|a| AccountMeta { pubkey: *a.key, is_signer: a.is_signer, is_writable: a.is_writable })
        .collect();
    invoke(&Instruction { program_id: *target.key, accounts: metas, data: data.to_vec() }, accounts)
}
