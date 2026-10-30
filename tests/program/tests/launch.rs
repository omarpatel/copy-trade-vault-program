//! The launch transaction: create_v2 + create_fee_sharing_config + update_fee_shares_v2 +
//! register_copier, every register rejection, and Index copiers.

mod common;

use anchor_lang::error::ErrorCode as AnchorError;
use common::*;
use copy_vault::errors::CopierError;
use copy_vault::state::CopierKind;
use solana_sdk::signature::{Keypair, Signer};

#[test]
fn launch_tx_end_to_end() {
    let mut env = Env::new();
    let launcher = env.user(10);
    let target = env.user(1).pubkey();
    let launcher_before = env.lamports(&launcher.pubkey());
    let mint = env.launch_ok(&launcher, &target, 2_000);

    let m = env.copier(&mint);
    assert_eq!(m.mint, mint);
    assert_eq!(m.launcher, launcher.pubkey());
    assert_eq!(m.kind, CopierKind::Single);
    assert_eq!(m.targets, vec![target]);
    assert_eq!(m.trader_bps, 2_000);
    assert_eq!(m.verified, 0);
    assert_eq!(m.sharing_config, sharing_config_pda(&mint));
    assert_eq!(m.created_at, env.now());
    assert_eq!(m.fees_in, 0);
    assert_eq!(m.capital_in, 0);
    let vault = vault_pda(&mint);
    assert_eq!(env.lamports(&vault), env.rent0(), "register funds the vault to rent");
    assert_eq!(m.accounted_lamports, env.rent0());
    let curve = env.curve(&mint);
    assert_eq!(curve.creator, sharing_config_pda(&mint), "creator fees route to the sharing config");
    assert!(!curve.complete);
    let sc = env.svm.get_account(&sharing_config_pda(&mint)).unwrap().data;
    assert_eq!(sc[75], 1, "admin revoked: the split is final");
    println!("launch cost to launcher: {} lamports", launcher_before - env.lamports(&launcher.pubkey()));
    env.assert_invariants(&mint, &[]);

    // The target verifies (and can unverify) itself; nobody else can.
    let target_kp = env.user(1);
    let mint2 = env.launch_ok(&launcher, &target_kp.pubkey(), 100);
    let stranger = env.user(1);
    assert_err(env.verify_trader(&stranger, &mint2, 0, true), CopierError::TargetMismatch);
    assert_err(env.verify_trader(&target_kp, &mint2, 1, true), CopierError::TargetIndex);
    ok(env.verify_trader(&target_kp, &mint2, 0, true));
    assert_eq!(env.copier(&mint2).verified, 1);
    ok(env.verify_trader(&target_kp, &mint2, 0, false));
    assert_eq!(env.copier(&mint2).verified, 0);

    // Edge cuts: 1% and 25% are allowed.
    let mint3 = env.launch_ok(&launcher, &Keypair::new().pubkey(), 2_500);
    assert_eq!(env.copier(&mint3).trader_bps, 2_500);
}

/// Sends the pump part of a launch (`shareholders` as given), applies `tamper`, then
/// `register_copier(trader_bps)` with `target` in a second transaction.
fn register_after(
    env: &mut Env,
    shareholders: impl FnOnce(&solana_sdk::pubkey::Pubkey) -> Vec<(solana_sdk::pubkey::Pubkey, u16)>,
    target: solana_sdk::pubkey::Pubkey,
    trader_bps: u16,
    tamper: impl FnOnce(&mut Env, &solana_sdk::pubkey::Pubkey),
) -> TxResult {
    let launcher = env.user(10);
    let mint = Keypair::new();
    let m = mint.pubkey();
    let ixs = env.launch_pump_ixs(&launcher.pubkey(), &m, &shareholders(&vault_pda(&m)));
    ok(env.send(&ixs, &[&launcher, &mint]));
    tamper(env, &m);
    let ix = env.register_copier_ix(&launcher.pubkey(), &m, &target, trader_bps);
    env.send(&[ix], &[&launcher])
}

#[test]
fn register_rejections() {
    let mut env = Env::new();
    let t = Keypair::new().pubkey();
    let split = |x: u16| move |v: &solana_sdk::pubkey::Pubkey| vec![(t, x), (*v, 10_000 - x)];
    let none = |_: &mut Env, _: &solana_sdk::pubkey::Pubkey| {};

    // The happy path through the same helper.
    ok(register_after(&mut env, split(1_000), t, 1_000, none));

    // Trader cut outside 1%..25% (the pump split matches, copy-vault refuses it).
    assert_err(register_after(&mut env, split(99), t, 99, none), CopierError::TraderBpsOutOfRange);
    assert_err(register_after(&mut env, split(2_501), t, 2_501, none), CopierError::TraderBpsOutOfRange);
    // Declared cut differs from the on-chain split.
    assert_err(register_after(&mut env, split(1_000), t, 1_500, none), CopierError::ShareholdersMismatch);
    // Target is not the shareholder.
    let other = Keypair::new().pubkey();
    assert_err(register_after(&mut env, split(1_000), other, 1_000, none), CopierError::ShareholdersMismatch);
    // Vault not a shareholder / a third shareholder / vault only.
    let x = Keypair::new().pubkey();
    assert_err(
        register_after(&mut env, |_| vec![(t, 1_000), (x, 9_000)], t, 1_000, none),
        CopierError::ShareholdersMismatch,
    );
    assert_err(
        register_after(&mut env, |v| vec![(t, 1_000), (*v, 8_000), (x, 1_000)], t, 1_000, none),
        CopierError::ShareholdersMismatch,
    );
    assert_err(
        register_after(&mut env, |v| vec![(*v, 10_000)], t, 1_000, none),
        CopierError::ShareholdersMismatch,
    );
    // Target that can't receive fees / isn't a wallet: an executable program, a token account.
    assert_err(
        register_after(&mut env, |v| vec![(TOKEN_ID, 1_000), (*v, 9_000)], TOKEN_ID, 1_000, none),
        CopierError::TargetInvalid,
    );
    let pool_vault = wsol_ata(&canonical_pool(&x));
    let _ = pool_vault;
    let token_acct = {
        let owner = env.user(1);
        let ix = anchor_spl::associated_token::spl_associated_token_account::instruction::create_associated_token_account_idempotent(
            &owner.pubkey(), &owner.pubkey(), &WSOL, &TOKEN_ID);
        ok(env.send(&[ix], &[&owner]));
        wsol_ata(&owner.pubkey())
    };
    assert_err(
        register_after(&mut env, move |v| vec![(token_acct, 1_000), (*v, 9_000)], token_acct, 1_000, none),
        CopierError::TargetInvalid,
    );

    // Split not final: fee sharing created but never updated (admin not revoked, launcher 100%).
    let launcher = env.user(10);
    let mint = Keypair::new();
    let m = mint.pubkey();
    let ixs = vec![create_v2_ix(&m, &launcher.pubkey(), &launcher.pubkey(), false), create_fee_sharing_config_ix(&launcher.pubkey(), &m)];
    ok(env.send(&ixs, &[&launcher, &mint]));
    let ix = env.register_copier_ix(&launcher.pubkey(), &m, &t, 1_000);
    assert_err(env.send(&[ix], &[&launcher]), CopierError::SharingConfigAdminNotRevoked);

    // No fee sharing at all: the creator is the launcher and the sharing config doesn't exist.
    let mint = Keypair::new();
    let m = mint.pubkey();
    ok(env.send(&[create_v2_ix(&m, &launcher.pubkey(), &launcher.pubkey(), false)], &[&launcher, &mint]));
    let ix = env.register_copier_ix(&launcher.pubkey(), &m, &t, 1_000);
    assert_err(env.send(&[ix], &[&launcher]), CopierError::SharingConfigInvalid);

    // State a launch can't produce today but pump could: patched accounts.
    let sc_byte = |at: usize, v: u8| {
        move |env: &mut Env, m: &solana_sdk::pubkey::Pubkey| env.patch(&sharing_config_pda(m), |d| d[at] = v)
    };
    assert_err(register_after(&mut env, split(1_000), t, 1_000, sc_byte(9, 1)), CopierError::SharingConfigVersion);
    assert_err(register_after(&mut env, split(1_000), t, 1_000, sc_byte(10, 0)), CopierError::SharingConfigNotActive);
    let bc_byte = |at: usize, v: u8| {
        move |env: &mut Env, m: &solana_sdk::pubkey::Pubkey| env.patch(&bonding_curve_pda(m), |d| d[at] = v)
    };
    assert_err(register_after(&mut env, split(1_000), t, 1_000, bc_byte(48, 1)), CopierError::CurveComplete);
    assert_err(register_after(&mut env, split(1_000), t, 1_000, bc_byte(81, 1)), CopierError::MayhemCoin);
    assert_err(register_after(&mut env, split(1_000), t, 1_000, bc_byte(82, 1)), CopierError::CashbackCoin);
    assert_err(register_after(&mut env, split(1_000), t, 1_000, bc_byte(124, 1)), CopierError::HolderRewardCoin);
    assert_err(register_after(&mut env, split(1_000), t, 1_000, bc_byte(83, 7)), CopierError::NotSolQuoted);
    assert_err(
        register_after(&mut env, split(1_000), t, 1_000, |env, m| {
            env.patch(&bonding_curve_pda(m), |d| d[49..81].copy_from_slice(t.as_ref()))
        }),
        CopierError::CreatorNotSharingConfig,
    );
    // Mint with a freeze authority / with a transfer hook extension.
    assert_err(
        register_after(&mut env, split(1_000), t, 1_000, |env, m| env.patch(m, |d| d[46] = 1)),
        CopierError::MintUnsafe,
    );
    assert_err(
        register_after(&mut env, split(1_000), t, 1_000, |env, m| {
            env.patch(m, |d| {
                // Rewrite the first TLV entry's type to TransferHook (14).
                d[166..168].copy_from_slice(&14u16.to_le_bytes());
            })
        }),
        CopierError::MintUnsafe,
    );
    // Vault PDA carrying data.
    assert_err(
        register_after(&mut env, split(1_000), t, 1_000, |env, m| {
            let v = vault_pda(m);
            env.svm
                .set_account(
                    v,
                    solana_sdk::account::Account {
                        lamports: 10_000_000,
                        data: vec![0; 8],
                        owner: anchor_lang::system_program::ID,
                        executable: false,
                        rent_epoch: 0,
                    },
                )
                .unwrap();
        }),
        CopierError::VaultInvalid,
    );

    // Wrong accounts: another coin's sharing config / curve.
    let launcher = env.user(10);
    let (good, _) = {
        let k = Keypair::new().pubkey();
        (env.launch_ok(&launcher, &k, 1_000), k)
    };
    let mint = Keypair::new();
    let m = mint.pubkey();
    let ixs = env.launch_pump_ixs(&launcher.pubkey(), &m, &[(t, 1_000), (vault_pda(&m), 9_000)]);
    ok(env.send(&ixs, &[&launcher, &mint]));
    let mut ix = env.register_copier_ix(&launcher.pubkey(), &m, &t, 1_000);
    ix.accounts[4].pubkey = sharing_config_pda(&good);
    assert_err(env.send(&[ix], &[&launcher]), CopierError::SharingConfigMismatch);
    let mut ix = env.register_copier_ix(&launcher.pubkey(), &m, &t, 1_000);
    ix.accounts[3].pubkey = bonding_curve_pda(&good);
    assert_err(env.send(&[ix], &[&launcher]), CopierError::BondingCurveMismatch);
    // Registering the same coin twice.
    let ix = env.register_copier_ix(&launcher.pubkey(), &m, &t, 1_000);
    ok(env.send(&[ix], &[&launcher]));
    let ix = env.register_copier_ix(&launcher.pubkey(), &m, &t, 1_000);
    assert_failed(env.send(&[ix], &[&launcher]));
    // A vault account that is not the mint's vault PDA.
    let fresh = Keypair::new();
    let f = fresh.pubkey();
    let ixs = env.launch_pump_ixs(&launcher.pubkey(), &f, &[(t, 1_000), (vault_pda(&f), 9_000)]);
    ok(env.send(&ixs, &[&launcher, &fresh]));
    let mut ix = env.register_copier_ix(&launcher.pubkey(), &f, &t, 1_000);
    ix.accounts[6].pubkey = vault_pda(&m);
    assert_anchor_err(env.send(&[ix], &[&launcher]), AnchorError::ConstraintSeeds);
}

#[test]
fn index_copier_registration_and_targets() {
    let mut env = Env::new();
    let admin = env.admin.insecure_clone();
    let targets: Vec<_> = (0..3).map(|_| Keypair::new().pubkey()).collect();
    let mint = env.launch_index(targets.clone());
    let m = env.copier(&mint);
    assert_eq!(m.kind, CopierKind::Index);
    assert_eq!(m.trader_bps, 0);
    assert_eq!(m.targets, targets);
    env.assert_invariants(&mint, &[]);

    // Only the admin registers index copiers; the split must be [vault 10000].
    let stranger = env.user(10);
    let mint_kp = Keypair::new();
    let mk = mint_kp.pubkey();
    let mut ixs = env.launch_pump_ixs(&stranger.pubkey(), &mk, &[(vault_pda(&mk), 10_000)]);
    ixs.push(env.register_index_ix(&stranger.pubkey(), &mk, targets.clone()));
    assert_err(env.send(&ixs, &[&stranger, &mint_kp]), CopierError::NotAdmin);
    let mint_kp = Keypair::new();
    let mk = mint_kp.pubkey();
    let t0 = targets[0];
    let mut ixs = env.launch_pump_ixs(&admin.pubkey(), &mk, &[(t0, 1_000), (vault_pda(&mk), 9_000)]);
    ixs.push(env.register_index_ix(&admin.pubkey(), &mk, targets.clone()));
    assert_err(env.send(&ixs, &[&admin, &mint_kp]), CopierError::ShareholdersMismatch);
    for bad in [vec![], vec![t0, t0], (0..17).map(|_| Keypair::new().pubkey()).collect()] {
        let mint_kp = Keypair::new();
        let mk = mint_kp.pubkey();
        let mut ixs = env.launch_pump_ixs(&admin.pubkey(), &mk, &[(vault_pda(&mk), 10_000)]);
        ixs.push(env.register_index_ix(&admin.pubkey(), &mk, bad));
        assert_err(env.send(&ixs, &[&admin, &mint_kp]), CopierError::InvalidTargets);
    }

    // Index targets change through the timelock: admin only, Index only, valid lists; the
    // verification bits follow their target.
    let target1 = env.user(1);
    let mut with_kp = targets.clone();
    with_kp[1] = target1.pubkey();
    ok(env.set_index_targets(&mint, with_kp.clone()));
    ok(env.verify_trader(&target1, &mint, 1, true));
    assert_eq!(env.copier(&mint).verified, 0b10);
    let reordered = vec![with_kp[1], with_kp[0]];
    let (id, res) = env.propose_index_targets_as(&admin, &mint, reordered.clone());
    ok(res);
    assert_err(env.execute_pending(&stranger, id), CopierError::TimelockNotElapsed);
    assert_eq!(env.copier(&mint).targets, with_kp, "nothing changes before the timelock");
    env.execute_after_timelock(id);
    let m = env.copier(&mint);
    assert_eq!(m.targets, reordered);
    assert_eq!(m.verified, 0b01, "verified bit follows its target");
    assert!(env.pending(id).is_none(), "executed change closed");
    assert_err(env.propose_index_targets_as(&stranger, &mint, targets.clone()).1, CopierError::NotAdmin);
    assert_err(env.propose_index_targets_as(&admin, &mint, vec![t0, t0]).1, CopierError::InvalidTargets);
    let single = env.launch_ok(&stranger, &t0, 1_000);
    assert_err(env.propose_index_targets_as(&admin, &single, targets.clone()).1, CopierError::NotIndex);

    // the platform token mint: once, Index only.
    assert_err(env.set_platform_mint_as(&admin, single), CopierError::PlatformMintNotIndex);
    assert_err(env.set_platform_mint_as(&stranger, mint), CopierError::NotAdmin);
    ok(env.set_platform_mint_as(&admin, mint));
    assert_eq!(env.config().platform_mint, mint);
    let other = env.launch_index(vec![t0]);
    assert_err(env.set_platform_mint_as(&admin, other), CopierError::PlatformMintAlreadySet);
}
