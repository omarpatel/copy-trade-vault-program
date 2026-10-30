//! copier_buy / copier_sell on the pump.fun bonding curve (v3 instructions): the copy, every
//! rejection, proportional sells, forced and permissionless exits, and the HWM profit split.

mod common;

use anchor_lang::error::ErrorCode as AnchorError;
use anchor_spl::associated_token::spl_associated_token_account::instruction::create_associated_token_account_idempotent;
use common::*;
use copy_vault::errors::CopierError;
use solana_sdk::signature::Signer;

#[test]
fn copy_buy_then_proportional_sells_on_the_curve() {
    let mut w = World::new(10);
    let coin = w.coin();
    w.target_buys(&coin, 2 * SOL);
    let target_after_buy = w.target_balance(&coin);
    let vault = vault_pda(&w.mint);
    let before = w.env.copier(&w.mint);
    let vault_before = w.env.lamports(&vault);

    ok(w.buy(&coin, 50_000_000));
    w.check();
    let m = w.env.copier(&w.mint);
    let p = w.env.position(&w.mint, &coin).unwrap();
    let spent = vault_before - w.env.lamports(&vault);
    assert!(spent >= 50_000_000 && spent < 50_000_000 + RENT_CAP, "spent {spent}");
    assert_eq!(p.cost, spent, "cost basis = everything the buy cost the vault (rent included)");
    assert_eq!(p.tokens, w.vault_tokens(&coin));
    assert!(p.tokens > 0);
    assert_eq!(p.target, w.target.pubkey());
    assert_eq!(p.target_snapshot, target_after_buy);
    assert_eq!(p.target_peak, target_after_buy);
    assert_eq!(p.vault_peak, p.tokens);
    assert_eq!(p.opened_at, w.env.now());
    assert_eq!(m.open_positions, 1);
    assert_eq!(m.target_positions[0], 1);
    assert_eq!(m.open_cost, spent);
    assert_eq!(m.trades, before.trades + 1);
    assert_eq!(m.last_keeper_ts, w.env.now());

    // A second target buy: the vault adds to its position; peaks reset.
    w.target_buys(&coin, SOL);
    let target_now = w.target_balance(&coin);
    ok(w.buy(&coin, 30_000_000));
    w.check();
    let p2 = w.env.position(&w.mint, &coin).unwrap();
    assert!(p2.tokens > p.tokens);
    assert!(p2.cost > p.cost + 30_000_000 - 1 && p2.cost < p.cost + 30_000_000 + 1_000, "no rent on a top-up");
    assert_eq!(p2.target_snapshot, target_now);
    assert_eq!(p2.target_peak, target_now);
    assert_eq!(p2.vault_peak, p2.tokens);
    assert_eq!(w.env.copier(&w.mint).open_positions, 1);

    // While the target holds, nothing may be sold.
    let tokens = p2.tokens;
    assert_err(w.sell(&coin, 1), CopierError::SellNotAllowed);

    // Target sells 40%: the vault may sell down to 60% of its peak, not one token more.
    w.target_sells(&coin, target_now * 2 / 5);
    let t_now = w.target_balance(&coin);
    let keep = (p2.vault_peak as u128 * t_now as u128 / p2.target_peak as u128) as u64;
    let allowed = tokens - keep;
    assert_err(w.sell(&coin, allowed + 1), CopierError::SellNotAllowed);
    let m_before = w.env.copier(&w.mint);
    let lamports_before = w.env.lamports(&vault);
    ok(w.sell(&coin, allowed));
    w.check();
    let p3 = w.env.position(&w.mint, &coin).unwrap();
    let m3 = w.env.copier(&w.mint);
    let proceeds = w.env.lamports(&vault) - lamports_before;
    let cost_removed = (p2.cost as u128 * allowed as u128).div_ceil(tokens as u128) as u64;
    assert_eq!(p3.tokens, keep);
    assert_eq!(p3.cost, p2.cost - cost_removed);
    assert_eq!(p3.target_snapshot, t_now);
    assert_eq!(p3.vault_peak, p2.vault_peak, "peaks stay until the next buy");
    assert_eq!(m3.realized_pnl - m_before.realized_pnl, proceeds as i64 - cost_removed as i64);
    assert_eq!(m3.open_cost, p3.cost);
    // Nothing more to sell until the target sells again.
    assert_err(w.sell(&coin, 1), CopierError::SellNotAllowed);

    // Target exits: the vault exits fully; position and token account close, rent comes back.
    let rest = w.target_balance(&coin);
    w.target_sells(&coin, rest);
    let position_rent = w.env.lamports(&position_pda(&w.mint, &coin));
    let ata_rent = w.env.lamports(&ata22(&vault, &coin));
    let m_before = w.env.copier(&w.mint);
    let lamports_before = w.env.lamports(&vault);
    ok(w.sell(&coin, keep));
    w.check();
    assert!(w.env.position(&w.mint, &coin).is_none());
    assert!(!w.env.exists(&position_pda(&w.mint, &coin)));
    assert!(!w.env.exists(&ata22(&vault, &coin)), "empty token account closed");
    let m4 = w.env.copier(&w.mint);
    let back = w.env.lamports(&vault) - lamports_before;
    assert!(back > position_rent + ata_rent);
    assert_eq!(m4.realized_pnl - m_before.realized_pnl, back as i64 - p3.cost as i64);
    assert_eq!(m4.open_positions, 0);
    assert_eq!(m4.target_positions[0], 0);
    assert_eq!(m4.open_cost, 0);
    assert_anchor_err(w.sell(&coin, 1), AnchorError::AccountNotInitialized);
}

/// Upper bound of the rent a first buy pays (UVA + token account + position).
const RENT_CAP: u64 = 10_000_000;


#[test]
fn copier_buy_rejections() {
    let mut w = World::new(10);
    let coin = w.coin();
    let other = w.coin();
    w.target_buys(&coin, 2 * SOL);
    let (mint, target) = (w.mint, w.target.pubkey());
    let vault = vault_pda(&mint);
    let keeper = w.env.keeper.pubkey();

    // Not the keeper.
    let stranger = w.env.user(2);
    let mut ix = w.buy_ix(&coin, 50_000_000);
    ix.accounts[0].pubkey = stranger.pubkey();
    assert_err(w.env.send(&[ix], &[&stranger]), CopierError::NotKeeper);

    // Account roles inside the forwarded venue instruction.
    let tamper = |w: &World, f: &dyn Fn(&mut solana_sdk::instruction::Instruction)| {
        let (d, mut venue) = w.env.venue_buy_ix(&vault, &coin, 50_000_000);
        f(&mut venue);
        w.env.copier_buy_ix_with(&keeper, &mint, 0, &target, &coin, d, 50_000_000, 0, venue)
    };
    // The vault anywhere besides user_idx (here as the buyback recipient).
    let ix = tamper(&w, &|v| v.accounts[13].pubkey = vault);
    assert_err(w.env.send_copier_ix("x", ix, None), CopierError::UserElsewhere);
    // Someone else as the venue user.
    let ix = tamper(&w, &|v| v.accounts[8].pubkey = keeper);
    assert_err(w.env.send_copier_ix("x", ix, None), CopierError::UserMismatch);
    // A different mint at base_mint_idx / another coin's curve as the venue.
    let ix = tamper(&w, &|v| v.accounts[1].pubkey = other);
    assert_err(w.env.send_copier_ix("x", ix, None), CopierError::MintMismatch);
    let ix = tamper(&w, &|v| v.accounts[5].pubkey = bonding_curve_pda(&other));
    assert_err(w.env.send_copier_ix("x", ix, None), CopierError::VenueMismatch);
    // Fewer accounts than the descriptor needs.
    let ix = tamper(&w, &|v| {
        v.accounts.truncate(16);
    });
    assert_err(w.env.send_copier_ix("x", ix, None), CopierError::NotEnoughAccounts);
    // Data that is not the descriptor's instruction (buy_v2 data under the v3 descriptor) and a
    // descriptor of the wrong side.
    let ix = tamper(&w, &|v| v.data[..8].copy_from_slice(&copy_vault::pump::IX_BUY_V2));
    assert_err(w.env.send_copier_ix("x", ix, None), CopierError::DiscriminatorMismatch);
    let (_, venue) = w.env.venue_buy_ix(&vault, &coin, 50_000_000);
    let ix = w.env.copier_buy_ix_with(&keeper, &mint, 0, &target, &coin, 1, 50_000_000, 0, venue.clone());
    assert_err(w.env.send_copier_ix("x", ix, None), CopierError::DescriptorSide);
    let ix = w.env.copier_buy_ix_with(&keeper, &mint, 0, &target, &coin, 10, 50_000_000, 0, venue.clone());
    assert_err(w.env.send_copier_ix("x", ix, None), CopierError::DescriptorIndex);
    // A non-whitelisted instruction: drop the v3 buys from the whitelist, the same data fails.
    let mut delisted = copy_vault::state::default_descriptors();
    delisted[2].disc = [9; 8];
    w.env.set_descriptors(delisted);
    let (_, venue) = w.env.venue_buy_ix(&vault, &coin, 50_000_000);
    let ix = w.env.copier_buy_ix_with(&keeper, &mint, 0, &target, &coin, 2, 50_000_000, 0, venue.clone());
    assert_err(w.env.send_copier_ix("x", ix, None), CopierError::DiscriminatorMismatch);
    w.env.set_descriptors(copy_vault::state::default_descriptors());
    // A writable vault-owned token account of another mint among the venue accounts.
    let foreign = ata22(&vault, &other);
    let payer = w.env.user(1);
    ok(w.env.send(
        &[create_associated_token_account_idempotent(&payer.pubkey(), &vault, &other, &TOKEN_2022_ID)],
        &[&payer],
    ));
    let ix = tamper(&w, &|v| v.accounts[10].pubkey = foreign);
    assert_err(w.env.send_copier_ix("x", ix, None), CopierError::ForeignVaultTokenAccount);

    // Wrong target / target index / target token account.
    let ix = w.env.copier_buy_ix(&mint, 1, &target, &coin, 50_000_000);
    assert_err(w.env.send_copier_ix("x", ix, None), CopierError::TargetIndex);
    let ix = w.env.copier_buy_ix(&mint, 0, &stranger.pubkey(), &coin, 50_000_000);
    assert_err(w.env.send_copier_ix("x", ix, None), CopierError::TargetMismatch);
    let mut ix = w.buy_ix(&coin, 50_000_000);
    ix.accounts[7].pubkey = ata22(&stranger.pubkey(), &coin);
    assert_err(w.env.send_copier_ix("x", ix, None), CopierError::TargetTokenAccount);
    // Another coin's position account.
    let mut ix = w.buy_ix(&coin, 50_000_000);
    ix.accounts[5].pubkey = position_pda(&mint, &other);
    assert_err(w.env.send_copier_ix("x", ix, None), CopierError::PositionInvalid);

    // The copier's own coin.
    w.env.public_buy(&w.target.insecure_clone(), &mint, SOL).unwrap();
    let ix = w.env.copier_buy_ix(&mint, 0, &target, &mint, 20_000_000);
    assert_err(w.env.send_copier_ix("x", ix, None), CopierError::OwnMint);

    // Sizing: below the minimum, above the signal, above the trade cap, above impact.
    assert_err(w.buy(&coin, 9_999_999), CopierError::TradeTooSmall);
    assert_err(w.buy(&coin, 100_000_000), CopierError::ExceedsImpact);
    w.env.set_params(|p| p.max_impact_bps = 1_000);
    let big = w.coin();
    w.target_buys(&big, 30 * SOL);
    assert_err(w.buy(&big, 1_100 * SOL / 1_000), CopierError::ExceedsTradeCap);
    w.env.set_params(|p| p.max_position_bps = 500);
    assert_err(w.buy(&big, 600_000_000), CopierError::ExceedsPositionCap);
    let small = w.coin();
    w.target_buys(&small, 60_000_000);
    assert_err(w.buy(&small, 70_000_000), CopierError::ExceedsSignal);

    // Slippage: the keeper's min_out, and the program's own floor (95% of the fee-free quote):
    // a venue charging 6.3% fails it whatever min_out the keeper sends.
    let (d, venue) = w.env.venue_buy_ix(&vault, &coin, 50_000_000);
    let ix = w.env.copier_buy_ix_with(&keeper, &mint, 0, &target, &coin, d, 50_000_000, u64::MAX, venue);
    assert_err(w.env.send_copier_ix("x", ix, None), CopierError::SlippageTokens);
    let fees = w.env.set_pump_protocol_fee_bps(600);
    assert_err(w.buy(&coin, 50_000_000), CopierError::SlippageTokens);
    w.env.restore_pump_fee_config(fees);

    // Signal: an airdrop-sized increase is not a buy; no increase at all is nothing to copy.
    let airdrop_coin = w.coin();
    let holder = w.env.user(5);
    ok(w.env.public_buy(&holder, &airdrop_coin, SOL));
    let tiny = w.env.coin_balance(&holder.pubkey(), &airdrop_coin) / 100;
    ok(w.env.send(
        &[
            create_associated_token_account_idempotent(&holder.pubkey(), &target, &airdrop_coin, &TOKEN_2022_ID),
            anchor_spl::token_2022::spl_token_2022::instruction::transfer_checked(
                &TOKEN_2022_ID,
                &ata22(&holder.pubkey(), &airdrop_coin),
                &airdrop_coin,
                &ata22(&target, &airdrop_coin),
                &holder.pubkey(),
                &[],
                tiny,
                6,
            )
            .unwrap(),
        ],
        &[&holder],
    ));
    assert_err(w.buy(&airdrop_coin, 10_000_000), CopierError::SignalTooSmall);
    let quiet = w.coin();
    assert_err(w.buy(&quiet, 10_000_000), CopierError::NoTargetIncrease);
    ok(w.buy(&coin, 50_000_000));
    w.check();
    assert_err(w.buy(&coin, 50_000_000), CopierError::NoTargetIncrease);

    // Position count cap.
    w.env.set_params(|p| p.max_open_positions = 1);
    let second = w.coin();
    w.target_buys(&second, 2 * SOL);
    assert_err(w.buy(&second, 50_000_000), CopierError::TooManyPositions);
    w.env.set_params(|p| p.max_open_positions = 12);
    ok(w.buy(&second, 50_000_000));
    w.check();

}

#[test]
fn buys_never_spend_below_the_vault_floor() {
    let mut w = World::new(1);
    let mint = w.mint;
    let free = {
        let m = w.env.copier(&mint);
        m.accounted_lamports - w.env.rent0() - m.buyback_pool - m.platform_pending
    };
    w.env.set_params(|p| p.vault_floor_lamports = free - 40_000_000);
    let coin = w.coin();
    w.target_buys(&coin, 2 * SOL);
    assert_err(w.buy(&coin, 50_000_000), CopierError::BelowVaultFloor);
    ok(w.buy(&coin, 30_000_000));
    w.check();
}

#[test]
fn copier_sell_rejections() {
    let mut w = World::new(10);
    let coin = w.coin();
    w.target_buys(&coin, 2 * SOL);
    ok(w.buy(&coin, 50_000_000));
    let tokens = w.env.position(&w.mint, &coin).unwrap().tokens;
    let all = w.target_balance(&coin);
    w.target_sells(&coin, all);
    let (mint, target) = (w.mint, w.target.pubkey());
    let vault = vault_pda(&mint);
    let keeper = w.env.keeper.pubkey();

    // Data selling fewer tokens than declared, a buy descriptor, the keeper's min_sol_out, the
    // program floor.
    let (d, venue) = w.env.venue_sell_ix(&vault, &coin, tokens - 1);
    let ix = w.env.copier_sell_ix_with(&keeper, &mint, 0, &target, &coin, d, tokens, 0, venue);
    assert_err(w.env.send_copier_ix("x", ix, None), CopierError::SellAmountMismatch);
    let (_, venue) = w.env.venue_sell_ix(&vault, &coin, tokens);
    let ix = w.env.copier_sell_ix_with(&keeper, &mint, 0, &target, &coin, 2, tokens, 0, venue.clone());
    assert_err(w.env.send_copier_ix("x", ix, None), CopierError::DescriptorSide);
    let ix = w.env.copier_sell_ix_with(&keeper, &mint, 0, &target, &coin, 1, tokens, u64::MAX, venue.clone());
    assert_err(w.env.send_copier_ix("x", ix, None), CopierError::SlippageSol);
    let fees = w.env.set_pump_protocol_fee_bps(600);
    assert_err(w.sell(&coin, tokens), CopierError::SlippageSol);
    w.env.restore_pump_fee_config(fees);
    // The vault elsewhere among the venue accounts.
    let mut venue2 = venue.clone();
    venue2.accounts[13].pubkey = vault;
    let ix = w.env.copier_sell_ix_with(&keeper, &mint, 0, &target, &coin, 1, tokens, 0, venue2);
    assert_err(w.env.send_copier_ix("x", ix, None), CopierError::UserElsewhere);
    // More than the position, zero, a coin without a position.
    assert_err(w.sell(&coin, tokens + 1), CopierError::SellNotAllowed);
    assert_err(w.sell(&coin, 0), CopierError::ZeroAmount);
    let other = w.coin();
    let ix = w.env.copier_sell_ix(&keeper, &mint, 0, &target, &other, 1);
    assert_anchor_err(w.env.send_copier_ix("x", ix, None), AnchorError::AccountNotInitialized);
    ok(w.sell(&coin, tokens));
    w.check();
}

#[test]
fn forced_exit_after_max_hold() {
    let mut w = World::new(10);
    let coin = w.coin();
    w.target_buys(&coin, 2 * SOL);
    ok(w.buy(&coin, 50_000_000));
    let tokens = w.env.position(&w.mint, &coin).unwrap().tokens;
    // The target keeps holding: no exit before max_hold ...
    w.env.warp(604_800);
    assert_err(w.sell(&coin, tokens), CopierError::SellNotAllowed);
    // ... then the keeper may exit everything regardless of the target.
    w.env.warp(1);
    let realized = w.env.copier(&w.mint).realized_pnl;
    ok(w.sell(&coin, tokens));
    w.check();
    assert!(w.env.position(&w.mint, &coin).is_none());
    assert!(w.target_balance(&coin) > 0);
    assert_ne!(w.env.copier(&w.mint).realized_pnl, realized);
}

#[test]
fn permissionless_exit_needs_a_dead_keeper_and_a_flat_target_and_goes_in_slices() {
    let mut w = World::new(10);
    let coin = w.coin();
    // Other holders keep the curve's real reserves up (what the slice cap is measured against).
    let holder = w.env.user(10);
    ok(w.env.public_buy(&holder, &coin, 3 * SOL));
    w.target_buys(&coin, 2 * SOL);
    ok(w.buy(&coin, 50_000_000));
    let tokens = w.env.position(&w.mint, &coin).unwrap().tokens;
    let (mint, target) = (w.mint, w.target.pubkey());
    let anyone = w.env.user(1);
    let grace = w.env.config().params.keeper_grace_secs;
    let keeper = w.env.keeper.insecure_clone();

    // Keeper silent past the grace, but the target still holds: not permitted.
    w.env.warp(grace + 1);
    let ix = w.env.copier_sell_ix(&anyone.pubkey(), &mint, 0, &target, &coin, tokens);
    assert_err(w.env.send_copier_ix("x", ix, Some(&anyone)), CopierError::SellNotPermitted);

    // Target flat, this copier quiet for longer than the grace, but the keeper is alive (a
    // heartbeat, or any keeper action on any copier): not permitted.
    let all = w.target_balance(&coin);
    w.target_sells(&coin, all);
    ok(w.env.keeper_heartbeat_as(&keeper));
    let ix = w.env.copier_sell_ix(&anyone.pubkey(), &mint, 0, &target, &coin, tokens);
    assert_err(w.env.send_copier_ix("x", ix, Some(&anyone)), CopierError::SellNotPermitted);

    // Keeper dead and target flat: anyone unwinds, but only in slices worth ≤ max_impact_bps of
    // the curve's real SOL, one per slot.
    w.env.set_params(|p| p.max_impact_bps = 50);
    w.env.warp(grace + 1);
    let ix = w.env.copier_sell_ix(&anyone.pubkey(), &mint, 0, &target, &coin, tokens);
    assert_err(w.env.send_copier_ix("x", ix, Some(&anyone)), CopierError::ExceedsImpact);
    let keeper_ts = w.env.copier(&mint).last_keeper_ts;
    let mut slices = 0;
    while let Some(p) = w.env.position(&mint, &coin) {
        let c = w.env.curve(&coin);
        let cap = c.real_quote_reserves as u128 * 50 / 10_000;
        // Largest n with vQ·n / (vT + n) ≤ cap, minus a margin.
        let max_n = cap * c.virtual_token_reserves as u128 / (c.virtual_quote_reserves as u128 - cap);
        let n = (max_n as u64 * 9 / 10).min(p.tokens);
        let ix = w.env.copier_sell_ix(&anyone.pubkey(), &mint, 0, &target, &coin, n);
        ok(w.env.send_copier_ix("copier_sell (permissionless slice)", ix, Some(&anyone)));
        w.check();
        slices += 1;
        if w.env.position(&mint, &coin).is_some() {
            // A second slice in the same slot is refused.
            w.env.rewind_slot();
            let ix = w.env.copier_sell_ix(&anyone.pubkey(), &mint, 0, &target, &coin, 1);
            assert_err(w.env.send_copier_ix("x", ix, Some(&anyone)), CopierError::PublicSellRateLimited);
        }
    }
    assert!(slices > 1, "the exit took {slices} slices");
    assert_eq!(w.env.coin_balance(&vault_pda(&mint), &coin), 0);
    assert_eq!(w.env.copier(&mint).last_keeper_ts, keeper_ts, "a non-keeper exit is not keeper activity");
    let _ = tokens;
}

#[test]
fn prefunded_position_account_is_booked_as_income() {
    let mut w = World::new(10);
    let coin = w.coin();
    w.target_buys(&coin, 2 * SOL);
    let position = position_pda(&w.mint, &coin);
    let donor = w.env.user(2);
    ok(w.env.send(&[solana_sdk::system_instruction::transfer(&donor.pubkey(), &position, SOL)], &[&donor]));
    let fees_before = w.env.copier(&w.mint).fees_in;
    let vault_before = w.env.lamports(&vault_pda(&w.mint));
    ok(w.buy(&coin, 50_000_000));
    w.check();
    let rent = w.env.svm.minimum_balance_for_rent_exemption(copy_vault::state::Position::SPACE);
    let m = w.env.copier(&w.mint);
    assert_eq!(m.fees_in - fees_before, SOL - rent, "the donation above rent is income");
    assert_eq!(w.env.lamports(&position), rent);
    let p = w.env.position(&w.mint, &coin).unwrap();
    // The vault paid the venue (and the token account / volume accumulator rent), not the
    // position's rent; the cost basis is what it really spent.
    assert_eq!(p.cost, vault_before + (SOL - rent) - w.env.lamports(&vault_pda(&w.mint)));
}

#[test]
fn high_water_mark_split_loss_then_win() {
    let mut w = World::new(10);
    let burn_pool = burn_pool_pda();

    // Loss: target in and out, the vault pays fees and impact both ways.
    let loss = round_trip(&mut w, 2 * SOL, 50_000_000, 0);
    assert!(loss < 0, "round trip without a price move loses: {loss}");
    let m = w.env.copier(&w.mint);
    assert_eq!(m.realized_pnl, loss);
    assert_eq!(m.hwm, 0);
    assert_eq!((m.buyback_pool, m.platform_sent, m.platform_pending), (0, 0, 0));

    // Win: a whale pumps the coin between the vault's entry and exit.
    let pool_before = w.env.lamports(&burn_pool);
    let win = round_trip(&mut w, 2 * SOL, 50_000_000, 30 * SOL);
    assert!(win > -loss, "the win more than recovers the loss: {win} vs {loss}");
    let m = w.env.copier(&w.mint);
    let excess = (loss + win) as u64; // realized − previous HWM (0)
    let to_buyback = excess * 7_500 / 10_000;
    let to_platform = excess - to_buyback;
    assert_eq!(m.realized_pnl, loss + win);
    assert_eq!(m.hwm, m.realized_pnl);
    assert_eq!(m.buyback_pool, to_buyback, "75% of profit above the HWM");
    assert_eq!(m.platform_sent, to_platform, "25% of it");
    assert_eq!(m.platform_pending, 0, "moved inline");
    assert_eq!(w.env.lamports(&burn_pool) - pool_before, to_platform, "burn pool received it");

    // Another loss: below the HWM nothing is split; recovering up to the HWM splits nothing.
    let hwm = m.hwm;
    let loss2 = round_trip(&mut w, 2 * SOL, 50_000_000, 0);
    let m2 = w.env.copier(&w.mint);
    assert_eq!(m2.hwm, hwm);
    assert_eq!(m2.realized_pnl, hwm + loss2);
    assert_eq!(m2.buyback_pool, to_buyback);
    assert_eq!(m2.platform_sent, to_platform);

    // A win past the HWM splits only the part above it.
    let win2 = round_trip(&mut w, 2 * SOL, 50_000_000, 30 * SOL);
    let m3 = w.env.copier(&w.mint);
    let excess2 = (m3.realized_pnl - hwm) as u64;
    assert_eq!(m3.realized_pnl, hwm + loss2 + win2);
    assert_eq!(m3.hwm, m3.realized_pnl);
    let b2 = excess2 * 7_500 / 10_000;
    assert_eq!(m3.buyback_pool, to_buyback + b2);
    assert_eq!(m3.platform_sent, to_platform + (excess2 - b2));
}

#[test]
fn index_copier_positions_belong_to_their_target() {
    let mut env = Env::new();
    let t0 = env.user(50);
    let t1 = env.user(50);
    let mint = env.launch_index(vec![t0.pubkey(), t1.pubkey()]);
    let backer = env.user(11);
    ok(env.deposit(&backer, &mint, 10 * SOL));
    let creator = env.user(1);
    let coin = env.create_coin(&creator);
    ok(env.public_buy(&t0, &coin, 2 * SOL));
    ok(env.copier_buy(&mint, 0, &t0.pubkey(), &coin, 50_000_000));
    assert_eq!(env.copier(&mint).target_positions[..2], [1, 0]);
    ok(env.public_buy(&t1, &coin, 2 * SOL));
    let ix = env.copier_buy_ix(&mint, 1, &t1.pubkey(), &coin, 50_000_000);
    assert_err(env.send_copier_ix("x", ix, None), CopierError::PositionTargetMismatch);
    env.assert_invariants(&mint, &[coin]);

    // A target with an open position can't be dropped from the basket; one without can.
    assert_err(env.set_index_targets(&mint, vec![t1.pubkey()]), CopierError::TargetHasOpenPositions);
    // The refused change stays queued until the admin cancels it.
    let admin = env.admin.insecure_clone();
    let stuck = env.config().next_change_id - 1;
    assert!(env.pending(stuck).is_some());
    ok(env.cancel_pending_as(&admin, stuck));
    ok(env.set_index_targets(&mint, vec![t0.pubkey()]));
    // The position's counter follows its target to its new index.
    ok(env.set_index_targets(&mint, vec![t1.pubkey(), t0.pubkey()]));
    assert_eq!(env.copier(&mint).target_positions[..2], [0, 1]);
    let tokens = env.position(&mint, &coin).unwrap().tokens;
    let all = env.coin_balance(&t0.pubkey(), &coin);
    ok(env.public_sell(&t0, &coin, all));
    ok(env.copier_sell(&mint, 1, &t0.pubkey(), &coin, tokens));
    env.assert_invariants(&mint, &[coin]);
}

#[test]
fn a_new_exit_descriptor_counts_once_it_has_sold() {
    let mut w = World::new(10);
    let d = copy_vault::state::default_descriptors();
    // sell_v3 again, but accepting 16+ accounts: a different descriptor, not yet proven.
    let mut alt_sell = d[1];
    alt_sell.min_accounts = 16;
    w.env.set_descriptors([d.clone(), vec![alt_sell]].concat());
    assert_eq!(w.env.config().descriptors_proven & (1 << 10), 0);
    let admin = w.env.admin.insecure_clone();
    let only_alt = vec![d[0], alt_sell, d[6], d[7]];
    assert_err(w.env.propose_descriptors_as(&admin, only_alt.clone()).1, CopierError::DescriptorsDropProvenExit);

    // A real exit through it proves it.
    let coin = w.coin();
    w.target_buys(&coin, 2 * SOL);
    ok(w.buy(&coin, 50_000_000));
    let all = w.target_balance(&coin);
    w.target_sells(&coin, all);
    let (mint, target, keeper) = (w.mint, w.target.pubkey(), w.env.keeper.pubkey());
    let tokens = w.env.position(&mint, &coin).unwrap().tokens;
    let (_, venue) = w.env.venue_sell_ix(&vault_pda(&mint), &coin, tokens);
    let ix = w.env.copier_sell_ix_with(&keeper, &mint, 0, &target, &coin, 10, tokens, 0, venue);
    ok(w.env.send_copier_ix("x", ix, None));
    w.check();
    assert_ne!(w.env.config().descriptors_proven & (1 << 10), 0);
    // Now the old curve exits may be retired in its favour.
    w.env.set_descriptors(only_alt.clone());
    assert_eq!(w.env.config().descriptors, only_alt);
    assert_eq!(w.env.config().descriptors_proven, 0b1111);
}
