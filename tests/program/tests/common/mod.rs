#![allow(dead_code)]
//! litesvm harness: copy-vault plus the mainnet pump.fun, PumpSwap, pump_fees, mayhem, SPL Token,
//! Token-2022 and ATA programs and their config accounts from `tests/program/fixtures`
//! (refresh with `tests/program/dump-fixtures.sh`).

pub mod pump;
pub mod world;

use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap, HashSet};

use anchor_lang::error::ERROR_CODE_OFFSET;
use anchor_lang::{system_program, AccountDeserialize, InstructionData, ToAccountMetas};
use anchor_spl::associated_token::get_associated_token_address_with_program_id;
use base64::Engine;
use litesvm::types::{FailedTransactionMetadata, TransactionMetadata};
use litesvm::LiteSVM;
use copy_vault::constants::*;
use copy_vault::errors::CopierError;
use copy_vault::state::{ChangeKind, Config, Copier, Params, PendingChange, Position, TradeDescriptor};
use solana_sdk::account::Account;
use solana_sdk::clock::Clock;
use solana_sdk::compute_budget::ComputeBudgetInstruction;
use solana_sdk::instruction::{AccountMeta, Instruction, InstructionError};
use solana_sdk::native_token::LAMPORTS_PER_SOL;
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::{Keypair, Signer};
use solana_sdk::transaction::{Transaction, TransactionError};

pub use self::pump::*;
#[allow(unused_imports)]
pub use self::world::*;

pub const SOL: u64 = LAMPORTS_PER_SOL;
pub type TxResult = Result<TransactionMetadata, FailedTransactionMetadata>;

pub const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures");
/// 2026-10-04T00:00:00Z: pump reads the clock (fee tiers, mayhem windows).
pub const START_TS: i64 = 1_790_985_600;
pub const TOKEN_ID: Pubkey = anchor_spl::token::ID;
pub const TOKEN_2022_ID: Pubkey = anchor_spl::token_2022::ID;
pub const ATA_ID: Pubkey = anchor_spl::associated_token::ID;

// ---------------- PDAs ----------------

pub fn pda(seeds: &[&[u8]], program: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(seeds, program).0
}
pub fn config_pda() -> Pubkey {
    pda(&[CONFIG_SEED], &copy_vault::ID)
}
pub fn copier_pda(mint: &Pubkey) -> Pubkey {
    pda(&[COPIER_SEED, mint.as_ref()], &copy_vault::ID)
}
pub fn vault_pda(mint: &Pubkey) -> Pubkey {
    pda(&[VAULT_SEED, mint.as_ref()], &copy_vault::ID)
}
pub fn position_pda(mint: &Pubkey, token_mint: &Pubkey) -> Pubkey {
    pda(&[POSITION_SEED, mint.as_ref(), token_mint.as_ref()], &copy_vault::ID)
}
pub fn burn_pool_pda() -> Pubkey {
    pda(&[BURN_POOL_SEED], &copy_vault::ID)
}
pub fn pending_pda(id: u64) -> Pubkey {
    pda(&[PENDING_SEED, &id.to_le_bytes()], &copy_vault::ID)
}
pub const INSTRUCTIONS_SYSVAR: Pubkey = solana_sdk::sysvar::instructions::ID;
/// Test fixture program (`tests/program/cpi-wrapper`) that forwards its instruction via CPI.
pub const CPI_WRAPPER: Pubkey = Pubkey::new_from_array([7; 32]);

/// `ix` wrapped in a CPI from the test wrapper program.
pub fn via_cpi(ix: Instruction) -> Instruction {
    let mut accounts = vec![AccountMeta::new_readonly(ix.program_id, false)];
    accounts.extend(ix.accounts);
    Instruction { program_id: CPI_WRAPPER, accounts, data: ix.data }
}
/// Admin timelock the suite initializes with (the minimum).
pub const TIMELOCK: i64 = 60;
pub fn program_data_pda() -> Pubkey {
    pda(&[copy_vault::ID.as_ref()], &solana_sdk::bpf_loader_upgradeable::ID)
}
pub fn ata(owner: &Pubkey, mint: &Pubkey, token_program: &Pubkey) -> Pubkey {
    get_associated_token_address_with_program_id(owner, mint, token_program)
}
pub fn ata22(owner: &Pubkey, mint: &Pubkey) -> Pubkey {
    ata(owner, mint, &TOKEN_2022_ID)
}
pub fn wsol_ata(owner: &Pubkey) -> Pubkey {
    ata(owner, &WSOL, &TOKEN_ID)
}

// ---------------- results ----------------

pub fn err_code(e: CopierError) -> u32 {
    ERROR_CODE_OFFSET + e as u32
}

fn custom_code(res: &TxResult) -> Option<u32> {
    match res {
        Err(f) => match f.err {
            TransactionError::InstructionError(_, InstructionError::Custom(code)) => Some(code),
            _ => None,
        },
        Ok(_) => None,
    }
}

/// The transaction failed with `expected` from copy-vault.
pub fn assert_err(res: TxResult, expected: CopierError) {
    let code = custom_code(&res);
    match res {
        Ok(_) => panic!("expected {expected:?}, transaction succeeded"),
        Err(f) => assert_eq!(
            code,
            Some(err_code(expected)),
            "expected {expected:?}, got {:?}; logs:\n{}",
            f.err,
            f.meta.logs.join("\n")
        ),
    }
}

/// The transaction failed with Anchor framework error `expected` (constraint violations).
pub fn assert_anchor_err(res: TxResult, expected: anchor_lang::error::ErrorCode) {
    let code = custom_code(&res);
    match res {
        Ok(_) => panic!("expected {expected:?}, transaction succeeded"),
        Err(f) => assert_eq!(
            code,
            Some(expected as u32),
            "expected {expected:?}, got {:?}; logs:\n{}",
            f.err,
            f.meta.logs.join("\n")
        ),
    }
}

pub fn assert_failed(res: TxResult) {
    assert!(res.is_err(), "expected the transaction to fail");
}

pub fn ok(res: TxResult) -> TransactionMetadata {
    match res {
        Ok(m) => m,
        Err(f) => panic!("tx failed: {:?}\n{}", f.err, f.meta.logs.join("\n")),
    }
}

fn fixture_account(path: &std::path::Path) -> (Pubkey, Account) {
    let json: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let pubkey: Pubkey = json["pubkey"].as_str().unwrap().parse().unwrap();
    let a = &json["account"];
    let data = base64::engine::general_purpose::STANDARD.decode(a["data"][0].as_str().unwrap()).unwrap();
    let account = Account {
        lamports: a["lamports"].as_u64().unwrap(),
        data,
        owner: a["owner"].as_str().unwrap().parse().unwrap(),
        executable: a["executable"].as_bool().unwrap_or(false),
        rent_epoch: 0,
    };
    (pubkey, account)
}

/// Accounting snapshot used by the invariant checks: `accounted` must always equal
/// `rent + capital_in + fees_in + realized_pnl − open_cost − platform_sent − buyback_spent`.
pub fn ledger(m: &Copier, rent: u64) -> i128 {
    rent as i128 + m.capital_in as i128 + m.fees_in as i128 + m.realized_pnl as i128 - m.open_cost as i128
        - m.platform_sent as i128
        - m.buyback_spent as i128
}

pub struct Env {
    pub svm: LiteSVM,
    pub admin: Keypair,
    pub keeper: Keypair,
    /// Compute units per labelled instruction (printed as `CU <label> <units>`).
    pub cu: BTreeMap<String, u64>,
    /// Highest `hwm` seen per copier (it must never decrease).
    pub hwm_seen: RefCell<HashMap<Pubkey, i64>>,
}

impl Env {
    /// Programs and fixtures loaded, config initialized with `keeper`.
    pub fn new() -> Self {
        let mut env = Self::bare();
        let admin = env.admin.insecure_clone();
        let keeper = env.keeper.pubkey();
        ok(env.initialize_config(&admin, keeper, TIMELOCK));
        env
    }

    /// Programs and fixtures loaded, admin set as upgrade authority, config NOT initialized.
    pub fn bare() -> Self {
        let mut svm = LiteSVM::new();
        let so = concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/deploy/copy_vault.so");
        svm.add_program_from_file(copy_vault::ID, so).expect("build the program first: anchor build");
        for (name, id) in [
            ("pump", PUMP),
            ("pump_amm", PUMP_AMM),
            ("pump_fees", PUMP_FEES),
            ("mayhem", MAYHEM),
            ("spl_token", TOKEN_ID),
            ("spl_token_2022", TOKEN_2022_ID),
            ("spl_associated_token_account", ATA_ID),
            ("cpi_wrapper", CPI_WRAPPER),
        ] {
            svm.add_program_from_file(id, format!("{FIXTURES}/{name}.so"))
                .expect("fixture program missing: run tests/program/dump-fixtures.sh");
        }
        for entry in std::fs::read_dir(format!("{FIXTURES}/accounts")).unwrap() {
            let (k, a) = fixture_account(&entry.unwrap().path());
            svm.set_account(k, a).unwrap();
        }
        let mut c = svm.get_sysvar::<Clock>();
        c.unix_timestamp = START_TS;
        c.slot = 400_000_000;
        svm.set_sysvar(&c);
        let admin = Keypair::new();
        let keeper = Keypair::new();
        svm.airdrop(&admin.pubkey(), 1_000 * SOL).unwrap();
        svm.airdrop(&keeper.pubkey(), 10 * SOL).unwrap();
        let mut env = Self { svm, admin, keeper, cu: BTreeMap::new(), hwm_seen: RefCell::new(HashMap::new()) };
        let admin_pk = env.admin.pubkey();
        env.set_upgrade_authority(Some(admin_pk));
        env.fund_fee_recipients();
        env
    }

    /// litesvm loads programs with the non-upgradeable loader, so fake the ProgramData account
    /// `initialize_config` checks (UpgradeableLoaderState::ProgramData { slot, authority }).
    pub fn set_upgrade_authority(&mut self, authority: Option<Pubkey>) {
        let mut data = vec![3u8, 0, 0, 0];
        data.extend_from_slice(&0u64.to_le_bytes());
        match authority {
            Some(a) => {
                data.push(1);
                data.extend_from_slice(a.as_ref());
            }
            None => data.push(0),
        }
        let lamports = self.svm.minimum_balance_for_rent_exemption(data.len());
        self.svm
            .set_account(
                program_data_pda(),
                Account {
                    lamports,
                    data,
                    owner: solana_sdk::bpf_loader_upgradeable::ID,
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .unwrap();
    }

    pub fn send(&mut self, ixs: &[Instruction], signers: &[&Keypair]) -> TxResult {
        let mut all = vec![ComputeBudgetInstruction::set_compute_unit_limit(1_400_000)];
        all.extend_from_slice(ixs);
        let tx = Transaction::new_signed_with_payer(&all, Some(&signers[0].pubkey()), signers, self.svm.latest_blockhash());
        let res = self.svm.send_transaction(tx);
        self.svm.expire_blockhash();
        let mut c = self.svm.get_sysvar::<Clock>();
        c.slot += 1;
        self.svm.set_sysvar(&c);
        res
    }

    /// Sends one copy-vault instruction and checks the lamport invariant: every account of the
    /// transaction whose balance rose is in `may_gain` (the vault, its token / wSOL accounts and
    /// position, the burn pool, the venue's own accounts); every other account kept its balance,
    /// except the fee payer, which paid exactly the signature fee, and `may_pay`. Records CU.
    pub fn send_tracked(
        &mut self,
        label: &str,
        ix: Instruction,
        signers: &[&Keypair],
        may_gain: &[Pubkey],
        may_pay: &[Pubkey],
    ) -> TxResult {
        let keys: Vec<Pubkey> = {
            let mut seen = HashSet::new();
            ix.accounts.iter().map(|m| m.pubkey).filter(|k| seen.insert(*k)).collect()
        };
        let payer = signers[0].pubkey();
        let before: Vec<u64> = keys.iter().map(|k| self.lamports(k)).collect();
        let payer_before = self.lamports(&payer);
        let res = self.send(&[ix], signers);
        if let Ok(meta) = &res {
        if std::env::var_os("COPIER_LOGS").is_some() {
            let logs = match &res {
                Ok(m) => &m.logs,
                Err(f) => &f.meta.logs,
            };
            println!("--- {label}\n{}", logs.join("\n"));
        }
            let fee = 5_000 * signers.len() as u64;
            for (k, b) in keys.iter().zip(before) {
                let a = self.lamports(k);
                if *k == payer || may_pay.contains(k) {
                    continue;
                }
                if a > b {
                    assert!(may_gain.contains(k), "{label}: {k} gained {} lamports", a - b);
                } else if a < b {
                    assert!(may_gain.contains(k), "{label}: {k} lost {} lamports", b - a);
                }
            }
            if !keys.contains(&payer) || !may_gain.contains(&payer) {
                let paid = payer_before - self.lamports(&payer);
                assert!(
                    paid == fee || may_pay.contains(&payer),
                    "{label}: fee payer paid {paid}, expected the {fee} fee"
                );
            }
            self.record_cu(label, meta.compute_units_consumed);
        }
        res
    }

    /// Rewrites a copier account in place (states public instructions can't reach directly).
    pub fn set_copier(&mut self, mint: &Pubkey, f: impl FnOnce(&mut Copier)) {
        let key = copier_pda(mint);
        let mut acct = self.svm.get_account(&key).unwrap();
        let mut m = self.copier(mint);
        f(&mut m);
        let mut data = Vec::with_capacity(acct.data.len());
        anchor_lang::AccountSerialize::try_serialize(&m, &mut data).unwrap();
        acct.data[..data.len()].copy_from_slice(&data);
        self.svm.set_account(key, acct).unwrap();
    }

    /// Records the CU an instruction took (the max seen per label) and prints it.
    pub fn record_cu(&mut self, label: &str, units: u64) {
        // The compute-budget instruction the harness prepends costs 150 CU.
        let units = units.saturating_sub(150);
        let e = self.cu.entry(label.to_string()).or_insert(0);
        *e = (*e).max(units);
        println!("CU {label} {units}");
    }

    pub fn user(&mut self, sol: u64) -> Keypair {
        let k = Keypair::new();
        self.svm.airdrop(&k.pubkey(), sol * SOL).unwrap();
        k
    }

    pub fn now(&self) -> i64 {
        self.svm.get_sysvar::<Clock>().unix_timestamp
    }

    pub fn warp(&mut self, secs: i64) {
        let mut c = self.svm.get_sysvar::<Clock>();
        c.unix_timestamp += secs;
        c.slot += (secs.max(1) as u64) * 2;
        self.svm.set_sysvar(&c);
    }

    /// Steps the clock back one slot (the next transaction lands in the previous one's slot).
    pub fn rewind_slot(&mut self) {
        let mut c = self.svm.get_sysvar::<Clock>();
        c.slot -= 1;
        self.svm.set_sysvar(&c);
    }

    pub fn lamports(&self, pk: &Pubkey) -> u64 {
        self.svm.get_account(pk).map(|a| a.lamports).unwrap_or(0)
    }

    pub fn exists(&self, pk: &Pubkey) -> bool {
        self.svm.get_account(pk).is_some_and(|a| a.lamports > 0)
    }

    pub fn rent0(&self) -> u64 {
        self.svm.minimum_balance_for_rent_exemption(0)
    }

    /// Balance of a token account (SPL or Token-2022), 0 when it does not exist.
    pub fn token_balance(&self, account: &Pubkey) -> u64 {
        match self.svm.get_account(account) {
            Some(a) if a.data.len() >= 165 && (a.owner == TOKEN_ID || a.owner == TOKEN_2022_ID) => {
                u64::from_le_bytes(a.data[64..72].try_into().unwrap())
            }
            _ => 0,
        }
    }

    pub fn mint_supply(&self, mint: &Pubkey) -> u64 {
        let d = self.svm.get_account(mint).unwrap().data;
        u64::from_le_bytes(d[36..44].try_into().unwrap())
    }

    pub fn config(&self) -> Config {
        let a = self.svm.get_account(&config_pda()).unwrap();
        Config::try_deserialize(&mut a.data.as_slice()).unwrap()
    }

    pub fn copier(&self, mint: &Pubkey) -> Copier {
        let a = self.svm.get_account(&copier_pda(mint)).unwrap();
        Copier::try_deserialize(&mut a.data.as_slice()).unwrap()
    }

    pub fn position(&self, mint: &Pubkey, token_mint: &Pubkey) -> Option<Position> {
        let a = self.svm.get_account(&position_pda(mint, token_mint))?;
        if a.data.is_empty() {
            return None;
        }
        Some(Position::try_deserialize(&mut a.data.as_slice()).unwrap())
    }

    /// Edits a pump-owned (or any) account's bytes in place.
    pub fn patch(&mut self, key: &Pubkey, f: impl FnOnce(&mut Vec<u8>)) {
        let mut a = self.svm.get_account(key).unwrap();
        f(&mut a.data);
        self.svm.set_account(*key, a).unwrap();
    }

    /// The invariants that hold after every instruction: the vault holds exactly what the program
    /// accounted (lamports + wSOL), at least its rent, no wSOL account between trades, and the
    /// ledger identity; `open_cost` / `open_positions` equal the sum over `token_mints`'
    /// positions.
    pub fn assert_invariants(&self, mint: &Pubkey, token_mints: &[Pubkey]) {
        let m = self.copier(mint);
        let vault = vault_pda(mint);
        let rent = self.rent0();
        let lamports = self.lamports(&vault);
        assert!(lamports >= rent, "vault below rent");
        let wsol = self.svm.get_account(&wsol_ata(&vault));
        assert!(
            wsol.as_ref().is_none_or(|a| a.owner == system_program::ID && a.data.is_empty()),
            "vault wSOL account left open"
        );
        let at_wsol_address = wsol.map_or(0, |a| a.lamports);
        assert_eq!(lamports + at_wsol_address, m.accounted_lamports, "vault total == accounted_lamports");
        assert_eq!(ledger(&m, rent), m.accounted_lamports as i128, "ledger identity");
        let positions: Vec<Position> = token_mints.iter().filter_map(|t| self.position(mint, t)).collect();
        assert_eq!(positions.iter().map(|p| p.cost).sum::<u64>(), m.open_cost, "open_cost");
        assert_eq!(positions.len(), m.open_positions as usize, "open_positions");
        assert_eq!(
            m.target_positions.iter().map(|n| *n as usize).sum::<usize>(),
            m.open_positions as usize,
            "target_positions"
        );
        for (t, p) in token_mints.iter().filter_map(|t| self.position(mint, t).map(|p| (t, p))) {
            let token_program = self.svm.get_account(t).unwrap().owner;
            assert!(
                self.token_balance(&ata(&vault, t, &token_program)) >= p.tokens,
                "vault holds the position's tokens"
            );
        }
        assert!(m.hwm >= 0 && m.hwm >= m.realized_pnl, "hwm ≥ max(0, realized_pnl)");
        let mut seen = self.hwm_seen.borrow_mut();
        let prev = seen.entry(*mint).or_insert(0);
        assert!(m.hwm >= *prev, "hwm never decreases: {} < {}", m.hwm, prev);
        *prev = m.hwm;
    }

    // ---------------- copy-vault admin instructions ----------------

    pub fn initialize_config(&mut self, signer: &Keypair, keeper: Pubkey, timelock_secs: i64) -> TxResult {
        let ix = Instruction {
            program_id: copy_vault::ID,
            accounts: copy_vault::accounts::InitializeConfig {
                admin: signer.pubkey(),
                config: config_pda(),
                program_data: program_data_pda(),
                burn_pool: burn_pool_pda(),
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: copy_vault::instruction::InitializeConfig { keeper, timelock_secs }.data(),
        };
        self.send(&[ix], &[signer])
    }

    fn admin_ix(&self, signer: &Pubkey, data: Vec<u8>) -> Instruction {
        Instruction {
            program_id: copy_vault::ID,
            accounts: copy_vault::accounts::AdminOnly { admin: *signer, config: config_pda() }.to_account_metas(None),
            data,
        }
    }

    pub fn pending(&self, id: u64) -> Option<PendingChange> {
        let a = self.svm.get_account(&pending_pda(id))?;
        if a.data.is_empty() {
            return None;
        }
        Some(PendingChange::try_deserialize(&mut a.data.as_slice()).unwrap())
    }

    fn propose_ix(&self, signer: &Pubkey, data: Vec<u8>) -> Instruction {
        Instruction {
            program_id: copy_vault::ID,
            accounts: copy_vault::accounts::ProposeChange {
                admin: *signer,
                config: config_pda(),
                pending: pending_pda(self.config().next_change_id),
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data,
        }
    }

    /// Sends a `propose_*`; returns the change id it would take and the result.
    fn propose(&mut self, signer: &Keypair, data: Vec<u8>) -> (u64, TxResult) {
        let id = self.config().next_change_id;
        let ix = self.propose_ix(&signer.pubkey(), data);
        (id, self.send(&[ix], &[signer]))
    }

    pub fn propose_params_as(&mut self, signer: &Keypair, params: Params) -> (u64, TxResult) {
        self.propose(signer, copy_vault::instruction::ProposeParams { params }.data())
    }

    pub fn propose_keeper_as(&mut self, signer: &Keypair, keeper: Pubkey) -> (u64, TxResult) {
        self.propose(signer, copy_vault::instruction::ProposeKeeper { keeper }.data())
    }

    pub fn propose_descriptors_as(&mut self, signer: &Keypair, descriptors: Vec<TradeDescriptor>) -> (u64, TxResult) {
        self.propose(signer, copy_vault::instruction::ProposeDescriptors { descriptors }.data())
    }

    pub fn propose_index_targets_as(&mut self, signer: &Keypair, mint: &Pubkey, targets: Vec<Pubkey>) -> (u64, TxResult) {
        let id = self.config().next_change_id;
        let ix = Instruction {
            program_id: copy_vault::ID,
            accounts: copy_vault::accounts::ProposeIndexTargets {
                admin: signer.pubkey(),
                config: config_pda(),
                copier: copier_pda(mint),
                pending: pending_pda(id),
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: copy_vault::instruction::ProposeIndexTargets { targets }.data(),
        };
        (id, self.send(&[ix], &[signer]))
    }

    pub fn execute_pending_ix(&self, id: u64) -> Instruction {
        let p = self.pending(id).expect("pending change");
        let copier = (p.kind == ChangeKind::IndexTargets).then_some(p.copier);
        Instruction {
            program_id: copy_vault::ID,
            accounts: copy_vault::accounts::ExecutePending {
                config: config_pda(),
                pending: pending_pda(id),
                proposer: p.proposer,
                copier,
            }
            .to_account_metas(None),
            data: copy_vault::instruction::ExecutePending {}.data(),
        }
    }

    pub fn execute_pending(&mut self, payer: &Keypair, id: u64) -> TxResult {
        let ix = self.execute_pending_ix(id);
        self.send(&[ix], &[payer])
    }

    pub fn discard_pending(&mut self, payer: &Keypair, id: u64) -> TxResult {
        let p = self.pending(id).expect("pending change");
        let ix = Instruction {
            program_id: copy_vault::ID,
            accounts: copy_vault::accounts::DiscardPending { config: config_pda(), pending: pending_pda(id), proposer: p.proposer }
                .to_account_metas(None),
            data: copy_vault::instruction::DiscardPending {}.data(),
        };
        self.send(&[ix], &[payer])
    }

    pub fn cancel_pending_as(&mut self, signer: &Keypair, id: u64) -> TxResult {
        let p = self.pending(id).expect("pending change");
        let ix = Instruction {
            program_id: copy_vault::ID,
            accounts: copy_vault::accounts::CancelPending {
                admin: signer.pubkey(),
                config: config_pda(),
                pending: pending_pda(id),
                proposer: p.proposer,
            }
            .to_account_metas(None),
            data: copy_vault::instruction::CancelPending {}.data(),
        };
        self.send(&[ix], &[signer])
    }

    /// Waits out the timelock and executes change `id` (anyone may; a fresh wallet does).
    pub fn execute_after_timelock(&mut self, id: u64) {
        self.warp(TIMELOCK);
        let anyone = self.user(1);
        ok(self.execute_pending(&anyone, id));
    }

    /// Admin parameter change through the timelock.
    pub fn set_params(&mut self, f: impl FnOnce(&mut Params)) {
        let mut p = self.config().params;
        f(&mut p);
        let admin = self.admin.insecure_clone();
        let (id, res) = self.propose_params_as(&admin, p);
        ok(res);
        self.execute_after_timelock(id);
        assert_eq!(self.config().params, p);
    }

    pub fn set_descriptors(&mut self, descriptors: Vec<TradeDescriptor>) {
        let admin = self.admin.insecure_clone();
        let (id, res) = self.propose_descriptors_as(&admin, descriptors);
        ok(res);
        self.execute_after_timelock(id);
    }

    pub fn set_index_targets(&mut self, mint: &Pubkey, targets: Vec<Pubkey>) -> TxResult {
        let admin = self.admin.insecure_clone();
        let (id, res) = self.propose_index_targets_as(&admin, mint, targets);
        ok(res);
        self.warp(TIMELOCK);
        let anyone = self.user(1);
        self.execute_pending(&anyone, id)
    }

    pub fn pause_keeper_as(&mut self, signer: &Keypair) -> TxResult {
        let ix = self.admin_ix(&signer.pubkey(), copy_vault::instruction::PauseKeeper {}.data());
        self.send(&[ix], &[signer])
    }

    pub fn keeper_heartbeat_as(&mut self, signer: &Keypair) -> TxResult {
        let ix = Instruction {
            program_id: copy_vault::ID,
            accounts: copy_vault::accounts::KeeperHeartbeat { keeper: signer.pubkey(), config: config_pda() }
                .to_account_metas(None),
            data: copy_vault::instruction::KeeperHeartbeat {}.data(),
        };
        let res = self.send(&[ix], &[signer]);
        if let Ok(m) = &res {
            self.record_cu("keeper_heartbeat", m.compute_units_consumed);
        }
        res
    }

    pub fn propose_admin_as(&mut self, signer: &Keypair, new_admin: Pubkey) -> TxResult {
        let ix = self.admin_ix(&signer.pubkey(), copy_vault::instruction::ProposeAdmin { new_admin }.data());
        self.send(&[ix], &[signer])
    }

    pub fn accept_admin_as(&mut self, signer: &Keypair) -> TxResult {
        let ix = Instruction {
            program_id: copy_vault::ID,
            accounts: copy_vault::accounts::AcceptAdmin { pending_admin: signer.pubkey(), config: config_pda() }
                .to_account_metas(None),
            data: copy_vault::instruction::AcceptAdmin {}.data(),
        };
        self.send(&[ix], &[signer])
    }

    pub fn set_platform_mint_as(&mut self, signer: &Keypair, mint: Pubkey) -> TxResult {
        let ix = Instruction {
            program_id: copy_vault::ID,
            accounts: copy_vault::accounts::SetPlatformMint {
                admin: signer.pubkey(),
                config: config_pda(),
                copier: copier_pda(&mint),
            }
            .to_account_metas(None),
            data: copy_vault::instruction::SetPlatformMint { mint }.data(),
        };
        self.send(&[ix], &[signer])
    }

    // ---------------- registration ----------------

    pub fn register_copier_ix(&self, launcher: &Pubkey, mint: &Pubkey, target: &Pubkey, trader_bps: u16) -> Instruction {
        Instruction {
            program_id: copy_vault::ID,
            accounts: copy_vault::accounts::RegisterCopier {
                launcher: *launcher,
                config: config_pda(),
                mint: *mint,
                bonding_curve: bonding_curve_pda(mint),
                sharing_config: sharing_config_pda(mint),
                target: *target,
                vault: vault_pda(mint),
                copier: copier_pda(mint),
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: copy_vault::instruction::RegisterCopier { trader_bps }.data(),
        }
    }

    pub fn register_index_ix(&self, admin: &Pubkey, mint: &Pubkey, targets: Vec<Pubkey>) -> Instruction {
        Instruction {
            program_id: copy_vault::ID,
            accounts: copy_vault::accounts::RegisterIndex {
                admin: *admin,
                config: config_pda(),
                mint: *mint,
                bonding_curve: bonding_curve_pda(mint),
                sharing_config: sharing_config_pda(mint),
                vault: vault_pda(mint),
                copier: copier_pda(mint),
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: copy_vault::instruction::RegisterIndex { targets }.data(),
        }
    }

    /// The launch tx's pump part: create_v2 (creator = launcher) → create_fee_sharing_config →
    /// update_fee_shares_v2(`shareholders`).
    pub fn launch_pump_ixs(&self, launcher: &Pubkey, mint: &Pubkey, shareholders: &[(Pubkey, u16)]) -> Vec<Instruction> {
        vec![
            create_v2_ix(mint, launcher, launcher, false),
            create_fee_sharing_config_ix(launcher, mint),
            update_fee_shares_v2_ix(launcher, mint, shareholders, &[*launcher]),
        ]
    }

    /// The full launch tx (one transaction, launcher + mint keypair signing):
    /// create_v2 + create_fee_sharing_config + update_fee_shares_v2([target X, vault 10000−X]) +
    /// register_copier(X). Returns the mint.
    pub fn launch(&mut self, launcher: &Keypair, target: &Pubkey, trader_bps: u16) -> (Pubkey, TxResult) {
        let mint = Keypair::new();
        let m = mint.pubkey();
        let mut ixs = self.launch_pump_ixs(
            &launcher.pubkey(),
            &m,
            &[(*target, trader_bps), (vault_pda(&m), 10_000 - trader_bps)],
        );
        ixs.push(self.register_copier_ix(&launcher.pubkey(), &m, target, trader_bps));
        let res = self.send(&ixs, &[launcher, &mint]);
        if let Ok(meta) = &res {
            // The register instruction's own CU, from its "consumed" log line.
            if let Some(units) = program_cu(&meta.logs, &copy_vault::ID) {
                self.record_cu("register_copier", units + 150);
            }
            self.record_cu("launch tx (create_v2 + fee sharing + register)", meta.compute_units_consumed);
        }
        (m, res)
    }

    pub fn launch_ok(&mut self, launcher: &Keypair, target: &Pubkey, trader_bps: u16) -> Pubkey {
        let (mint, res) = self.launch(launcher, target, trader_bps);
        ok(res);
        mint
    }

    /// An index copier launched by the admin: shareholders [vault 10000].
    pub fn launch_index(&mut self, targets: Vec<Pubkey>) -> Pubkey {
        let admin = self.admin.insecure_clone();
        let mint = Keypair::new();
        let m = mint.pubkey();
        let mut ixs = self.launch_pump_ixs(&admin.pubkey(), &m, &[(vault_pda(&m), 10_000)]);
        ixs.push(self.register_index_ix(&admin.pubkey(), &m, targets));
        ok(self.send(&ixs, &[&admin, &mint]));
        m
    }

    /// A plain pump coin (no copy-vault) created by `creator`: what targets trade.
    pub fn create_coin(&mut self, creator: &Keypair) -> Pubkey {
        let mint = Keypair::new();
        let ix = create_v2_ix(&mint.pubkey(), &creator.pubkey(), &creator.pubkey(), false);
        ok(self.send(&[ix], &[creator, &mint]));
        mint.pubkey()
    }

    // ---------------- vault bookkeeping ----------------

    pub fn deposit(&mut self, from: &Keypair, mint: &Pubkey, lamports: u64) -> TxResult {
        let vault = vault_pda(mint);
        let ix = Instruction {
            program_id: copy_vault::ID,
            accounts: copy_vault::accounts::Deposit {
                depositor: from.pubkey(),
                copier: copier_pda(mint),
                vault,
                vault_wsol: wsol_ata(&vault),
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: copy_vault::instruction::Deposit { lamports }.data(),
        };
        self.send_tracked("deposit", ix, &[from], &[vault], &[from.pubkey()])
    }

    pub fn sync(&mut self, payer: &Keypair, mint: &Pubkey) -> TxResult {
        let vault = vault_pda(mint);
        let ix = Instruction {
            program_id: copy_vault::ID,
            accounts: copy_vault::accounts::SyncVault { copier: copier_pda(mint), vault, vault_wsol: wsol_ata(&vault) }
                .to_account_metas(None),
            data: copy_vault::instruction::Sync {}.data(),
        };
        self.send_tracked("sync", ix, &[payer], &[], &[])
    }

    pub fn verify_trader(&mut self, target: &Keypair, mint: &Pubkey, target_idx: u8, verify: bool) -> TxResult {
        let accounts = copy_vault::accounts::VerifyTrader { target: target.pubkey(), copier: copier_pda(mint) }
            .to_account_metas(None);
        let data = if verify {
            copy_vault::instruction::VerifyTrader { target_idx }.data()
        } else {
            copy_vault::instruction::UnverifyTrader { target_idx }.data()
        };
        let ix = Instruction { program_id: copy_vault::ID, accounts, data };
        self.send_tracked(if verify { "verify_trader" } else { "unverify_trader" }, ix, &[target], &[], &[])
    }

    pub fn fund_platform_burn(&mut self, payer: &Keypair, mint: &Pubkey) -> TxResult {
        let vault = vault_pda(mint);
        let ix = Instruction {
            program_id: copy_vault::ID,
            accounts: copy_vault::accounts::FundPlatformBurn {
                config: config_pda(),
                copier: copier_pda(mint),
                vault,
                vault_wsol: wsol_ata(&vault),
                burn_pool: burn_pool_pda(),
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: copy_vault::instruction::FundPlatformBurn {}.data(),
        };
        self.send_tracked("fund_platform_burn", ix, &[payer], &[vault, burn_pool_pda()], &[])
    }

    // ---------------- trading ----------------

    /// The venue instruction for the vault (or another `user`) on `token_mint`'s current venue
    /// (curve v3 before graduation, AMM v2 after).
    pub fn venue_buy_ix(&self, user: &Pubkey, token_mint: &Pubkey, sol_in: u64) -> (u8, Instruction) {
        if self.graduated(token_mint) {
            (6, amm_buy_exact_quote_in_v2_ix(self, user, token_mint, sol_in, 1))
        } else {
            (2, buy_exact_quote_in_v3_ix(self, user, token_mint, sol_in, 1))
        }
    }

    pub fn venue_sell_ix(&self, user: &Pubkey, token_mint: &Pubkey, tokens: u64) -> (u8, Instruction) {
        if self.graduated(token_mint) {
            (7, amm_sell_v2_ix(self, user, token_mint, tokens, 0))
        } else {
            (1, sell_v3_ix(self, user, token_mint, tokens, 0))
        }
    }

    /// `copier_buy` with an explicit venue instruction (tests tamper with it).
    #[allow(clippy::too_many_arguments)]
    pub fn copier_buy_ix_with(
        &self,
        keeper: &Pubkey,
        mint: &Pubkey,
        target_idx: u8,
        target: &Pubkey,
        token_mint: &Pubkey,
        descriptor_idx: u8,
        sol_in: u64,
        min_tokens_out: u64,
        venue: Instruction,
    ) -> Instruction {
        let vault = vault_pda(mint);
        let token_program = self.svm.get_account(token_mint).unwrap().owner;
        let mut accounts = copy_vault::accounts::CopierBuyAccounts {
            keeper: *keeper,
            config: config_pda(),
            copier: copier_pda(mint),
            vault,
            token_mint: *token_mint,
            position: position_pda(mint, token_mint),
            target: *target,
            target_token_account: ata(target, token_mint, &token_program),
            vault_token_account: ata(&vault, token_mint, &token_program),
            vault_wsol: wsol_ata(&vault),
            token_program,
            quote_token_program: TOKEN_ID,
            associated_token_program: ATA_ID,
            system_program: system_program::ID,
            instructions: INSTRUCTIONS_SYSVAR,
        }
        .to_account_metas(None);
        accounts.extend(venue.accounts.into_iter().map(|mut m| {
            m.is_signer = false;
            m
        }));
        Instruction {
            program_id: copy_vault::ID,
            accounts,
            data: copy_vault::instruction::CopierBuy {
                target_idx,
                descriptor_idx,
                sol_in,
                min_tokens_out,
                ix_data: venue.data,
            }
            .data(),
        }
    }

    pub fn copier_buy_ix(&self, mint: &Pubkey, target_idx: u8, target: &Pubkey, token_mint: &Pubkey, sol_in: u64) -> Instruction {
        let (d, venue) = self.venue_buy_ix(&vault_pda(mint), token_mint, sol_in);
        self.copier_buy_ix_with(&self.keeper.pubkey(), mint, target_idx, target, token_mint, d, sol_in, 0, venue)
    }

    /// Sends a `copier_buy` as the keeper with the lamport invariant checked.
    pub fn send_copier_ix(&mut self, label: &str, ix: Instruction, signer: Option<&Keypair>) -> TxResult {
        let gainers = self.role_accounts(&ix);
        let signer = signer.map(|k| k.insecure_clone()).unwrap_or_else(|| self.keeper.insecure_clone());
        self.send_tracked(label, ix, &[&signer], &gainers, &[])
    }

    pub fn copier_buy(&mut self, mint: &Pubkey, target_idx: u8, target: &Pubkey, token_mint: &Pubkey, sol_in: u64) -> TxResult {
        let ix = self.copier_buy_ix(mint, target_idx, target, token_mint, sol_in);
        let label = if self.graduated(token_mint) { "copier_buy (pool, AMM buy_exact_quote_in_v2)" } else { "copier_buy (curve, buy_exact_quote_in_v3)" };
        let first = self.position(mint, token_mint).is_none();
        let label = if first { format!("{label}, opening") } else { label.to_string() };
        self.send_copier_ix(&label, ix, None)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn copier_sell_ix_with(
        &self,
        authority: &Pubkey,
        mint: &Pubkey,
        target_idx: u8,
        target: &Pubkey,
        token_mint: &Pubkey,
        descriptor_idx: u8,
        tokens_in: u64,
        min_sol_out: u64,
        venue: Instruction,
    ) -> Instruction {
        let vault = vault_pda(mint);
        let token_program = self.svm.get_account(token_mint).unwrap().owner;
        let mut accounts = copy_vault::accounts::CopierSellAccounts {
            authority: *authority,
            config: config_pda(),
            copier: copier_pda(mint),
            vault,
            burn_pool: burn_pool_pda(),
            token_mint: *token_mint,
            position: position_pda(mint, token_mint),
            target: *target,
            target_token_account: ata(target, token_mint, &token_program),
            vault_token_account: ata(&vault, token_mint, &token_program),
            vault_wsol: wsol_ata(&vault),
            token_program,
            quote_token_program: TOKEN_ID,
            associated_token_program: ATA_ID,
            system_program: system_program::ID,
            instructions: INSTRUCTIONS_SYSVAR,
        }
        .to_account_metas(None);
        accounts.extend(venue.accounts.into_iter().map(|mut m| {
            m.is_signer = false;
            m
        }));
        Instruction {
            program_id: copy_vault::ID,
            accounts,
            data: copy_vault::instruction::CopierSell { target_idx, descriptor_idx, tokens_in, min_sol_out, ix_data: venue.data }
                .data(),
        }
    }

    pub fn copier_sell_ix(
        &self,
        authority: &Pubkey,
        mint: &Pubkey,
        target_idx: u8,
        target: &Pubkey,
        token_mint: &Pubkey,
        tokens_in: u64,
    ) -> Instruction {
        let (d, venue) = self.venue_sell_ix(&vault_pda(mint), token_mint, tokens_in);
        self.copier_sell_ix_with(authority, mint, target_idx, target, token_mint, d, tokens_in, 0, venue)
    }

    pub fn copier_sell(&mut self, mint: &Pubkey, target_idx: u8, target: &Pubkey, token_mint: &Pubkey, tokens_in: u64) -> TxResult {
        let ix = self.copier_sell_ix(&self.keeper.pubkey(), mint, target_idx, target, token_mint, tokens_in);
        let venue = if self.graduated(token_mint) { "pool, AMM sell_v2" } else { "curve, sell_v3" };
        let closing = self.position(mint, token_mint).is_some_and(|p| p.tokens == tokens_in);
        let label = format!("copier_sell ({venue}){}", if closing { ", closing" } else { "" });
        self.send_copier_ix(&label, ix, None)
    }

    pub fn buyback_burn_ix(&self, mint: &Pubkey, sol_in: u64, min_tokens_out: u64) -> Instruction {
        let vault = vault_pda(mint);
        let (d, venue) = self.venue_buy_ix(&vault, mint, sol_in);
        let mut accounts = copy_vault::accounts::BuybackBurn {
            keeper: self.keeper.pubkey(),
            config: config_pda(),
            copier: copier_pda(mint),
            vault,
            mint: *mint,
            vault_token_account: ata22(&vault, mint),
            vault_wsol: wsol_ata(&vault),
            token_program: TOKEN_2022_ID,
            quote_token_program: TOKEN_ID,
            associated_token_program: ATA_ID,
            system_program: system_program::ID,
            instructions: INSTRUCTIONS_SYSVAR,
        }
        .to_account_metas(None);
        accounts.extend(venue.accounts.into_iter().map(|mut m| {
            m.is_signer = false;
            m
        }));
        Instruction {
            program_id: copy_vault::ID,
            accounts,
            data: copy_vault::instruction::BuybackBurn { descriptor_idx: d, sol_in, min_tokens_out, ix_data: venue.data }.data(),
        }
    }

    pub fn buyback_burn(&mut self, mint: &Pubkey, sol_in: u64) -> TxResult {
        let ix = self.buyback_burn_ix(mint, sol_in, 0);
        let label = if self.graduated(mint) { "buyback_burn (pool)" } else { "buyback_burn (curve)" };
        self.send_copier_ix(label, ix, None)
    }

    pub fn burn_platform_ix(&self, platform_mint: &Pubkey, sol_in: u64) -> Instruction {
        let pool = burn_pool_pda();
        let (d, venue) = self.venue_buy_ix(&pool, platform_mint, sol_in);
        let mut accounts = copy_vault::accounts::BurnPlatform {
            keeper: self.keeper.pubkey(),
            config: config_pda(),
            burn_pool: pool,
            platform_mint: *platform_mint,
            burn_pool_token_account: ata22(&pool, platform_mint),
            burn_pool_wsol: wsol_ata(&pool),
            token_program: TOKEN_2022_ID,
            quote_token_program: TOKEN_ID,
            associated_token_program: ATA_ID,
            system_program: system_program::ID,
            instructions: INSTRUCTIONS_SYSVAR,
        }
        .to_account_metas(None);
        accounts.extend(venue.accounts.into_iter().map(|mut m| {
            m.is_signer = false;
            m
        }));
        Instruction {
            program_id: copy_vault::ID,
            accounts,
            data: copy_vault::instruction::BurnPlatform { descriptor_idx: d, sol_in, min_tokens_out: 0, ix_data: venue.data }.data(),
        }
    }

    pub fn burn_platform(&mut self, platform_mint: &Pubkey, sol_in: u64) -> TxResult {
        let ix = self.burn_platform_ix(platform_mint, sol_in);
        let label = if self.graduated(platform_mint) { "burn_platform (pool)" } else { "burn_platform (curve)" };
        self.send_copier_ix(label, ix, None)
    }
}

/// Layout of a copy-vault trade / burn instruction: (named account count, actor index, traded-mint
/// index, indices of the named accounts that may move lamports).
fn trade_layout(ix: &Instruction) -> (usize, usize, usize, &'static [usize]) {
    let disc = &ix.data[..8];
    let buy = copy_vault::instruction::CopierBuy { target_idx: 0, descriptor_idx: 0, sol_in: 0, min_tokens_out: 0, ix_data: vec![] }.data();
    let sell = copy_vault::instruction::CopierSell { target_idx: 0, descriptor_idx: 0, tokens_in: 0, min_sol_out: 0, ix_data: vec![] }.data();
    let buyback = copy_vault::instruction::BuybackBurn { descriptor_idx: 0, sol_in: 0, min_tokens_out: 0, ix_data: vec![] }.data();
    if disc == &buy[..8] {
        // vault, position, vault_token_account, vault_wsol
        (15, 3, 4, &[3, 5, 8, 9])
    } else if disc == &sell[..8] {
        // vault, burn_pool, position, vault_token_account, vault_wsol
        (16, 3, 5, &[3, 4, 6, 9, 10])
    } else if disc == &buyback[..8] {
        // vault, vault_token_account, vault_wsol
        (12, 3, 4, &[3, 5, 6])
    } else {
        // burn_platform: burn pool and its token accounts
        (11, 2, 3, &[2, 4, 5])
    }
}

impl Env {
    /// Every account a copy-vault trade / burn may legitimately move lamports on: the trading PDA, its
    /// position and token accounts (and the burn pool for a profit share), and the venue's role
    /// accounts derived independently of the forwarded list — the canonical curve or pool and its
    /// vaults, the listed fee recipients and their wSOL accounts, the creator vaults and the
    /// PDA's volume accumulators. Any other account changing balance fails the test.
    pub fn role_accounts(&self, ix: &Instruction) -> Vec<Pubkey> {
        let (_, actor_idx, mint_idx, own) = trade_layout(ix);
        let actor = ix.accounts[actor_idx].pubkey;
        let mint = ix.accounts[mint_idx].pubkey;
        let mut keys: Vec<Pubkey> = own.iter().map(|i| ix.accounts[*i].pubkey).collect();
        let g = self.svm.get_account(&pump_global()).unwrap().data;
        let gc = self.svm.get_account(&amm_global_config()).unwrap().data;
        let pk = |d: &[u8], at: usize| Pubkey::new_from_array(d[at..at + 32].try_into().unwrap());
        let mut recipients = vec![pk(&g, 41)];
        recipients.extend((0..7).map(|i| pk(&g, 162 + 32 * i)));
        recipients.extend((0..8).map(|i| pk(&g, 741 + 32 * i)));
        recipients.extend((0..8).map(|i| pk(&gc, 57 + 32 * i)));
        for r in recipients {
            keys.push(r);
            keys.push(wsol_ata(&r));
        }
        let curve = bonding_curve_pda(&mint);
        keys.extend([curve, ata22(&curve, &mint), wsol_ata(&curve), pump_uva(&actor), amm_uva(&actor)]);
        if self.svm.get_account(&curve).is_some() {
            let creator = self.curve(&mint).creator;
            let cv = creator_vault(&creator);
            let acv = amm_creator_vault_authority(&creator);
            keys.extend([cv, wsol_ata(&cv), acv, wsol_ata(&acv)]);
        }
        if self.graduated(&mint) {
            let (base, quote, _) = self.pool_accounts(&mint);
            keys.extend([canonical_pool(&mint), base, quote]);
        }
        keys
    }
}

/// CU a program's top-level invocation consumed, from the logs.
pub fn program_cu(logs: &[String], program: &Pubkey) -> Option<u64> {
    let prefix = format!("Program {program} consumed ");
    logs.iter().rev().find_map(|l| {
        l.strip_prefix(&prefix)
            .and_then(|r| r.split_whitespace().next())
            .and_then(|n| n.parse().ok())
    })
}

pub fn meta_w(k: Pubkey) -> AccountMeta {
    AccountMeta::new(k, false)
}
pub fn meta_r(k: Pubkey) -> AccountMeta {
    AccountMeta::new_readonly(k, false)
}
