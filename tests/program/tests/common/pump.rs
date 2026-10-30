//! pump.fun / PumpSwap / pump_fees side of the harness: PDAs, the instructions copy-vault's launch,
//! fee crank and trades use (account lists from the pump-rust-client 0.2.0 IDLs), and public
//! traders that hit the venues directly (targets, whales).

use anchor_lang::system_program;
use anchor_spl::associated_token::spl_associated_token_account::instruction::create_associated_token_account_idempotent;
use anchor_spl::token::spl_token;
use solana_sdk::instruction::{AccountMeta, Instruction};
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::{Keypair, Signer};
use solana_sdk::sysvar;

use super::*;

pub const PUMP: Pubkey = copy_vault::pump::PUMP_PROGRAM_ID;
pub const PUMP_AMM: Pubkey = copy_vault::pump::PUMP_AMM_PROGRAM_ID;
pub const PUMP_FEES: Pubkey = copy_vault::pump::PUMP_FEES_PROGRAM_ID;
pub const MAYHEM: Pubkey = solana_sdk::pubkey!("MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e");
pub const WSOL: Pubkey = copy_vault::pump::WSOL_MINT;

/// Total supply of every pump coin (6 decimals).
pub const COIN_SUPPLY: u64 = 1_000_000_000_000_000;

// ---------------- PDAs ----------------

pub fn pump_global() -> Pubkey {
    pda(&[b"global"], &PUMP)
}
pub fn pump_event_authority() -> Pubkey {
    pda(&[b"__event_authority"], &PUMP)
}
pub fn amm_event_authority() -> Pubkey {
    pda(&[b"__event_authority"], &PUMP_AMM)
}
pub fn fees_event_authority() -> Pubkey {
    pda(&[b"__event_authority"], &PUMP_FEES)
}
pub fn mint_authority() -> Pubkey {
    pda(&[b"mint-authority"], &PUMP)
}
pub fn bonding_curve_pda(mint: &Pubkey) -> Pubkey {
    copy_vault::pump::bonding_curve_pda(mint)
}
pub fn sharing_config_pda(mint: &Pubkey) -> Pubkey {
    copy_vault::pump::sharing_config_pda(mint)
}
pub fn creator_vault(creator: &Pubkey) -> Pubkey {
    pda(&[b"creator-vault", creator.as_ref()], &PUMP)
}
pub fn amm_creator_vault_authority(coin_creator: &Pubkey) -> Pubkey {
    pda(&[b"creator_vault", coin_creator.as_ref()], &PUMP_AMM)
}
pub fn pump_uva(user: &Pubkey) -> Pubkey {
    pda(&[b"user_volume_accumulator", user.as_ref()], &PUMP)
}
pub fn amm_uva(user: &Pubkey) -> Pubkey {
    pda(&[b"user_volume_accumulator", user.as_ref()], &PUMP_AMM)
}
pub fn fee_config(program: &Pubkey) -> Pubkey {
    pda(&[b"fee_config", program.as_ref()], &PUMP_FEES)
}
pub fn amm_global_config() -> Pubkey {
    pda(&[b"global_config"], &PUMP_AMM)
}
pub fn pool_authority(mint: &Pubkey) -> Pubkey {
    copy_vault::pump::pool_authority_pda(mint)
}
pub fn canonical_pool(mint: &Pubkey) -> Pubkey {
    copy_vault::pump::canonical_pool_pda(mint)
}
pub fn lp_mint(pool: &Pubkey) -> Pubkey {
    pda(&[b"pool_lp_mint", pool.as_ref()], &PUMP_AMM)
}
pub fn boost_vault_authority(pool: &Pubkey) -> Pubkey {
    pda(&[b"boost_vault", pool.as_ref()], &PUMP_AMM)
}
pub fn mayhem_global_params() -> Pubkey {
    pda(&[b"global-params"], &MAYHEM)
}
pub fn mayhem_sol_vault() -> Pubkey {
    pda(&[b"sol-vault"], &MAYHEM)
}
pub fn mayhem_state(mint: &Pubkey) -> Pubkey {
    pda(&[b"mayhem-state", mint.as_ref()], &MAYHEM)
}

fn put_str(out: &mut Vec<u8>, s: &str) {
    out.extend_from_slice(&(s.len() as u32).to_le_bytes());
    out.extend_from_slice(s.as_bytes());
}

fn with_disc(disc: [u8; 8]) -> Vec<u8> {
    disc.to_vec()
}

// ---------------- launch ----------------

/// pump `create_v2(name, symbol, uri, creator, mayhem, cashback=[false], creator_fee_bps=[0],
/// holder_reward=[false])`; `user` pays, the mint keypair signs.
pub fn create_v2_ix(mint: &Pubkey, user: &Pubkey, creator: &Pubkey, mayhem: bool) -> Instruction {
    let curve = bonding_curve_pda(mint);
    let mut data = with_disc([214, 144, 76, 236, 95, 139, 49, 180]);
    put_str(&mut data, "Copier Test");
    put_str(&mut data, "COPY");
    put_str(&mut data, "https://ipfs.io/ipfs/bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku");
    data.extend_from_slice(creator.as_ref());
    data.push(mayhem as u8);
    data.push(0); // is_cashback_enabled: OptionBool(false)
    data.extend_from_slice(&0u64.to_le_bytes()); // creator_fee_bps: OptionU64(0)
    data.push(0); // is_holder_reward: OptionBool(false)
    Instruction {
        program_id: PUMP,
        accounts: vec![
            AccountMeta::new(*mint, true),
            meta_r(mint_authority()),
            meta_w(curve),
            meta_w(ata22(&curve, mint)),
            meta_r(pump_global()),
            AccountMeta::new(*user, true),
            meta_r(system_program::ID),
            meta_r(TOKEN_2022_ID),
            meta_r(ATA_ID),
            meta_w(MAYHEM),
            meta_r(mayhem_global_params()),
            meta_w(mayhem_sol_vault()),
            meta_w(mayhem_state(mint)),
            meta_w(ata22(&mayhem_sol_vault(), mint)),
            meta_r(pump_event_authority()),
            meta_r(PUMP),
        ],
        data,
    }
}

/// pump_fees `create_fee_sharing_config` for a coin still on its curve (pool accounts None: the
/// program id stands in for an absent optional account).
pub fn create_fee_sharing_config_ix(payer: &Pubkey, mint: &Pubkey) -> Instruction {
    Instruction {
        program_id: PUMP_FEES,
        accounts: vec![
            meta_r(fees_event_authority()),
            meta_r(PUMP_FEES),
            AccountMeta::new(*payer, true),
            meta_r(pump_global()),
            meta_r(*mint),
            meta_w(sharing_config_pda(mint)),
            meta_r(system_program::ID),
            meta_w(bonding_curve_pda(mint)),
            meta_r(PUMP),
            meta_r(pump_event_authority()),
            meta_r(PUMP_FEES),
            meta_r(PUMP_FEES),
            meta_r(PUMP_FEES),
        ],
        data: with_disc([195, 78, 86, 76, 111, 52, 251, 213]),
    }
}

/// pump_fees `update_fee_shares_v2(shareholders)`; remaining = the current shareholders.
pub fn update_fee_shares_v2_ix(
    authority: &Pubkey,
    mint: &Pubkey,
    shareholders: &[(Pubkey, u16)],
    current: &[Pubkey],
) -> Instruction {
    let sc = sharing_config_pda(mint);
    let cv = creator_vault(&sc);
    let amm_cv = amm_creator_vault_authority(&sc);
    let mut data = with_disc([111, 251, 49, 6, 78, 78, 106, 18]);
    data.extend_from_slice(&(shareholders.len() as u32).to_le_bytes());
    for (k, bps) in shareholders {
        data.extend_from_slice(k.as_ref());
        data.extend_from_slice(&bps.to_le_bytes());
    }
    let mut accounts = vec![
        meta_r(fees_event_authority()),
        meta_r(PUMP_FEES),
        AccountMeta::new(*authority, true),
        meta_r(pump_global()),
        meta_r(*mint),
        meta_w(sc),
        meta_r(bonding_curve_pda(mint)),
        meta_w(cv),
        meta_w(wsol_ata(&cv)),
        meta_r(system_program::ID),
        meta_r(PUMP),
        meta_r(pump_event_authority()),
        meta_r(PUMP_AMM),
        meta_r(amm_event_authority()),
        meta_r(WSOL),
        meta_r(TOKEN_ID),
        meta_r(ATA_ID),
        meta_w(amm_cv),
        meta_w(wsol_ata(&amm_cv)),
    ];
    accounts.extend(current.iter().map(|k| meta_w(*k)));
    Instruction { program_id: PUMP_FEES, accounts, data }
}

// ---------------- fee crank ----------------

/// pump `sweep_creator_fee` (curve): the v3 creator-fee bucket into `creator_vault(creator)`.
pub fn sweep_creator_fee_ix(payer: &Pubkey, mint: &Pubkey, creator: &Pubkey) -> Instruction {
    let curve = bonding_curve_pda(mint);
    let recipient = creator_vault(creator);
    Instruction {
        program_id: PUMP,
        accounts: vec![
            AccountMeta::new(*payer, true),
            meta_r(pump_global()),
            meta_r(*mint),
            meta_r(WSOL),
            meta_r(TOKEN_ID),
            meta_r(ATA_ID),
            meta_r(system_program::ID),
            meta_w(curve),
            meta_w(wsol_ata(&curve)),
            meta_w(recipient),
            meta_w(wsol_ata(&recipient)),
            meta_r(pump_event_authority()),
            meta_r(PUMP),
        ],
        data: with_disc([32, 246, 191, 52, 8, 201, 73, 186]),
    }
}

/// pump `distribute_creator_fees_v2(initialize_ata = false)`; remaining = shareholders in config
/// order.
pub fn distribute_creator_fees_v2_ix(payer: &Pubkey, mint: &Pubkey, shareholders: &[Pubkey]) -> Instruction {
    let sc = sharing_config_pda(mint);
    let cv = creator_vault(&sc);
    let mut data = with_disc([255, 203, 19, 79, 244, 68, 8, 159]);
    data.push(0);
    let mut accounts = vec![
        AccountMeta::new(*payer, true),
        meta_r(*mint),
        meta_r(bonding_curve_pda(mint)),
        meta_r(sc),
        meta_w(cv),
        meta_r(system_program::ID),
        meta_r(pump_event_authority()),
        meta_r(PUMP),
        meta_w(wsol_ata(&cv)),
        meta_r(WSOL),
        meta_r(TOKEN_ID),
        meta_r(ATA_ID),
    ];
    accounts.extend(shareholders.iter().map(|k| meta_w(*k)));
    Instruction { program_id: PUMP, accounts, data }
}

/// PumpSwap `sweep_creator_fee`: `Pool.creator_fees` into the coin-creator vault authority's
/// wSOL account.
pub fn amm_sweep_creator_fee_ix(env: &Env, payer: &Pubkey, mint: &Pubkey) -> Instruction {
    let pool = canonical_pool(mint);
    let (_, quote_vault, coin_creator) = env.pool_accounts(mint);
    let recipient = amm_creator_vault_authority(&coin_creator);
    Instruction {
        program_id: PUMP_AMM,
        accounts: vec![
            AccountMeta::new(*payer, true),
            meta_r(amm_global_config()),
            meta_w(pool),
            meta_r(WSOL),
            meta_r(TOKEN_ID),
            meta_w(quote_vault),
            meta_r(recipient),
            meta_w(wsol_ata(&recipient)),
            meta_r(system_program::ID),
            meta_r(ATA_ID),
            meta_r(amm_event_authority()),
            meta_r(PUMP_AMM),
        ],
        data: with_disc([32, 246, 191, 52, 8, 201, 73, 186]),
    }
}

/// PumpSwap `transfer_creator_fees_to_pump_v2`: the AMM creator vault into pump's creator vault
/// (where `distribute_creator_fees_v2` pays shareholders from).
pub fn transfer_creator_fees_to_pump_v2_ix(payer: &Pubkey, coin_creator: &Pubkey) -> Instruction {
    let cva = amm_creator_vault_authority(coin_creator);
    let pcv = creator_vault(coin_creator);
    Instruction {
        program_id: PUMP_AMM,
        accounts: vec![
            AccountMeta::new(*payer, true),
            meta_r(WSOL),
            meta_r(TOKEN_ID),
            meta_r(system_program::ID),
            meta_r(ATA_ID),
            meta_r(*coin_creator),
            meta_w(cva),
            meta_w(wsol_ata(&cva)),
            meta_w(pcv),
            meta_w(wsol_ata(&pcv)),
            meta_r(amm_event_authority()),
            meta_r(PUMP_AMM),
        ],
        data: with_disc([1, 33, 78, 185, 33, 67, 44, 92]),
    }
}

// ---------------- curve v3 trades ----------------

fn curve_v3_accounts(env: &Env, user: &Pubkey, mint: &Pubkey, user_signs: bool) -> Vec<AccountMeta> {
    let curve = bonding_curve_pda(mint);
    vec![
        meta_r(pump_global()),
        meta_r(*mint),
        meta_r(WSOL),
        meta_r(TOKEN_2022_ID),
        meta_r(TOKEN_ID),
        meta_w(curve),
        meta_w(ata22(&curve, mint)),
        meta_w(wsol_ata(&curve)),
        AccountMeta::new(*user, user_signs),
        meta_w(ata22(user, mint)),
        meta_w(wsol_ata(user)),
        meta_w(pump_uva(user)),
        meta_r(fee_config(&PUMP)),
        meta_w(env.buyback_fee_recipient()),
        meta_r(system_program::ID),
        meta_r(pump_event_authority()),
        meta_r(PUMP),
    ]
}

/// pump `buy_exact_quote_in_v3(spendable_quote_in, min_tokens_out, partial_fill = true)`.
pub fn buy_exact_quote_in_v3_ix(env: &Env, user: &Pubkey, mint: &Pubkey, sol_in: u64, min_out: u64) -> Instruction {
    let mut data = with_disc(copy_vault::pump::IX_BUY_EXACT_QUOTE_IN_V3);
    data.extend_from_slice(&sol_in.to_le_bytes());
    data.extend_from_slice(&min_out.to_le_bytes());
    data.push(1);
    Instruction { program_id: PUMP, accounts: curve_v3_accounts(env, user, mint, true), data }
}

/// pump `buy_v3(amount, max_sol_cost, partial_fill = true)`.
pub fn buy_v3_ix(env: &Env, user: &Pubkey, mint: &Pubkey, amount: u64, max_sol: u64) -> Instruction {
    let mut data = with_disc(copy_vault::pump::IX_BUY_V3);
    data.extend_from_slice(&amount.to_le_bytes());
    data.extend_from_slice(&max_sol.to_le_bytes());
    data.push(1);
    Instruction { program_id: PUMP, accounts: curve_v3_accounts(env, user, mint, true), data }
}

/// pump `sell_v3(amount, min_sol_output)`.
pub fn sell_v3_ix(env: &Env, user: &Pubkey, mint: &Pubkey, amount: u64, min_out: u64) -> Instruction {
    let mut data = with_disc(copy_vault::pump::IX_SELL_V3);
    data.extend_from_slice(&amount.to_le_bytes());
    data.extend_from_slice(&min_out.to_le_bytes());
    Instruction { program_id: PUMP, accounts: curve_v3_accounts(env, user, mint, true), data }
}

// ---------------- PumpSwap v2 trades ----------------

fn amm_v2_accounts(env: &Env, user: &Pubkey, mint: &Pubkey) -> Vec<AccountMeta> {
    let pool = canonical_pool(mint);
    let (base_vault, quote_vault, _) = env.pool_accounts(mint);
    vec![
        meta_w(pool),
        AccountMeta::new(*user, true),
        meta_r(amm_global_config()),
        meta_r(*mint),
        meta_r(WSOL),
        meta_w(ata22(user, mint)),
        meta_w(wsol_ata(user)),
        meta_w(base_vault),
        meta_w(quote_vault),
        meta_r(TOKEN_2022_ID),
        meta_r(TOKEN_ID),
        meta_r(system_program::ID),
        meta_w(amm_uva(user)),
        meta_r(fee_config(&PUMP_AMM)),
        meta_w(wsol_ata(&env.buyback_fee_recipient())),
        meta_r(amm_event_authority()),
        meta_r(PUMP_AMM),
    ]
}

/// PumpSwap `buy_exact_quote_in_v2(spendable_quote_in, min_base_amount_out)`.
pub fn amm_buy_exact_quote_in_v2_ix(env: &Env, user: &Pubkey, mint: &Pubkey, quote_in: u64, min_out: u64) -> Instruction {
    let mut data = with_disc(copy_vault::pump::IX_BUY_EXACT_QUOTE_IN_V2);
    data.extend_from_slice(&quote_in.to_le_bytes());
    data.extend_from_slice(&min_out.to_le_bytes());
    Instruction { program_id: PUMP_AMM, accounts: amm_v2_accounts(env, user, mint), data }
}

/// PumpSwap `sell_v2(base_amount_in, min_quote_amount_out)`.
pub fn amm_sell_v2_ix(env: &Env, user: &Pubkey, mint: &Pubkey, base_in: u64, min_out: u64) -> Instruction {
    let mut data = with_disc(copy_vault::pump::IX_SELL_V2);
    data.extend_from_slice(&base_in.to_le_bytes());
    data.extend_from_slice(&min_out.to_le_bytes());
    Instruction { program_id: PUMP_AMM, accounts: amm_v2_accounts(env, user, mint), data }
}

/// Decoded prefix of a bonding curve.
#[derive(Debug, Clone, Copy)]
pub struct Curve {
    pub virtual_token_reserves: u64,
    pub virtual_quote_reserves: u64,
    pub real_token_reserves: u64,
    pub real_quote_reserves: u64,
    pub complete: bool,
    pub creator: Pubkey,
}

impl Env {
    /// pump `Global.buyback_fee_recipients[8]` (same list as PumpSwap), rotating with the slot.
    pub fn buyback_fee_recipient(&self) -> Pubkey {
        let d = self.svm.get_account(&pump_global()).unwrap().data;
        let slot = self.svm.get_sysvar::<solana_sdk::clock::Clock>().slot as usize;
        let i = slot % 8;
        Pubkey::new_from_array(d[741 + 32 * i..773 + 32 * i].try_into().unwrap())
    }

    /// Credits the fee recipients (system accounts can't receive less than rent).
    pub fn fund_fee_recipients(&mut self) {
        let g = self.svm.get_account(&pump_global()).unwrap().data;
        let gc = self.svm.get_account(&amm_global_config()).unwrap().data;
        let pk = |d: &[u8], at: usize| Pubkey::new_from_array(d[at..at + 32].try_into().unwrap());
        let mut keys = vec![pk(&g, 41), pk(&g, 113)];
        keys.extend((0..7).map(|i| pk(&g, 162 + 32 * i)));
        keys.extend((0..8).map(|i| pk(&g, 741 + 32 * i)));
        keys.extend((0..8).map(|i| pk(&gc, 57 + 32 * i)));
        for k in keys {
            if self.lamports(&k) == 0 {
                self.svm.airdrop(&k, SOL).unwrap();
            }
        }
    }

    /// Rewrites pump's curve FeeConfig so trades pay `protocol_bps` (mainnet: 95) on top of the
    /// 30 bps creator fee; returns the original account for `restore_pump_fee_config`.
    pub fn set_pump_protocol_fee_bps(&mut self, protocol_bps: u64) -> solana_sdk::account::Account {
        let key = fee_config(&PUMP);
        let original = self.svm.get_account(&key).unwrap();
        let mut a = original.clone();
        // FeeConfig { bump, admin, flat_fees: Fees { lp, protocol, creator }, fee_tiers:
        // Vec<FeeTier { market_cap_lamports_threshold: u128, fees: Fees }>, .. } after the
        // discriminator; the mainnet config has one tier.
        const FLAT_PROTOCOL: usize = 8 + 1 + 32 + 8;
        const TIER0_PROTOCOL: usize = 8 + 1 + 32 + 24 + 4 + 16 + 8;
        assert_eq!(u32::from_le_bytes(a.data[65..69].try_into().unwrap()), 1, "one fee tier in the fixture");
        for at in [FLAT_PROTOCOL, TIER0_PROTOCOL] {
            a.data[at..at + 8].copy_from_slice(&protocol_bps.to_le_bytes());
        }
        self.svm.set_account(key, a).unwrap();
        original
    }

    pub fn restore_pump_fee_config(&mut self, original: solana_sdk::account::Account) {
        self.svm.set_account(fee_config(&PUMP), original).unwrap();
    }

    pub fn curve(&self, mint: &Pubkey) -> Curve {
        let d = self.svm.get_account(&bonding_curve_pda(mint)).unwrap().data;
        let u = |at: usize| u64::from_le_bytes(d[at..at + 8].try_into().unwrap());
        Curve {
            virtual_token_reserves: u(8),
            virtual_quote_reserves: u(16),
            real_token_reserves: u(24),
            real_quote_reserves: u(32),
            complete: d[48] != 0,
            creator: Pubkey::new_from_array(d[49..81].try_into().unwrap()),
        }
    }

    /// Whether `mint` trades on its canonical PumpSwap pool (the curve completed and migrated).
    pub fn graduated(&self, mint: &Pubkey) -> bool {
        self.svm.get_account(&canonical_pool(mint)).is_some_and(|a| a.owner == PUMP_AMM)
    }

    /// (pool base token account, pool quote token account, coin_creator) of `mint`'s pool.
    pub fn pool_accounts(&self, mint: &Pubkey) -> (Pubkey, Pubkey, Pubkey) {
        let d = self.svm.get_account(&canonical_pool(mint)).unwrap().data;
        let pk = |at: usize| Pubkey::new_from_array(d[at..at + 32].try_into().unwrap());
        (pk(139), pk(171), pk(211))
    }

    // ---------------- public traders ----------------

    /// `trader` buys `mint` on its current venue with exactly `sol_in` lamports.
    pub fn public_buy(&mut self, trader: &Keypair, mint: &Pubkey, sol_in: u64) -> TxResult {
        let user = trader.pubkey();
        let mut ixs = vec![create_associated_token_account_idempotent(&user, &user, mint, &TOKEN_2022_ID)];
        if self.graduated(mint) {
            let wsol = wsol_ata(&user);
            ixs.extend([
                create_associated_token_account_idempotent(&user, &user, &WSOL, &TOKEN_ID),
                solana_sdk::system_instruction::transfer(&user, &wsol, sol_in),
                spl_token::instruction::sync_native(&TOKEN_ID, &wsol).unwrap(),
                amm_buy_exact_quote_in_v2_ix(self, &user, mint, sol_in, 1),
                spl_token::instruction::close_account(&TOKEN_ID, &wsol, &user, &user, &[]).unwrap(),
            ]);
        } else {
            ixs.push(buy_exact_quote_in_v3_ix(self, &user, mint, sol_in, 1));
        }
        self.send(&ixs, &[trader])
    }

    /// `trader` sells `tokens` of `mint` on its current venue.
    pub fn public_sell(&mut self, trader: &Keypair, mint: &Pubkey, tokens: u64) -> TxResult {
        let user = trader.pubkey();
        if self.graduated(mint) {
            let wsol = wsol_ata(&user);
            let ixs = vec![
                create_associated_token_account_idempotent(&user, &user, &WSOL, &TOKEN_ID),
                amm_sell_v2_ix(self, &user, mint, tokens, 0),
                spl_token::instruction::close_account(&TOKEN_ID, &wsol, &user, &user, &[]).unwrap(),
            ];
            self.send(&ixs, &[trader])
        } else {
            let ix = sell_v3_ix(self, &user, mint, tokens, 0);
            self.send(&[ix], &[trader])
        }
    }

    pub fn coin_balance(&self, owner: &Pubkey, mint: &Pubkey) -> u64 {
        self.token_balance(&ata22(owner, mint))
    }

    /// Buys the curve out (exactly its real token reserves, completing it) and migrates it into
    /// its canonical PumpSwap pool with `migrate_v2`, as pump's migration bot does on mainnet.
    pub fn graduate(&mut self, whale: &Keypair, mint: &Pubkey) {
        let user = whale.pubkey();
        let c = self.curve(mint);
        let ata_ix = create_associated_token_account_idempotent(&user, &user, mint, &TOKEN_2022_ID);
        let buy = buy_v3_ix(self, &user, mint, c.real_token_reserves, 200 * SOL);
        ok(self.send(&[ata_ix, buy], &[whale]));
        assert!(self.curve(mint).complete, "curve completes when its real reserves are bought out");
        let ix = migrate_v2_ix(&user, mint);
        ok(self.send(&[ix], &[whale]));
        assert!(self.graduated(mint));
    }

    /// The keeper's fee crank (permissionless): sweep the curve bucket, and after graduation the
    /// pool bucket + AMM → pump transfer, then `distribute_creator_fees_v2` to `shareholders`.
    pub fn distribute_fees(&mut self, payer: &Keypair, mint: &Pubkey, shareholders: &[Pubkey]) -> TxResult {
        let sc = sharing_config_pda(mint);
        let mut ixs = vec![];
        if self.graduated(mint) {
            // The AMM creator vault's wSOL account only exists once a sweep had something to pay;
            // transfer_creator_fees_to_pump_v2 fails on a missing one.
            let pool = self.svm.get_account(&canonical_pool(mint)).unwrap().data;
            let bucket = u64::from_le_bytes(pool[279..287].try_into().unwrap());
            if bucket > 0 || self.exists(&wsol_ata(&amm_creator_vault_authority(&sc))) {
                ixs.push(amm_sweep_creator_fee_ix(self, &payer.pubkey(), mint));
                ixs.push(transfer_creator_fees_to_pump_v2_ix(&payer.pubkey(), &sc));
            }
        }
        ixs.push(sweep_creator_fee_ix(&payer.pubkey(), mint, &sc));
        ixs.push(distribute_creator_fees_v2_ix(&payer.pubkey(), mint, shareholders));
        self.send(&ixs, &[payer])
    }
}

/// pump `migrate_v2` for a SOL-quoted Token-2022 coin, plus the two boost accounts PumpSwap
/// requires as remaining accounts.
pub fn migrate_v2_ix(user: &Pubkey, mint: &Pubkey) -> Instruction {
    let curve = bonding_curve_pda(mint);
    let authority = pool_authority(mint);
    let pool = canonical_pool(mint);
    let lp = lp_mint(&pool);
    let withdraw_authority = solana_sdk::pubkey!("39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg");
    let boost = boost_vault_authority(&pool);
    Instruction {
        program_id: PUMP,
        accounts: vec![
            meta_r(pump_global()),
            meta_w(withdraw_authority),
            meta_r(*mint),
            meta_r(WSOL),
            meta_w(curve),
            meta_w(ata22(&curve, mint)),
            meta_w(wsol_ata(&curve)),
            AccountMeta::new(*user, true),
            meta_r(system_program::ID),
            meta_r(PUMP_AMM),
            meta_w(pool),
            meta_w(authority),
            meta_w(ata22(&authority, mint)),
            meta_w(wsol_ata(&authority)),
            meta_r(amm_global_config()),
            meta_w(lp),
            meta_w(ata22(&authority, &lp)),
            meta_w(ata22(&pool, mint)),
            meta_w(wsol_ata(&pool)),
            meta_r(TOKEN_2022_ID),
            meta_r(TOKEN_ID),
            meta_r(TOKEN_2022_ID),
            meta_r(ATA_ID),
            meta_r(amm_event_authority()),
            meta_r(sysvar::rent::ID),
            meta_r(pump_event_authority()),
            meta_r(PUMP),
            meta_r(boost),
            meta_w(wsol_ata(&boost)),
        ],
        data: with_disc([187, 203, 18, 31, 206, 237, 254, 41]),
    }
}

// ---------------- PumpSwap legacy trades ----------------

fn amm_legacy_accounts(env: &Env, user: &Pubkey, mint: &Pubkey) -> Vec<AccountMeta> {
    let pool = canonical_pool(mint);
    let (base_vault, quote_vault, coin_creator) = env.pool_accounts(mint);
    let gc = env.svm.get_account(&amm_global_config()).unwrap().data;
    let protocol = Pubkey::new_from_array(gc[57..89].try_into().unwrap());
    let cva = amm_creator_vault_authority(&coin_creator);
    vec![
        meta_w(pool),
        AccountMeta::new(*user, true),
        meta_r(amm_global_config()),
        meta_r(*mint),
        meta_r(WSOL),
        meta_w(ata22(user, mint)),
        meta_w(wsol_ata(user)),
        meta_w(base_vault),
        meta_w(quote_vault),
        meta_r(protocol),
        meta_w(wsol_ata(&protocol)),
        meta_r(TOKEN_2022_ID),
        meta_r(TOKEN_ID),
        meta_r(system_program::ID),
        meta_r(ATA_ID),
        meta_r(amm_event_authority()),
        meta_r(PUMP_AMM),
        meta_w(wsol_ata(&cva)),
        meta_r(cva),
    ]
}

pub fn amm_pool_v2(mint: &Pubkey) -> Pubkey {
    pda(&[b"pool-v2", mint.as_ref()], &PUMP_AMM)
}

/// PumpSwap legacy `buy_exact_quote_in(spendable_quote_in, min_base_amount_out, track_volume)`:
/// 23 accounts + pool_v2, buyback recipient and its wSOL account.
pub fn amm_legacy_buy_exact_quote_in_ix(env: &Env, user: &Pubkey, mint: &Pubkey, quote_in: u64) -> Instruction {
    let mut accounts = amm_legacy_accounts(env, user, mint);
    let buyback = env.buyback_fee_recipient();
    accounts.extend([
        meta_r(pda(&[b"global_volume_accumulator"], &PUMP_AMM)),
        meta_w(amm_uva(user)),
        meta_r(fee_config(&PUMP_AMM)),
        meta_r(PUMP_FEES),
        meta_r(amm_pool_v2(mint)),
        meta_w(buyback),
        meta_w(wsol_ata(&buyback)),
    ]);
    let mut data = with_disc(copy_vault::pump::IX_AMM_BUY_EXACT_QUOTE_IN);
    data.extend_from_slice(&quote_in.to_le_bytes());
    data.extend_from_slice(&1u64.to_le_bytes());
    data.push(0);
    Instruction { program_id: PUMP_AMM, accounts, data }
}

/// PumpSwap legacy `sell(base_amount_in, min_quote_amount_out)`: 21 accounts + pool_v2, buyback
/// recipient and its wSOL account.
pub fn amm_legacy_sell_ix(env: &Env, user: &Pubkey, mint: &Pubkey, base_in: u64) -> Instruction {
    let mut accounts = amm_legacy_accounts(env, user, mint);
    let buyback = env.buyback_fee_recipient();
    accounts.extend([
        meta_r(fee_config(&PUMP_AMM)),
        meta_r(PUMP_FEES),
        meta_r(amm_pool_v2(mint)),
        meta_r(buyback),
        meta_w(wsol_ata(&buyback)),
    ]);
    let mut data = with_disc(copy_vault::pump::IX_AMM_SELL);
    data.extend_from_slice(&base_in.to_le_bytes());
    data.extend_from_slice(&0u64.to_le_bytes());
    Instruction { program_id: PUMP_AMM, accounts, data }
}
