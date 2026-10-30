//! A copier with capital and a target wallet, plus the copy round trip the trade / burn tests
//! share.

use solana_sdk::instruction::Instruction;
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::{Keypair, Signer};

use super::*;

pub struct World {
    pub env: Env,
    pub mint: Pubkey,
    pub target: Keypair,
    pub coins: Vec<Pubkey>,
}

impl World {
    /// A copier of a fresh target with `capital` SOL deposited in its vault.
    pub fn new(capital: u64) -> Self {
        let mut env = Env::new();
        let launcher = env.user(10);
        let target = env.user(200);
        let mint = env.launch_ok(&launcher, &target.pubkey(), 2_000);
        let backer = env.user(capital + 1);
        ok(env.deposit(&backer, &mint, capital * SOL));
        Self { env, mint, target, coins: vec![] }
    }

    pub fn coin(&mut self) -> Pubkey {
        let creator = self.env.user(1);
        let c = self.env.create_coin(&creator);
        self.coins.push(c);
        c
    }

    pub fn check(&self) {
        self.env.assert_invariants(&self.mint, &self.coins);
    }

    pub fn target_buys(&mut self, coin: &Pubkey, sol: u64) {
        let t = self.target.insecure_clone();
        ok(self.env.public_buy(&t, coin, sol));
    }

    pub fn target_sells(&mut self, coin: &Pubkey, tokens: u64) {
        let t = self.target.insecure_clone();
        ok(self.env.public_sell(&t, coin, tokens));
    }

    pub fn target_balance(&self, coin: &Pubkey) -> u64 {
        self.env.coin_balance(&self.target.pubkey(), coin)
    }

    pub fn buy(&mut self, coin: &Pubkey, sol_in: u64) -> TxResult {
        let (m, t) = (self.mint, self.target.pubkey());
        self.env.copier_buy(&m, 0, &t, coin, sol_in)
    }

    pub fn buy_ix(&self, coin: &Pubkey, sol_in: u64) -> Instruction {
        self.env.copier_buy_ix(&self.mint, 0, &self.target.pubkey(), coin, sol_in)
    }

    pub fn sell(&mut self, coin: &Pubkey, tokens: u64) -> TxResult {
        let (m, t) = (self.mint, self.target.pubkey());
        self.env.copier_sell(&m, 0, &t, coin, tokens)
    }

    pub fn vault_tokens(&self, coin: &Pubkey) -> u64 {
        self.env.coin_balance(&vault_pda(&self.mint), coin)
    }
}

/// One copy round trip on a fresh coin: target buys `target_sol`, vault buys `sol_in`, a whale
/// moves the price by buying `whale_sol` (0 = none), the target exits, the vault exits. Returns
/// the vault's PnL on the round trip.
pub fn round_trip(w: &mut World, target_sol: u64, sol_in: u64, whale_sol: u64) -> i64 {
    let coin = w.coin();
    w.target_buys(&coin, target_sol);
    ok(w.buy(&coin, sol_in));
    w.check();
    if whale_sol > 0 {
        let whale = w.env.user(whale_sol / SOL + 5);
        ok(w.env.public_buy(&whale, &coin, whale_sol));
    }
    let all = w.target_balance(&coin);
    w.target_sells(&coin, all);
    let tokens = w.env.position(&w.mint, &coin).unwrap().tokens;
    let before = w.env.copier(&w.mint).realized_pnl;
    ok(w.sell(&coin, tokens));
    w.check();
    w.env.copier(&w.mint).realized_pnl - before
}

