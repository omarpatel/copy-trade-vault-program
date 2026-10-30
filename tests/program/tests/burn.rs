//! Buybacks: `buyback_burn` turns a copier's buyback pool into burned own-coin supply (curve and
//! pool), `burn_platform` turns the burn pool into burned the platform token, `fund_platform_burn` moves a pending
//! the platform token share, and the platform token index keeps its whole profit share for its own buyback.

mod common;

use common::*;
use copy_vault::constants::RENT_ALLOWANCE_LAMPORTS;
use copy_vault::errors::CopierError;
use solana_sdk::signature::Signer;

/// A copier with a buyback pool from one profitable copy, and public holders of its own coin
/// (buybacks are capped at max_impact_bps of the venue's real SOL).
fn profitable() -> World {
    let mut w = World::new(10);
    let pnl = round_trip(&mut w, 10 * SOL, 200_000_000, 40 * SOL);
    assert!(pnl > 0);
    let m = w.env.copier(&w.mint);
    assert!(m.buyback_pool > 50_000_000, "buyback pool {}", m.buyback_pool);
    let holder = w.env.user(10);
    let mint = w.mint;
    ok(w.env.public_buy(&holder, &mint, 5 * SOL));
    w
}

#[test]
fn buyback_burn_reduces_supply_on_the_curve_and_the_pool() {
    let mut w = profitable();
    let mint = w.mint;
    let pool = w.env.copier(&mint).buyback_pool;
    let supply = w.env.mint_supply(&mint);
    assert_eq!(supply, COIN_SUPPLY);

    // Not the keeper; more than the pool.
    let stranger = w.env.user(1);
    let mut ix = w.env.buyback_burn_ix(&mint, 10_000_000, 0);
    ix.accounts[0].pubkey = stranger.pubkey();
    assert_err(w.env.send(&[ix], &[&stranger]), CopierError::NotKeeper);
    assert_err(w.env.buyback_burn(&mint, pool + 1), CopierError::ExceedsBuybackPool);
    let ix = w.env.buyback_burn_ix(&mint, 20_000_000, u64::MAX);
    assert_err(w.env.send_copier_ix("x", ix, None), CopierError::SlippageTokens);
    // Per call: at most max_impact_bps of the curve's real SOL.
    w.env.set_params(|p| p.max_impact_bps = 50);
    let cap = w.env.curve(&mint).real_quote_reserves * 50 / 10_000;
    assert!(cap + 1 <= w.env.copier(&mint).buyback_pool);
    assert_err(w.env.buyback_burn(&mint, cap + 1), CopierError::ExceedsImpact);

    // Curve buyback: everything bought is burned.
    let before = w.env.copier(&mint);
    let vault_before = w.env.lamports(&vault_pda(&mint));
    ok(w.env.buyback_burn(&mint, 20_000_000));
    w.check();
    let m = w.env.copier(&mint);
    let burned = supply - w.env.mint_supply(&mint);
    let spent = vault_before - w.env.lamports(&vault_pda(&mint));
    assert!(burned > 0);
    assert_eq!(m.burned, burned);
    assert_eq!(w.env.coin_balance(&vault_pda(&mint), &mint), 0, "nothing kept");
    assert_eq!(m.buyback_spent, spent);
    assert_eq!(m.buyback_pool, before.buyback_pool - spent.min(before.buyback_pool));
    assert_eq!(m.last_buyback_ts, w.env.now());

    // At most one buyback a minute.
    assert_err(w.env.buyback_burn(&mint, 10_000_000), CopierError::BuybackTooSoon);
    w.env.warp(60);
    ok(w.env.buyback_burn(&mint, 10_000_000));
    w.check();

    // After graduation the buyback runs on the pool (wSOL wrapped and unwrapped).
    let whale = w.env.user(300);
    w.env.graduate(&whale, &mint);
    w.env.warp(60);
    let supply = w.env.mint_supply(&mint);
    let m = w.env.copier(&mint);
    ok(w.env.buyback_burn(&mint, m.buyback_pool.min(15_000_000)));
    w.check();
    let m2 = w.env.copier(&mint);
    assert!(w.env.mint_supply(&mint) < supply);
    assert_eq!(m2.burned - m.burned, supply - w.env.mint_supply(&mint));
    assert_eq!(m2.graduated_pool, canonical_pool(&mint));
    assert!(!w.env.exists(&wsol_ata(&vault_pda(&mint))));
}

#[test]
fn burn_platform_buys_and_burns_platform_token() {
    let mut w = profitable();
    let burn_pool = burn_pool_pda();
    let available = w.env.lamports(&burn_pool) - w.env.rent0();
    assert_eq!(available, w.env.copier(&w.mint).platform_sent);

    // the platform token not set yet.
    let creator = w.env.user(1);
    let not_yet = w.env.create_coin(&creator);
    let ix = w.env.burn_platform_ix(&not_yet, 10_000_000);
    assert_err(w.env.send_copier_ix("x", ix, None), CopierError::PlatformMintNotSet);

    let admin = w.env.admin.insecure_clone();
    let index_target = w.env.user(1).pubkey();
    let platform_mint = w.env.launch_index(vec![index_target]);
    ok(w.env.set_platform_mint_as(&admin, platform_mint));

    // Another mint than the platform token; more than the pool holds.
    let ix = w.env.burn_platform_ix(&not_yet, 10_000_000);
    assert_err(w.env.send_copier_ix("x", ix, None), CopierError::PlatformMintNotSet);
    assert_err(w.env.burn_platform(&platform_mint, available + 1), CopierError::ExceedsBurnPool);
    // Per call: at most max_impact_bps of the platform token's real SOL.
    let holder = w.env.user(10);
    ok(w.env.public_buy(&holder, &platform_mint, 3 * SOL));
    w.env.set_params(|p| p.max_impact_bps = 50);
    let cap = w.env.curve(&platform_mint).real_quote_reserves * 50 / 10_000;
    assert!(cap < available);
    assert_err(w.env.burn_platform(&platform_mint, cap + 1), CopierError::ExceedsImpact);

    let supply = w.env.mint_supply(&platform_mint);
    let pool_before = w.env.lamports(&burn_pool);
    ok(w.env.burn_platform(&platform_mint, cap));
    // At most one burn a minute.
    assert_err(w.env.burn_platform(&platform_mint, 1_000_000), CopierError::PlatformBurnTooSoon);
    let burned = supply - w.env.mint_supply(&platform_mint);
    let c = w.env.config();
    assert!(burned > 0);
    assert_eq!(c.platform_burned, burned);
    assert_eq!(c.platform_burn_spent, pool_before - w.env.lamports(&burn_pool));
    assert_eq!(w.env.coin_balance(&burn_pool, &platform_mint), 0);
    assert!(w.env.lamports(&burn_pool) >= w.env.rent0());

    // On the pool after the platform token graduates.
    let whale = w.env.user(300);
    w.env.graduate(&whale, &platform_mint);
    w.env.warp(60);
    // Another profitable copy refills the burn pool.
    w.env.set_params(|p| p.max_impact_bps = 300);
    assert!(round_trip(&mut w, 10 * SOL, 200_000_000, 40 * SOL) > 0);
    // The PDA also fronts the transient wSOL account and its first PumpSwap volume accumulator.
    let left = w.env.lamports(&burn_pool) - w.env.rent0() - RENT_ALLOWANCE_LAMPORTS;
    let supply = w.env.mint_supply(&platform_mint);
    ok(w.env.burn_platform(&platform_mint, left.min(100_000_000)));
    assert!(w.env.mint_supply(&platform_mint) < supply);
    assert!(!w.env.exists(&wsol_ata(&burn_pool)));
}

#[test]
fn copier_index_keeps_its_profit_share_for_its_own_buyback() {
    let mut env = Env::new();
    let admin = env.admin.insecure_clone();
    let target = env.user(200);
    let mint = env.launch_index(vec![target.pubkey()]);
    ok(env.set_platform_mint_as(&admin, mint));
    let seed = env.user(31);
    ok(env.deposit(&seed, &mint, 30 * SOL));
    let mut w = World { env, mint, target, coins: vec![] };
    let burn_pool_before = w.env.lamports(&burn_pool_pda());
    let pnl = round_trip(&mut w, 10 * SOL, 200_000_000, 40 * SOL);
    assert!(pnl > 0);
    let m = w.env.copier(&mint);
    assert_eq!(m.buyback_pool, pnl as u64, "100% of the platform token's profit buys back the platform token");
    assert_eq!(m.platform_sent, 0);
    assert_eq!(w.env.lamports(&burn_pool_pda()), burn_pool_before);
    let holder = w.env.user(10);
    ok(w.env.public_buy(&holder, &mint, 5 * SOL));
    let supply = w.env.mint_supply(&mint);
    ok(w.env.buyback_burn(&mint, 50_000_000));
    assert!(w.env.mint_supply(&mint) < supply);
    w.check();
}

#[test]
fn fund_platform_burn_moves_a_pending_share() {
    let mut w = profitable();
    let anyone = w.env.user(1);
    let burn_pool = burn_pool_pda();
    // Nothing pending: a no-op.
    let before = w.env.lamports(&burn_pool);
    ok(w.env.fund_platform_burn(&anyone, &w.mint));
    assert_eq!(w.env.lamports(&burn_pool), before);
    // A pending share (left by a sell whose vault couldn't pay it in lamports) moves on demand.
    let mint = w.mint;
    w.env.set_copier(&mint, |m| {
        m.platform_pending = 12_345_678;
        m.buyback_pool -= 12_345_678;
    });
    let sent = w.env.copier(&mint).platform_sent;
    ok(w.env.fund_platform_burn(&anyone, &mint));
    let m = w.env.copier(&mint);
    assert_eq!(m.platform_pending, 0);
    assert_eq!(m.platform_sent, sent + 12_345_678);
    assert_eq!(w.env.lamports(&burn_pool), before + 12_345_678);
    w.check();
}
