//! Creator fees: pump's permissionless distribution pays the vault its share as lamports and
//! `sync` (also run at the top of every vault instruction) books them as fee income; capital and
//! fees stay separate.

mod common;

use common::*;
use copy_vault::errors::CopierError;
use solana_sdk::signature::Signer;

#[test]
fn creator_fees_reach_the_vault_and_sync_books_them() {
    let mut env = Env::new();
    let launcher = env.user(10);
    let target = env.user(1).pubkey();
    let mint = env.launch_ok(&launcher, &target, 2_000);
    let vault = vault_pda(&mint);
    let cranker = env.user(1);

    // Public volume on the coin (v3: the creator fee accrues in the curve's bucket).
    let trader = env.user(20);
    ok(env.public_buy(&trader, &mint, 5 * SOL));
    let held = env.coin_balance(&trader.pubkey(), &mint);
    ok(env.public_sell(&trader, &mint, held / 2));

    let (v0, t0) = (env.lamports(&vault), env.lamports(&target));
    let meta = ok(env.distribute_fees(&cranker, &mint, &[target, vault]));
    env.record_cu("fee crank: sweep_creator_fee + distribute_creator_fees_v2", meta.compute_units_consumed);
    let (gv, gt) = (env.lamports(&vault) - v0, env.lamports(&target) - t0);
    assert!(gv > 0 && gt > 0, "both shareholders paid: vault {gv}, target {gt}");
    // 80 / 20 split, to the lamport of rounding.
    assert!((gv as i128 - 4 * gt as i128).abs() <= 4, "vault {gv} vs target {gt}");

    // The program did not move those lamports: unbooked until sync.
    let m = env.copier(&mint);
    assert_eq!(m.fees_in, 0);
    assert_eq!(m.accounted_lamports + gv, env.lamports(&vault));
    let meta = ok(env.sync(&cranker, &mint));
    assert!(meta.logs.iter().any(|l| l.starts_with("Program data: ")), "FeesSynced emitted");
    let m = env.copier(&mint);
    assert_eq!(m.fees_in, gv);
    assert_eq!(m.capital_in, 0);
    env.assert_invariants(&mint, &[]);
    // Nothing new: sync books nothing and emits nothing.
    let meta = ok(env.sync(&cranker, &mint));
    assert!(!meta.logs.iter().any(|l| l.starts_with("Program data: ")));
    assert_eq!(env.copier(&mint).fees_in, gv);

    // Lamports anyone sends straight to the vault are income too; a deposit is capital, and its
    // own sync books the pending fees first.
    ok(env.public_buy(&trader, &mint, 3 * SOL));
    ok(env.distribute_fees(&cranker, &mint, &[target, vault]));
    let gv2 = env.lamports(&vault) - env.copier(&mint).accounted_lamports;
    assert!(gv2 > 0);
    ok(env.send(&[solana_sdk::system_instruction::transfer(&trader.pubkey(), &vault, 1_000_000)], &[&trader]));
    let backer = env.user(3);
    ok(env.deposit(&backer, &mint, 2 * SOL));
    let m = env.copier(&mint);
    assert_eq!(m.fees_in, gv + gv2 + 1_000_000);
    assert_eq!(m.capital_in, 2 * SOL);
    env.assert_invariants(&mint, &[]);
    assert_err(env.deposit(&backer, &mint, 0), CopierError::ZeroAmount);

    // A sync with any other account as the wSOL account is refused.
    let ix = solana_sdk::instruction::Instruction {
        program_id: copy_vault::ID,
        accounts: anchor_lang::ToAccountMetas::to_account_metas(
            &copy_vault::accounts::SyncVault { copier: copier_pda(&mint), vault, vault_wsol: wsol_ata(&target) },
            None,
        ),
        data: anchor_lang::InstructionData::data(&copy_vault::instruction::Sync {}),
    };
    assert_err(env.send(&[ix], &[&cranker]), CopierError::TokenAccountMismatch);
}

#[test]
fn creator_fees_after_graduation_reach_the_vault() {
    let mut env = Env::new();
    let launcher = env.user(10);
    let target = env.user(1).pubkey();
    let mint = env.launch_ok(&launcher, &target, 500);
    let vault = vault_pda(&mint);
    let cranker = env.user(1);
    let whale = env.user(300);
    env.graduate(&whale, &mint);

    // The buy-out's curve fees, swept and distributed after migration.
    let v0 = env.lamports(&vault);
    ok(env.distribute_fees(&cranker, &mint, &[target, vault]));
    let curve_fees = env.lamports(&vault) - v0;
    assert!(curve_fees > 0);

    // PumpSwap volume: pool bucket → AMM creator vault → pump creator vault → shareholders.
    let trader = env.user(30);
    ok(env.public_buy(&trader, &mint, 10 * SOL));
    let held = env.coin_balance(&trader.pubkey(), &mint);
    ok(env.public_sell(&trader, &mint, held));
    let (v1, t1) = (env.lamports(&vault), env.lamports(&target));
    let meta = ok(env.distribute_fees(&cranker, &mint, &[target, vault]));
    env.record_cu(
        "fee crank after graduation: pool sweep + transfer_creator_fees_to_pump_v2 + sweep + distribute",
        meta.compute_units_consumed,
    );
    let (gv, gt) = (env.lamports(&vault) - v1, env.lamports(&target) - t1);
    assert!(gv > 0, "pool creator fees reach the vault");
    assert!((gv as i128 - 19 * gt as i128).abs() <= 19, "95 / 5 split: vault {gv} vs target {gt}");

    ok(env.sync(&cranker, &mint));
    assert_eq!(env.copier(&mint).fees_in, curve_fees + gv);
    env.assert_invariants(&mint, &[]);
}
