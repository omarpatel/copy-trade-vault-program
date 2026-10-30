//! The economic guards against a compromised keeper or a sandwicher: a copy-vault trade or burn must
//! be alone with its venue in the transaction, buys are rate-limited per spend window, and
//! buybacks / burns are capped per call against the venue's real SOL.

mod common;

use anchor_spl::associated_token::spl_associated_token_account::instruction::create_associated_token_account_idempotent;
use common::*;
use copy_vault::errors::CopierError;
use solana_sdk::instruction::Instruction;
use solana_sdk::signature::{Keypair, Signer};

fn memo(text: &str) -> Instruction {
    Instruction {
        program_id: copy_vault::guard::MEMO_PROGRAM_ID,
        accounts: vec![],
        data: text.as_bytes().to_vec(),
    }
}

/// `attacker`'s pump buy of `coin` (on its current venue) followed by `ix` in one transaction.
fn after_prebuy(env: &mut Env, attacker: &Keypair, coin: &solana_sdk::pubkey::Pubkey, ix: Instruction) -> TxResult {
    let user = attacker.pubkey();
    let mut ixs = vec![create_associated_token_account_idempotent(&user, &user, coin, &TOKEN_2022_ID)];
    let venue_buy = if env.graduated(coin) {
        amm_buy_exact_quote_in_v2_ix(env, &user, coin, SOL, 1)
    } else {
        buy_exact_quote_in_v3_ix(env, &user, coin, SOL, 1)
    };
    ixs.push(venue_buy);
    ixs.push(ix);
    let keeper = env.keeper.insecure_clone();
    env.send(&ixs, &[attacker, &keeper])
}

#[test]
fn trades_and_burns_must_be_alone_with_their_venue() {
    let mut w = World::new(10);
    let coin = w.coin();
    w.target_buys(&coin, 2 * SOL);
    let (mint, target) = (w.mint, w.target.pubkey());
    let vault = vault_pda(&mint);
    let keeper = w.env.keeper.insecure_clone();
    let attacker = w.env.user(20);

    // copier_buy after a same-transaction pump buy of the coin.
    let ix = w.buy_ix(&coin, 50_000_000);
    assert_err(after_prebuy(&mut w.env, &attacker, &coin, ix), CopierError::VenueTouchedInTx);
    // ... after another copy-vault instruction, after an ATA create listing the curve, after a
    // non-idempotent ATA create, after a transfer to the curve.
    let sync = Instruction {
        program_id: copy_vault::ID,
        accounts: anchor_lang::ToAccountMetas::to_account_metas(
            &copy_vault::accounts::SyncVault { copier: copier_pda(&mint), vault, vault_wsol: wsol_ata(&vault) },
            None,
        ),
        data: anchor_lang::InstructionData::data(&copy_vault::instruction::Sync {}),
    };
    let curve = bonding_curve_pda(&coin);
    let k = keeper.pubkey();
    let mut create_plain = create_associated_token_account_idempotent(&k, &k, &WSOL, &TOKEN_ID);
    create_plain.data = vec![0];
    for extra in [
        sync,
        create_associated_token_account_idempotent(&k, &curve, &WSOL, &TOKEN_ID),
        create_plain,
        solana_sdk::system_instruction::transfer(&k, &curve, 1),
        anchor_spl::token::spl_token::instruction::sync_native(&TOKEN_ID, &wsol_ata(&k)).unwrap(),
    ] {
        // Placed after the trade: the guard reads the whole transaction, not just what ran.
        let ix = w.buy_ix(&coin, 50_000_000);
        assert_err(w.env.send(&[ix, extra], &[&keeper]), CopierError::VenueTouchedInTx);
    }
    // The extras a keeper legitimately adds are fine: compute budget (the harness always adds
    // one), a memo naming the copied trade, idempotent ATA creates, a Jito-style tip.
    let tip = Keypair::new().pubkey();
    let ix = w.buy_ix(&coin, 50_000_000);
    let meta = ok(w.env.send(
        &[
            memo("copier:5xTargetSignature"),
            create_associated_token_account_idempotent(&k, &vault, &coin, &TOKEN_2022_ID),
            ix,
            solana_sdk::system_instruction::transfer(&k, &tip, 1_000_000),
        ],
        &[&keeper],
    ));
    if let Some(units) = program_cu(&meta.logs, &copy_vault::ID) {
        w.env.record_cu("copier_buy (curve) with memo + ATA + tip", units + 150);
    }
    w.check();

    // copier_sell after a same-transaction dump of the coin.
    let all = w.target_balance(&coin);
    w.target_sells(&coin, all);
    let tokens = w.env.position(&mint, &coin).unwrap().tokens;
    let dumper = w.env.user(20);
    ok(w.env.public_buy(&dumper, &coin, 5 * SOL));
    let held = w.env.coin_balance(&dumper.pubkey(), &coin);
    let ix = w.env.copier_sell_ix(&keeper.pubkey(), &mint, 0, &target, &coin, tokens);
    let dump = sell_v3_ix(&w.env, &dumper.pubkey(), &coin, held, 0);
    assert_err(w.env.send(&[dump, ix], &[&dumper, &keeper]), CopierError::VenueTouchedInTx);
    ok(w.sell(&coin, tokens));
    w.check();

    // buyback_burn after a same-transaction buy of the copier's own coin.
    let pnl = round_trip(&mut w, 10 * SOL, 200_000_000, 40 * SOL);
    assert!(pnl > 0);
    let holder = w.env.user(10);
    ok(w.env.public_buy(&holder, &mint, 5 * SOL));
    let ix = w.env.buyback_burn_ix(&mint, 10_000_000, 0);
    assert_err(after_prebuy(&mut w.env, &attacker, &mint, ix), CopierError::VenueTouchedInTx);
    ok(w.env.buyback_burn(&mint, 10_000_000));

    // burn_platform after a same-transaction buy of the platform token.
    let admin = w.env.admin.insecure_clone();
    let index_target = w.env.user(1).pubkey();
    let platform_mint = w.env.launch_index(vec![index_target]);
    ok(w.env.set_platform_mint_as(&admin, platform_mint));
    ok(w.env.public_buy(&holder, &platform_mint, 3 * SOL));
    let ix = w.env.burn_platform_ix(&platform_mint, 10_000_000);
    assert_err(after_prebuy(&mut w.env, &attacker, &platform_mint, ix), CopierError::VenueTouchedInTx);
    ok(w.env.burn_platform(&platform_mint, 10_000_000));
    w.check();
}

#[test]
fn buys_are_capped_per_spend_window() {
    let mut w = World::new(10);
    w.env.set_params(|p| p.max_window_spend_bps = 500);
    let coins: Vec<_> = (0..4).map(|_| w.coin()).collect();
    for c in &coins {
        w.target_buys(c, 10 * SOL);
    }
    let equity = w.env.copier(&w.mint).accounted_lamports - w.env.rent0();
    let cap = equity * 500 / 10_000;

    ok(w.buy(&coins[0], 250_000_000));
    let m = w.env.copier(&w.mint);
    assert_eq!(m.window_start, w.env.now());
    assert_eq!(m.window_equity, equity, "the window's base is the equity when it opened");
    assert_eq!(m.window_spent, m.open_cost);
    ok(w.buy(&coins[1], 200_000_000));
    w.check();
    let spent = w.env.copier(&w.mint).window_spent;
    assert!(spent + 100_000_000 > cap && spent <= cap, "spent {spent} of {cap}");
    assert_err(w.buy(&coins[2], 100_000_000), CopierError::SpendWindowExceeded);
    // What is left of the window can still be spent.
    ok(w.buy(&coins[2], cap - spent - RENT_CAP));
    w.check();

    // A new window opens after spend_window_secs, based on the then-current equity.
    w.env.warp(3_599);
    assert_err(w.buy(&coins[3], 100_000_000), CopierError::SpendWindowExceeded);
    w.env.warp(1);
    ok(w.buy(&coins[3], 100_000_000));
    w.check();
    let m = w.env.copier(&w.mint);
    assert_eq!(m.window_start, w.env.now());
    assert!(m.window_spent >= 100_000_000 && m.window_spent < 100_000_000 + RENT_CAP);
}

#[test]
fn trades_refuse_to_run_as_a_cpi() {
    let mut w = World::new(10);
    let coin = w.coin();
    w.target_buys(&coin, 2 * SOL);
    let keeper = w.env.keeper.insecure_clone();
    let ix = via_cpi(w.buy_ix(&coin, 50_000_000));
    assert_err(w.env.send(&[ix], &[&keeper]), CopierError::NotTopLevel);
    // The wrapper itself forwards fine: the same buy top-level succeeds.
    ok(w.buy(&coin, 50_000_000));
    let all = w.target_balance(&coin);
    w.target_sells(&coin, all);
    let (mint, target) = (w.mint, w.target.pubkey());
    let tokens = w.env.position(&mint, &coin).unwrap().tokens;
    let ix = via_cpi(w.env.copier_sell_ix(&keeper.pubkey(), &mint, 0, &target, &coin, tokens));
    assert_err(w.env.send(&[ix], &[&keeper]), CopierError::NotTopLevel);
    // A non-trade copy-vault instruction (sync) is fine through the wrapper.
    let vault = vault_pda(&mint);
    let sync = Instruction {
        program_id: copy_vault::ID,
        accounts: anchor_lang::ToAccountMetas::to_account_metas(
            &copy_vault::accounts::SyncVault { copier: copier_pda(&mint), vault, vault_wsol: wsol_ata(&vault) },
            None,
        ),
        data: anchor_lang::InstructionData::data(&copy_vault::instruction::Sync {}),
    };
    ok(w.env.send(&[via_cpi(sync)], &[&keeper]));
    ok(w.sell(&coin, tokens));
    w.check();
}

#[test]
fn spends_straddling_a_window_boundary_stay_within_two_caps() {
    let mut w = World::new(10);
    w.env.set_params(|p| p.max_window_spend_bps = 500);
    let coins: Vec<_> = (0..6).map(|_| w.coin()).collect();
    for c in &coins {
        w.target_buys(c, 10 * SOL);
    }
    let spent = |w: &World| w.env.copier(&w.mint).open_cost;
    // Window 1 opens with a small buy, then fills up in its last second.
    ok(w.buy(&coins[0], 50_000_000));
    let m = w.env.copier(&w.mint);
    let (t0, cap1) = (m.window_start, m.window_equity * 500 / 10_000);
    w.env.warp(3_599);
    let before_edge = spent(&w);
    ok(w.buy(&coins[1], 250_000_000));
    ok(w.buy(&coins[2], cap1 - w.env.copier(&w.mint).window_spent - RENT_CAP));
    assert_err(w.buy(&coins[3], 10_000_000), CopierError::SpendWindowExceeded);
    // One second later window 2 opens on the then-current equity and fills up too.
    w.env.warp(1);
    let at_edge = w.env.now();
    ok(w.buy(&coins[3], 250_000_000));
    let m = w.env.copier(&w.mint);
    assert_eq!(m.window_start, t0 + 3_600);
    let cap2 = m.window_equity * 500 / 10_000;
    ok(w.buy(&coins[4], cap2 - m.window_spent - RENT_CAP));
    w.check();
    // Nothing more until window 2 ends, i.e. for the rest of the hour that started just before
    // window 1 ended.
    w.env.warp(3_598);
    assert_err(w.buy(&coins[5], 10_000_000), CopierError::SpendWindowExceeded);
    let in_one_hour = spent(&w) - before_edge;
    assert!(w.env.now() - (at_edge - 1) < 3_600);
    assert!(in_one_hour <= cap1 + cap2, "spent {in_one_hour} within one window length");
    assert!(cap2 <= cap1, "a window's base is book equity, which buys don't raise");
    assert!(in_one_hour <= 2 * cap1);
    assert!(in_one_hour > cap1, "both windows were used");
}

/// Upper bound of the rent a first buy pays (UVA + token account + position).
const RENT_CAP: u64 = 10_000_000;
