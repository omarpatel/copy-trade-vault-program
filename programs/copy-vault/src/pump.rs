//! Minimal hand-written views of the pump.fun bonding curve, the PumpSwap pool and the pump_fees
//! sharing config, their PDAs and the discriminators copy-vault's config may never whitelist.
//! Layouts: `docs/research/pump-integration.md` §4 and `docs/research/fee-sharing.md` §1. Only the
//! fields copy-vault uses are decoded, by offset, so fields pump appends later break nothing; fields a
//! short (older) account lacks read as zero / false / default, as pump itself reads them.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::pubkey;
use anchor_spl::token::spl_token;

use crate::errors::CopierError;

pub const PUMP_PROGRAM_ID: Pubkey = pubkey!("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
pub const PUMP_AMM_PROGRAM_ID: Pubkey = pubkey!("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
pub const PUMP_FEES_PROGRAM_ID: Pubkey = pubkey!("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ");
pub const WSOL_MINT: Pubkey = spl_token::native_mint::ID;
pub const TOKEN_2022_PROGRAM_ID: Pubkey = anchor_spl::token_2022::ID;

pub const BONDING_CURVE_DISC: [u8; 8] = [0x17, 0xb7, 0xf8, 0x37, 0x60, 0xd8, 0xac, 0x60];
pub const POOL_DISC: [u8; 8] = [0xf1, 0x9a, 0x6d, 0x04, 0x11, 0xb1, 0x6d, 0xbc];
pub const SHARING_CONFIG_DISC: [u8; 8] = [0xd8, 0x4a, 0x09, 0x00, 0x38, 0x8c, 0x5d, 0x4b];

// ---------------- trade discriminators (seeded descriptors) ----------------

pub const IX_BUY_V3: [u8; 8] = [7, 5, 29, 196, 245, 23, 101, 80];
pub const IX_SELL_V3: [u8; 8] = [28, 146, 222, 119, 38, 196, 105, 213];
pub const IX_BUY_EXACT_QUOTE_IN_V3: [u8; 8] = [225, 247, 80, 30, 213, 179, 132, 136];
/// Same name, hence same discriminator, on pump and pump_amm (`buy_v2` / `sell_v2` /
/// `buy_exact_quote_in_v2`, `buy` / `sell`): descriptors are keyed on (program, disc).
pub const IX_BUY_V2: [u8; 8] = [184, 23, 238, 97, 103, 197, 211, 61];
pub const IX_SELL_V2: [u8; 8] = [93, 246, 130, 60, 231, 233, 64, 178];
pub const IX_BUY_EXACT_QUOTE_IN_V2: [u8; 8] = [194, 171, 28, 70, 104, 77, 91, 47];
pub const IX_AMM_BUY_EXACT_QUOTE_IN: [u8; 8] = [198, 46, 21, 82, 180, 217, 232, 112];
pub const IX_AMM_SELL: [u8; 8] = [51, 230, 133, 164, 1, 127, 131, 173];

/// Every non-trade instruction of pump and pump_amm (crate IDLs of pump-rust-client 0.2.0) plus
/// the Anchor IDL instruction and event-CPI tag. With the vault signing, any of these could spend
/// vault SOL or move vault assets (create*, extend*, volume accumulators, migrate*, deposit,
/// withdraw, create_pool, sweeps, claims and every admin instruction), so no descriptor may name
/// one, whatever the admin sets.
pub const FORBIDDEN_DISCRIMINATORS: [[u8; 8]; 64] = [
    [2, 14, 61, 138, 170, 142, 14, 95], // add_quote_control_mint
    [111, 121, 21, 56, 40, 24, 94, 209], // add_quote_mint
    [125, 126, 214, 134, 77, 229, 188, 89], // admin_cto
    [8, 217, 96, 231, 144, 104, 192, 5], // admin_set_idl_authority
    [209, 11, 115, 87, 213, 23, 124, 204], // admin_update_token_incentives
    [37, 58, 35, 126, 190, 53, 228, 197], // claim_cashback
    [122, 243, 204, 65, 94, 116, 29, 55], // claim_cashback_v2
    [16, 4, 71, 28, 204, 1, 40, 27], // claim_token_incentives
    [249, 69, 164, 218, 150, 103, 84, 138], // close_user_volume_accumulator
    [20, 22, 86, 123, 198, 28, 219, 132], // collect_creator_fee
    [207, 17, 138, 242, 4, 34, 19, 56], // collect_creator_fee_v2
    [24, 30, 200, 40, 5, 28, 7, 119], // create
    [214, 144, 76, 236, 95, 139, 49, 180], // create_v2
    [165, 114, 103, 0, 121, 206, 247, 81], // distribute_creator_fees
    [255, 203, 19, 79, 244, 68, 8, 159], // distribute_creator_fees_v2
    [98, 54, 145, 97, 2, 70, 173, 43], // distribute_fee_to_holders
    [234, 102, 194, 203, 150, 72, 62, 229], // extend_account
    [117, 225, 127, 202, 134, 95, 68, 35], // get_minimum_distributable_fee
    [94, 6, 202, 115, 255, 96, 232, 183], // init_user_volume_accumulator
    [175, 175, 109, 31, 13, 152, 155, 237], // initialize
    [239, 73, 245, 173, 209, 177, 84, 66], // initialize_quote_control
    [155, 234, 231, 146, 236, 158, 162, 30], // migrate
    [87, 124, 52, 191, 52, 38, 214, 232], // migrate_bonding_curve_creator
    [187, 203, 18, 31, 206, 237, 254, 41], // migrate_v2
    [223, 7, 253, 26, 81, 165, 218, 166], // remove_quote_control_mint
    [177, 65, 223, 38, 88, 209, 158, 155], // remove_quote_mint
    [254, 148, 255, 112, 207, 142, 170, 165], // set_creator
    [61, 169, 188, 191, 153, 149, 42, 97], // set_mayhem_virtual_params
    [138, 96, 174, 217, 48, 85, 197, 246], // set_metaplex_creator
    [27, 234, 178, 52, 147, 2, 187, 141], // set_params
    [62, 79, 161, 211, 165, 170, 214, 210], // set_quote_control_admin
    [116, 220, 107, 83, 191, 44, 32, 73], // set_quote_control_mint_reserves
    [161, 195, 222, 165, 225, 101, 192, 62], // set_quote_control_reserves_admin
    [111, 172, 162, 232, 114, 89, 213, 142], // set_reserved_fee_recipients
    [101, 135, 191, 104, 9, 88, 20, 96], // set_virtual_quote_reserves
    [32, 246, 191, 52, 8, 201, 73, 186], // sweep_creator_fee
    [8, 48, 190, 7, 182, 68, 183, 229], // sweep_protocol_fee
    [86, 31, 192, 87, 163, 87, 79, 238], // sync_user_volume_accumulator
    [115, 103, 224, 255, 189, 89, 86, 195], // toggle_cashback_enabled
    [28, 255, 230, 240, 172, 107, 203, 171], // toggle_create_v2
    [1, 9, 111, 208, 100, 31, 255, 163], // toggle_mayhem_mode
    [251, 224, 171, 146, 160, 26, 113, 233], // update_buyback_config
    [61, 175, 160, 249, 66, 66, 136, 175], // update_creator_fee_config
    [227, 181, 74, 196, 208, 21, 97, 213], // update_global_authority
    [225, 252, 66, 4, 199, 35, 236, 16], // update_holder_reward_config
    [45, 61, 165, 151, 104, 0, 49, 189], // admin_cto_pool
    [105, 68, 6, 175, 0, 7, 35, 162], // boost_buy_and_burn
    [160, 57, 89, 42, 181, 139, 43, 66], // collect_coin_creator_fee
    [201, 207, 243, 114, 75, 111, 47, 189], // create_config
    [233, 146, 209, 142, 207, 104, 64, 188], // create_pool
    [242, 35, 198, 137, 82, 225, 242, 182], // deposit
    [185, 173, 187, 90, 216, 15, 238, 233], // disable
    [140, 233, 33, 94, 132, 90, 194, 143], // init_boost
    [208, 8, 159, 4, 74, 175, 16, 58], // migrate_pool_coin_creator
    [227, 149, 76, 42, 130, 39, 234, 205], // set_boost_authority
    [210, 149, 128, 45, 188, 58, 78, 175], // set_coin_creator
    [117, 161, 160, 74, 223, 137, 118, 99], // toggle_boost
    [139, 52, 134, 85, 228, 229, 108, 241], // transfer_creator_fees_to_pump
    [1, 33, 78, 185, 33, 67, 44, 92], // transfer_creator_fees_to_pump_v2
    [161, 176, 40, 213, 60, 184, 179, 228], // update_admin
    [104, 184, 103, 242, 88, 151, 107, 20], // update_fee_config
    [183, 18, 70, 156, 148, 109, 161, 34], // withdraw
    [64, 244, 188, 120, 167, 233, 105, 10], // anchor idl instruction
    [228, 69, 165, 46, 81, 203, 154, 29], // anchor event-cpi tag
];

// ---------------- PDAs ----------------

pub fn bonding_curve_pda(mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"bonding-curve", mint.as_ref()], &PUMP_PROGRAM_ID).0
}

pub fn sharing_config_pda(mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"sharing-config", mint.as_ref()], &PUMP_FEES_PROGRAM_ID).0
}

pub fn pool_authority_pda(mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"pool-authority", mint.as_ref()], &PUMP_PROGRAM_ID).0
}

/// The canonical PumpSwap pool pump.fun migrates a graduated curve into (index 0, created by the
/// curve's pool authority, quoted in wSOL).
pub fn canonical_pool_pda(mint: &Pubkey) -> Pubkey {
    let authority = pool_authority_pda(mint);
    Pubkey::find_program_address(
        &[b"pool", &0u16.to_le_bytes(), authority.as_ref(), mint.as_ref(), WSOL_MINT.as_ref()],
        &PUMP_AMM_PROGRAM_ID,
    )
    .0
}

// ---------------- account views ----------------

fn u64_at(d: &[u8], at: usize) -> u64 {
    d.get(at..at + 8).map_or(0, |b| u64::from_le_bytes(b.try_into().unwrap()))
}
fn bool_at(d: &[u8], at: usize) -> bool {
    d.get(at).is_some_and(|b| *b != 0)
}
fn key_at(d: &[u8], at: usize) -> Pubkey {
    d.get(at..at + 32).map_or(Pubkey::default(), |b| Pubkey::new_from_array(b.try_into().unwrap()))
}

/// pump.fun `BondingCurve` (live accounts are 151 bytes; older ones shorter).
pub struct BondingCurve {
    pub virtual_token_reserves: u64,
    pub virtual_quote_reserves: u64,
    pub real_token_reserves: u64,
    pub real_quote_reserves: u64,
    pub complete: bool,
    pub creator: Pubkey,
    pub is_mayhem_mode: bool,
    pub is_cashback_coin: bool,
    /// `Pubkey::default()` for SOL-quoted curves.
    pub quote_mint: Pubkey,
    pub is_holder_reward: bool,
}

impl BondingCurve {
    pub fn load(info: &AccountInfo) -> Result<Self> {
        require_keys_eq!(*info.owner, PUMP_PROGRAM_ID, CopierError::BondingCurveInvalid);
        let d = info.try_borrow_data()?;
        require!(d.len() >= 81 && d[..8] == BONDING_CURVE_DISC, CopierError::BondingCurveInvalid);
        Ok(Self {
            virtual_token_reserves: u64_at(&d, 8),
            virtual_quote_reserves: u64_at(&d, 16),
            real_token_reserves: u64_at(&d, 24),
            real_quote_reserves: u64_at(&d, 32),
            complete: bool_at(&d, 48),
            creator: key_at(&d, 49),
            is_mayhem_mode: bool_at(&d, 81),
            is_cashback_coin: bool_at(&d, 82),
            quote_mint: key_at(&d, 83),
            is_holder_reward: bool_at(&d, 124),
        })
    }

    pub fn is_sol_quoted(&self) -> bool {
        self.quote_mint == Pubkey::default() || self.quote_mint == WSOL_MINT
    }
}

/// PumpSwap `Pool` (live accounts are 300 bytes).
pub struct Pool {
    pub base_mint: Pubkey,
    pub quote_mint: Pubkey,
    pub pool_base_token_account: Pubkey,
    pub pool_quote_token_account: Pubkey,
    pub coin_creator: Pubkey,
    pub is_mayhem_mode: bool,
    /// Signed since Sept 30 2026; PumpSwap prices on the quote balance plus this.
    pub virtual_quote_reserves: i128,
}

const POOL_VIRTUAL_QUOTE_AT: usize = 245;

impl Pool {
    pub fn load(info: &AccountInfo) -> Result<Self> {
        require_keys_eq!(*info.owner, PUMP_AMM_PROGRAM_ID, CopierError::VenueInvalid);
        let d = info.try_borrow_data()?;
        require!(d.len() >= 243 && d[..8] == POOL_DISC, CopierError::VenueInvalid);
        Ok(Self {
            base_mint: key_at(&d, 43),
            quote_mint: key_at(&d, 75),
            pool_base_token_account: key_at(&d, 139),
            pool_quote_token_account: key_at(&d, 171),
            coin_creator: key_at(&d, 211),
            is_mayhem_mode: bool_at(&d, 243),
            virtual_quote_reserves: d
                .get(POOL_VIRTUAL_QUOTE_AT..POOL_VIRTUAL_QUOTE_AT + 16)
                .map_or(0, |b| i128::from_le_bytes(b.try_into().unwrap())),
        })
    }
}

/// pump_fees `SharingConfig` (fixed 1024-byte allocation).
pub struct SharingConfig {
    pub version: u8,
    pub status: u8,
    pub mint: Pubkey,
    pub admin_revoked: bool,
    pub shareholders: Vec<(Pubkey, u16)>,
}

impl SharingConfig {
    pub fn load(info: &AccountInfo) -> Result<Self> {
        require_keys_eq!(*info.owner, PUMP_FEES_PROGRAM_ID, CopierError::SharingConfigInvalid);
        let d = info.try_borrow_data()?;
        require!(d.len() >= 80 && d[..8] == SHARING_CONFIG_DISC, CopierError::SharingConfigInvalid);
        let n = u32::from_le_bytes(d[76..80].try_into().unwrap()) as usize;
        require!(n <= 10 && d.len() >= 80 + 34 * n, CopierError::SharingConfigInvalid);
        let shareholders = (0..n)
            .map(|i| {
                let at = 80 + 34 * i;
                (key_at(&d, at), u16::from_le_bytes(d[at + 32..at + 34].try_into().unwrap()))
            })
            .collect();
        Ok(Self {
            version: d[9],
            status: d[10],
            mint: key_at(&d, 11),
            admin_revoked: d[75] != 0,
            shareholders,
        })
    }
}

// ---------------- token accounts ----------------

pub fn is_token_program(key: &Pubkey) -> bool {
    *key == spl_token::ID || *key == TOKEN_2022_PROGRAM_ID
}

/// An initialised SPL Token / Token-2022 token account (base layout: mint, owner, amount).
pub fn is_token_account(info: &AccountInfo) -> bool {
    is_token_program(info.owner) && info.data_len() >= 165 && {
        let d = info.data.borrow();
        // Token-2022 accounts with extensions carry AccountType::Account (2) at 165.
        d.len() == 165 || d[165] == 2
    }
}

/// (mint, owner, amount) of a token account.
pub fn token_account_fields(info: &AccountInfo) -> Option<(Pubkey, Pubkey, u64)> {
    if !is_token_account(info) {
        return None;
    }
    let d = info.data.borrow();
    Some((key_at(&d, 0), key_at(&d, 32), u64_at(&d, 64)))
}

/// Lamports held at a PDA's canonical wSOL ATA address, all of which return to the PDA when the
/// account is closed after a pool trade:
/// - an initialised wSOL account: its rent plus the wrapped amount;
/// - a not-yet-created address someone sent lamports to (system-owned, no data): the ATA program
///   adopts those lamports when it creates the account and SPL Token wraps them.
///
/// Callers pass only the canonical address (checked), which nobody but the ATA program can
/// allocate.
pub fn wsol_address_lamports(info: &AccountInfo) -> u64 {
    if is_token_account(info) || (*info.owner == anchor_lang::system_program::ID && info.data_len() == 0) {
        info.lamports()
    } else {
        0
    }
}

/// Balance of a token account, 0 if the address holds no initialised token account (an ATA that
/// was never created or was closed).
pub fn token_balance(info: &AccountInfo) -> u64 {
    token_account_fields(info).map_or(0, |(_, _, amount)| amount)
}
