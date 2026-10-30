//! Same-transaction isolation for the instructions that price against venue reserves
//! (`copier_buy`, `copier_sell`, `buyback_burn`, `burn_platform`).
//!
//! Their price guards (fee-free quote floor, impact cap, signal value) read the curve / pool as it
//! is when the copy-vault instruction runs. Anything earlier in the same transaction could have moved
//! it, so the transaction may contain nothing but the copy-vault instruction itself, compute-budget
//! instructions, SPL Memo, ATA `create_idempotent` and System `transfer` (Jito tip), and none of
//! those may list the venue account. The copy-vault instruction must be top-level (not a CPI, whose
//! caller could trade the venue around it).

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{get_stack_height, TRANSACTION_LEVEL_STACK_HEIGHT};
use anchor_lang::solana_program::pubkey;
use anchor_lang::solana_program::sysvar::instructions::{load_current_index_checked, load_instruction_at_checked};
use anchor_lang::system_program;
use anchor_spl::associated_token;

use crate::errors::CopierError;

pub const COMPUTE_BUDGET_PROGRAM_ID: Pubkey = pubkey!("ComputeBudget111111111111111111111111111111");
pub const MEMO_PROGRAM_ID: Pubkey = pubkey!("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
pub const MEMO_V1_PROGRAM_ID: Pubkey = pubkey!("Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo");

/// ATA program `CreateIdempotent`.
const ATA_CREATE_IDEMPOTENT: [u8; 1] = [1];
/// System program `Transfer` (u32 LE variant index 2).
const SYSTEM_TRANSFER: [u8; 4] = [2, 0, 0, 0];

/// Rejects the transaction unless every other instruction is one of the allowed kinds and none of
/// them lists `venue` (the curve or pool this instruction trades).
pub fn check_isolated(instructions_sysvar: &AccountInfo, venue: &Pubkey) -> Result<()> {
    require!(get_stack_height() == TRANSACTION_LEVEL_STACK_HEIGHT, CopierError::NotTopLevel);
    let current = load_current_index_checked(instructions_sysvar)? as usize;
    let count = {
        let data = instructions_sysvar.try_borrow_data()?;
        u16::from_le_bytes([data[0], data[1]]) as usize
    };
    for i in (0..count).filter(|i| *i != current) {
        let ix = load_instruction_at_checked(i, instructions_sysvar)?;
        let allowed = if ix.program_id == COMPUTE_BUDGET_PROGRAM_ID
            || ix.program_id == MEMO_PROGRAM_ID
            || ix.program_id == MEMO_V1_PROGRAM_ID
        {
            true
        } else if ix.program_id == associated_token::ID {
            ix.data == ATA_CREATE_IDEMPOTENT
        } else if ix.program_id == system_program::ID {
            ix.data.len() == 12 && ix.data[..4] == SYSTEM_TRANSFER
        } else {
            false
        };
        require!(
            allowed && ix.accounts.iter().all(|m| m.pubkey != *venue),
            CopierError::VenueTouchedInTx
        );
    }
    Ok(())
}
