//! copier_buy / copier_sell on a graduated coin's canonical PumpSwap pool (AMM v2 instructions):
//! the curve is bought out in-test and migrated with pump `migrate_v2`; the program wraps SOL into
//! the vault's wSOL account for the buy and unwraps everything after each trade.

mod common;

use common::*;
use copy_vault::constants::RENT_ALLOWANCE_LAMPORTS;
use copy_vault::errors::CopierError;
use solana_sdk::signature::Signer;

#[test]
fn copy_trade_on_a_graduated_pool() {
    let mut w = World::new(20);
    let coin = w.coin();
    let whale = w.env.user(300);
    w.env.graduate(&whale, &coin);
    assert!(w.env.curve(&coin).complete);
    let (mint, target) = (w.mint, w.target.pubkey());
    let vault = vault_pda(&mint);

    w.target_buys(&coin, 5 * SOL);
    let target_now = w.target_balance(&coin);

    // The curve descriptor on a graduated coin is refused (complete curve).
    let keeper = w.env.keeper.pubkey();
    let curve_ix = buy_exact_quote_in_v3_ix(&w.env, &vault, &coin, 200_000_000, 1);
    let ix = w.env.copier_buy_ix_with(&keeper, &mint, 0, &target, &coin, 2, 200_000_000, 0, curve_ix);
    assert_err(w.env.send_copier_ix("x", ix, None), CopierError::CurveComplete);
    // A pool descriptor with another coin's pool.
    let other = w.coin();
    w.env.graduate(&whale, &other);
    let mut venue = amm_buy_exact_quote_in_v2_ix(&w.env, &vault, &coin, 200_000_000, 1);
    venue.accounts[0].pubkey = canonical_pool(&other);
    let ix = w.env.copier_buy_ix_with(&keeper, &mint, 0, &target, &coin, 6, 200_000_000, 0, venue);
    assert_err(w.env.send_copier_ix("x", ix, None), CopierError::VenueMismatch);

    let before = w.env.lamports(&vault);
    ok(w.buy(&coin, 200_000_000));
    w.check();
    let p = w.env.position(&mint, &coin).unwrap();
    let spent = before - w.env.lamports(&vault);
    assert!(spent >= 200_000_000 && spent < 210_000_000, "spent {spent}");
    assert_eq!(p.cost, spent);
    assert_eq!(p.tokens, w.vault_tokens(&coin));
    assert_eq!(p.target_snapshot, target_now);
    assert!(!w.env.exists(&wsol_ata(&vault)), "wSOL unwrapped after the buy");

    // A top-up on the pool (the AMM volume accumulator already exists now).
    w.target_buys(&coin, 2 * SOL);
    ok(w.buy(&coin, 100_000_000));
    w.check();
    let p = w.env.position(&mint, &coin).unwrap();

    // Target halves: proportional sell; the wSOL proceeds are unwrapped to vault lamports.
    let t_now = w.target_balance(&coin);
    w.target_sells(&coin, t_now / 2);
    let t_after = w.target_balance(&coin);
    let keep = (p.vault_peak as u128 * t_after as u128 / p.target_peak as u128) as u64;
    let allowed = p.tokens - keep;
    assert_err(w.sell(&coin, allowed + 1), CopierError::SellNotAllowed);
    let before = w.env.lamports(&vault);
    ok(w.sell(&coin, allowed));
    w.check();
    assert!(w.env.lamports(&vault) > before);
    assert!(!w.env.exists(&wsol_ata(&vault)));
    assert_eq!(w.env.position(&mint, &coin).unwrap().tokens, keep);

    // Target exits; the vault exits fully.
    w.target_sells(&coin, t_after);
    ok(w.sell(&coin, keep));
    w.check();
    assert!(w.env.position(&mint, &coin).is_none());
    assert_eq!(w.env.copier(&mint).open_positions, 0);
}

#[test]
fn pool_venue_account_tampering_is_refused() {
    let mut w = World::new(20);
    let coin = w.coin();
    let other = w.coin();
    let whale = w.env.user(300);
    w.env.graduate(&whale, &coin);
    w.target_buys(&coin, 5 * SOL);
    let (mint, target) = (w.mint, w.target.pubkey());
    let vault = vault_pda(&mint);
    let keeper = w.env.keeper.pubkey();
    let tamper = |w: &World, f: &dyn Fn(&mut solana_sdk::instruction::Instruction)| {
        let mut venue = amm_buy_exact_quote_in_v2_ix(&w.env, &vault, &coin, 100_000_000, 1);
        f(&mut venue);
        w.env.copier_buy_ix_with(&keeper, &mint, 0, &target, &coin, 6, 100_000_000, 0, venue)
    };
    // The vault as the buyback recipient's wSOL account (beside user_idx).
    let ix = tamper(&w, &|v| v.accounts[14].pubkey = vault);
    assert_err(w.env.send_copier_ix("x", ix, None), CopierError::UserElsewhere);
    // Another user at user_idx.
    let ix = tamper(&w, &|v| v.accounts[1].pubkey = keeper);
    assert_err(w.env.send_copier_ix("x", ix, None), CopierError::UserMismatch);
    // A vault-owned token account of another mint as the base or quote account.
    let payer = w.env.user(1);
    ok(w.env.send(
        &[anchor_spl::associated_token::spl_associated_token_account::instruction::create_associated_token_account_idempotent(
            &payer.pubkey(), &vault, &other, &TOKEN_2022_ID,
        )],
        &[&payer],
    ));
    let foreign = ata22(&vault, &other);
    let ix = tamper(&w, &|v| v.accounts[5].pubkey = foreign);
    assert_err(w.env.send_copier_ix("x", ix, None), CopierError::ForeignVaultTokenAccount);
    let ix = tamper(&w, &|v| v.accounts[6].pubkey = foreign);
    assert_err(w.env.send_copier_ix("x", ix, None), CopierError::ForeignVaultTokenAccount);
    // Wrong base mint; the curve descriptor's venue on a pool instruction.
    let ix = tamper(&w, &|v| v.accounts[3].pubkey = other);
    assert_err(w.env.send_copier_ix("x", ix, None), CopierError::MintMismatch);
    let venue = amm_buy_exact_quote_in_v2_ix(&w.env, &vault, &coin, 100_000_000, 1);
    let ix = w.env.copier_buy_ix_with(&keeper, &mint, 0, &target, &coin, 2, 100_000_000, 0, venue);
    assert_err(w.env.send_copier_ix("x", ix, None), CopierError::DiscriminatorMismatch);
    ok(w.buy(&coin, 100_000_000));
    w.check();
}

#[test]
fn donated_wsol_account_is_booked_as_income() {
    let mut w = World::new(20);
    let coin = w.coin();
    let whale = w.env.user(300);
    w.env.graduate(&whale, &coin);
    w.target_buys(&coin, 5 * SOL);
    let mint = w.mint;
    let vault = vault_pda(&mint);
    // Someone opens the vault's wSOL account and wraps 0.5 SOL into it.
    let donor = w.env.user(2);
    let wsol = wsol_ata(&vault);
    ok(w.env.send(
        &[
            anchor_spl::associated_token::spl_associated_token_account::instruction::create_associated_token_account_idempotent(
                &donor.pubkey(), &vault, &WSOL, &TOKEN_ID,
            ),
            solana_sdk::system_instruction::transfer(&donor.pubkey(), &wsol, SOL / 2),
            anchor_spl::token::spl_token::instruction::sync_native(&TOKEN_ID, &wsol).unwrap(),
        ],
        &[&donor],
    ));
    let donated = w.env.lamports(&wsol);
    let fees_before = w.env.copier(&mint).fees_in;
    let vault_before = w.env.lamports(&vault);
    ok(w.buy(&coin, 100_000_000));
    w.check();
    let m = w.env.copier(&mint);
    assert_eq!(m.fees_in - fees_before, donated, "wrapped amount and rent booked as income");
    assert!(!w.env.exists(&wsol), "unwrapped into the vault after the trade");
    let p = w.env.position(&mint, &coin).unwrap();
    assert_eq!(p.cost, vault_before + donated - w.env.lamports(&vault), "cost basis excludes the donation");
    assert!(p.cost >= 100_000_000 && p.cost < 110_000_000);
}

#[test]
fn copy_trade_on_the_legacy_amm_instructions() {
    // The seeded legacy PumpSwap descriptors (8 buy_exact_quote_in, 9 sell) also work: the
    // keeper forwards their 23 / 21 accounts plus pump's remaining accounts.
    let mut w = World::new(20);
    let coin = w.coin();
    let whale = w.env.user(300);
    w.env.graduate(&whale, &coin);
    w.target_buys(&coin, 5 * SOL);
    let (mint, target) = (w.mint, w.target.pubkey());
    let vault = vault_pda(&mint);
    let keeper = w.env.keeper.pubkey();
    let venue = amm_legacy_buy_exact_quote_in_ix(&w.env, &vault, &coin, 100_000_000);
    let ix = w.env.copier_buy_ix_with(&keeper, &mint, 0, &target, &coin, 8, 100_000_000, 0, venue);
    ok(w.env.send_copier_ix("copier_buy (pool, AMM legacy buy_exact_quote_in), opening", ix, None));
    w.check();
    let tokens = w.env.position(&mint, &coin).unwrap().tokens;
    let all = w.target_balance(&coin);
    w.target_sells(&coin, all);
    let venue = amm_legacy_sell_ix(&w.env, &vault, &coin, tokens);
    let ix = w.env.copier_sell_ix_with(&keeper, &mint, 0, &target, &coin, 9, tokens, 0, venue);
    ok(w.env.send_copier_ix("copier_sell (pool, AMM legacy sell), closing", ix, None));
    w.check();
    assert!(w.env.position(&mint, &coin).is_none());
}

/// System-transfers `lamports` to `owner`'s canonical wSOL address without creating the account.
fn prefund_wsol_address(env: &mut Env, owner: &solana_sdk::pubkey::Pubkey, lamports: u64) {
    let donor = env.user(lamports / SOL + 2);
    let to = wsol_ata(owner);
    ok(env.send(&[solana_sdk::system_instruction::transfer(&donor.pubkey(), &to, lamports)], &[&donor]));
    assert!(env.svm.get_account(&to).unwrap().data.is_empty(), "address stays uncreated");
}

#[test]
fn lamports_sent_to_the_uncreated_wsol_address_are_fees() {
    let mut w = World::new(20);
    let coin = w.coin();
    let whale = w.env.user(300);
    w.env.graduate(&whale, &coin);
    w.target_buys(&coin, 5 * SOL);
    let mint = w.mint;
    let vault = vault_pda(&mint);
    let p = SOL / 2;

    // Pool buy with more pre-sent than it spends: no Overspent, P is income, cost unaffected.
    prefund_wsol_address(&mut w.env, &vault, p);
    let fees = w.env.copier(&mint).fees_in;
    let total_before = w.env.lamports(&vault) + w.env.lamports(&wsol_ata(&vault));
    ok(w.buy(&coin, 100_000_000));
    w.check();
    let m = w.env.copier(&mint);
    assert_eq!(m.fees_in - fees, p);
    let pos = w.env.position(&mint, &coin).unwrap();
    assert_eq!(pos.cost, total_before - w.env.lamports(&vault));
    assert!(pos.cost >= 100_000_000 && pos.cost < 110_000_000);

    // Pool sell: P is income, not proceeds.
    let t_now = w.target_balance(&coin);
    w.target_sells(&coin, t_now / 2);
    let pos = w.env.position(&mint, &coin).unwrap();
    let keep = (pos.vault_peak as u128 * w.target_balance(&coin) as u128 / pos.target_peak as u128) as u64;
    let n = pos.tokens - keep;
    prefund_wsol_address(&mut w.env, &vault, p);
    let before = w.env.copier(&mint);
    let lamports_before = w.env.lamports(&vault);
    ok(w.sell(&coin, n));
    w.check();
    let after = w.env.copier(&mint);
    let proceeds = w.env.lamports(&vault) - lamports_before - p;
    let cost_removed = (pos.cost as u128 * n as u128).div_ceil(pos.tokens as u128) as u64;
    assert_eq!(after.fees_in - before.fees_in, p);
    assert_eq!(after.realized_pnl - before.realized_pnl, proceeds as i64 - cost_removed as i64);

    // buyback_burn on the graduated own coin.
    assert!(round_trip(&mut w, 10 * SOL, 200_000_000, 40 * SOL) > 0);
    w.env.graduate(&whale, &mint);
    let holder = w.env.user(20);
    ok(w.env.public_buy(&holder, &mint, 5 * SOL));
    prefund_wsol_address(&mut w.env, &vault, p);
    let before = w.env.copier(&mint);
    let lamports_before = w.env.lamports(&vault);
    let supply = w.env.mint_supply(&mint);
    ok(w.env.buyback_burn(&mint, 20_000_000));
    w.check();
    let after = w.env.copier(&mint);
    assert_eq!(after.fees_in - before.fees_in, p);
    let spent = lamports_before + p - w.env.lamports(&vault);
    assert_eq!(after.buyback_spent - before.buyback_spent, spent);
    assert!(spent >= 20_000_000 && spent < 20_000_000 + RENT_ALLOWANCE_LAMPORTS);
    assert!(w.env.mint_supply(&mint) < supply);

    // burn_platform on a graduated the platform token: the burn pool keeps the pre-sent lamports.
    let admin = w.env.admin.insecure_clone();
    let index_target = w.env.user(1).pubkey();
    let platform_mint = w.env.launch_index(vec![index_target]);
    ok(w.env.set_platform_mint_as(&admin, platform_mint));
    w.env.graduate(&whale, &platform_mint);
    ok(w.env.public_buy(&holder, &platform_mint, 5 * SOL));
    let pool = burn_pool_pda();
    prefund_wsol_address(&mut w.env, &pool, p);
    let pool_before = w.env.lamports(&pool);
    let supply = w.env.mint_supply(&platform_mint);
    ok(w.env.burn_platform(&platform_mint, 20_000_000));
    let spent = pool_before + p - w.env.lamports(&pool);
    assert_eq!(w.env.config().platform_burn_spent, spent);
    assert!(spent >= 20_000_000 && spent < 20_000_000 + RENT_ALLOWANCE_LAMPORTS);
    assert!(w.env.mint_supply(&platform_mint) < supply);
    assert!(w.env.svm.get_account(&wsol_ata(&pool)).is_none_or(|a| a.data.is_empty()));
}
