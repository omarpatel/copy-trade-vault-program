//! Config administration: initialization, two-sided parameter ranges, the venue whitelist, the
//! timelock on every power-granting change, the instant keeper pause, the keeper heartbeat and
//! the timelocked admin handover.

mod common;

use common::*;
use copy_vault::constants::*;
use copy_vault::errors::CopierError;
use copy_vault::state::{default_descriptors, ChangeKind, Params, Side, TradeDescriptor, Venue};
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::{Keypair, Signer};

#[test]
fn initialize_config_only_by_upgrade_authority_once_with_a_bounded_timelock() {
    let mut env = Env::bare();
    let stranger = env.user(10);
    let keeper = env.keeper.pubkey();
    assert_err(env.initialize_config(&stranger, keeper, TIMELOCK), CopierError::NotUpgradeAuthority);
    let admin = env.admin.insecure_clone();
    assert_err(env.initialize_config(&admin, keeper, MIN_TIMELOCK_SECS - 1), CopierError::TimelockOutOfRange);
    assert_err(env.initialize_config(&admin, keeper, MAX_TIMELOCK_SECS + 1), CopierError::TimelockOutOfRange);
    ok(env.initialize_config(&admin, keeper, MAX_TIMELOCK_SECS));
    let c = env.config();
    assert_eq!(c.admin, admin.pubkey());
    assert_eq!(c.keeper, keeper, "initial keeper applies immediately");
    assert_eq!(c.timelock_secs, MAX_TIMELOCK_SECS);
    assert_eq!(c.platform_mint, Pubkey::default());
    assert_eq!(c.params, Params::default());
    assert_eq!(c.descriptors, default_descriptors());
    assert_eq!(c.descriptors.len(), 10);
    assert_eq!(c.next_change_id, 0);
    assert_eq!(c.keeper_heartbeat_ts, env.now());
    assert_eq!(env.lamports(&burn_pool_pda()), env.rent0(), "burn pool funded to rent");
    assert_failed(env.initialize_config(&admin, keeper, TIMELOCK));
}

#[test]
fn every_param_has_a_two_sided_range() {
    let mut env = Env::new();
    let admin = env.admin.insecure_clone();
    type Set = Box<dyn Fn(&mut Params, bool)>;
    // (name, set(params, at_low_bound) to the bound, set just outside it)
    let cases: Vec<(&str, Set, Set)> = vec![
        (
            "max_trade_bps",
            Box::new(|p, lo| p.max_trade_bps = if lo { RANGE_MAX_TRADE_BPS.0 } else { RANGE_MAX_TRADE_BPS.1 }),
            Box::new(|p, lo| p.max_trade_bps = if lo { RANGE_MAX_TRADE_BPS.0 - 1 } else { RANGE_MAX_TRADE_BPS.1 + 1 }),
        ),
        (
            "max_position_bps",
            Box::new(|p, lo| p.max_position_bps = if lo { RANGE_MAX_POSITION_BPS.0 } else { RANGE_MAX_POSITION_BPS.1 }),
            Box::new(|p, lo| {
                p.max_position_bps = if lo { RANGE_MAX_POSITION_BPS.0 - 1 } else { RANGE_MAX_POSITION_BPS.1 + 1 }
            }),
        ),
        (
            "max_open_positions",
            Box::new(|p, lo| {
                p.max_open_positions = if lo { RANGE_MAX_OPEN_POSITIONS.0 } else { RANGE_MAX_OPEN_POSITIONS.1 }
            }),
            Box::new(|p, lo| {
                p.max_open_positions = if lo { RANGE_MAX_OPEN_POSITIONS.0 - 1 } else { RANGE_MAX_OPEN_POSITIONS.1 + 1 }
            }),
        ),
        (
            "min_trade_lamports",
            Box::new(|p, lo| {
                p.min_trade_lamports = if lo { RANGE_MIN_TRADE_LAMPORTS.0 } else { RANGE_MIN_TRADE_LAMPORTS.1 }
            }),
            Box::new(|p, lo| {
                p.min_trade_lamports = if lo { RANGE_MIN_TRADE_LAMPORTS.0 - 1 } else { RANGE_MIN_TRADE_LAMPORTS.1 + 1 }
            }),
        ),
        (
            "min_signal_lamports",
            Box::new(|p, lo| {
                p.min_signal_lamports = if lo { RANGE_MIN_SIGNAL_LAMPORTS.0 } else { RANGE_MIN_SIGNAL_LAMPORTS.1 }
            }),
            Box::new(|p, lo| {
                p.min_signal_lamports =
                    if lo { RANGE_MIN_SIGNAL_LAMPORTS.0 - 1 } else { RANGE_MIN_SIGNAL_LAMPORTS.1 + 1 }
            }),
        ),
        (
            "signal_multiple_bps",
            Box::new(|p, lo| {
                p.signal_multiple_bps = if lo { RANGE_SIGNAL_MULTIPLE_BPS.0 } else { RANGE_SIGNAL_MULTIPLE_BPS.1 }
            }),
            Box::new(|p, lo| {
                p.signal_multiple_bps =
                    if lo { RANGE_SIGNAL_MULTIPLE_BPS.0 - 1 } else { RANGE_SIGNAL_MULTIPLE_BPS.1 + 1 }
            }),
        ),
        (
            "max_impact_bps",
            Box::new(|p, lo| p.max_impact_bps = if lo { RANGE_MAX_IMPACT_BPS.0 } else { RANGE_MAX_IMPACT_BPS.1 }),
            Box::new(|p, lo| p.max_impact_bps = if lo { RANGE_MAX_IMPACT_BPS.0 - 1 } else { RANGE_MAX_IMPACT_BPS.1 + 1 }),
        ),
        (
            "slippage_bps",
            Box::new(|p, lo| p.slippage_bps = if lo { RANGE_SLIPPAGE_BPS.0 } else { RANGE_SLIPPAGE_BPS.1 }),
            Box::new(|p, lo| p.slippage_bps = if lo { RANGE_SLIPPAGE_BPS.0 - 1 } else { RANGE_SLIPPAGE_BPS.1 + 1 }),
        ),
        (
            "vault_floor_lamports",
            Box::new(|p, lo| {
                p.vault_floor_lamports = if lo { RANGE_VAULT_FLOOR_LAMPORTS.0 } else { RANGE_VAULT_FLOOR_LAMPORTS.1 }
            }),
            Box::new(|p, lo| {
                p.vault_floor_lamports =
                    if lo { RANGE_VAULT_FLOOR_LAMPORTS.0 - 1 } else { RANGE_VAULT_FLOOR_LAMPORTS.1 + 1 }
            }),
        ),
        (
            "max_hold_secs",
            Box::new(|p, lo| p.max_hold_secs = if lo { RANGE_MAX_HOLD_SECS.0 } else { RANGE_MAX_HOLD_SECS.1 }),
            Box::new(|p, lo| p.max_hold_secs = if lo { RANGE_MAX_HOLD_SECS.0 - 1 } else { RANGE_MAX_HOLD_SECS.1 + 1 }),
        ),
        (
            "keeper_grace_secs",
            Box::new(|p, lo| p.keeper_grace_secs = if lo { RANGE_KEEPER_GRACE_SECS.0 } else { RANGE_KEEPER_GRACE_SECS.1 }),
            Box::new(|p, lo| {
                p.keeper_grace_secs = if lo { RANGE_KEEPER_GRACE_SECS.0 - 1 } else { RANGE_KEEPER_GRACE_SECS.1 + 1 }
            }),
        ),
        (
            "spend_window_secs",
            Box::new(|p, lo| p.spend_window_secs = if lo { RANGE_SPEND_WINDOW_SECS.0 } else { RANGE_SPEND_WINDOW_SECS.1 }),
            Box::new(|p, lo| {
                p.spend_window_secs = if lo { RANGE_SPEND_WINDOW_SECS.0 - 1 } else { RANGE_SPEND_WINDOW_SECS.1 + 1 }
            }),
        ),
        (
            "max_window_spend_bps",
            Box::new(|p, lo| {
                p.max_window_spend_bps = if lo { RANGE_MAX_WINDOW_SPEND_BPS.0 } else { RANGE_MAX_WINDOW_SPEND_BPS.1 }
            }),
            Box::new(|p, lo| {
                p.max_window_spend_bps =
                    if lo { RANGE_MAX_WINDOW_SPEND_BPS.0 - 1 } else { RANGE_MAX_WINDOW_SPEND_BPS.1 + 1 }
            }),
        ),
    ];
    let base = env.config().params;
    for (name, at, outside) in &cases {
        for lo in [true, false] {
            let mut bad = base;
            outside(&mut bad, lo);
            assert_err(env.propose_params_as(&admin, bad).1, CopierError::ParamOutOfRange);
            let mut good = base;
            at(&mut good, lo);
            let (_, res) = env.propose_params_as(&admin, good);
            assert!(res.is_ok(), "{name} at its {} bound is valid", if lo { "lower" } else { "upper" });
        }
    }
    // The defaults themselves are inside every range.
    Params::default().validate().unwrap();
}

#[test]
fn param_changes_wait_for_the_timelock_and_can_be_cancelled() {
    let mut env = Env::new();
    let admin = env.admin.insecure_clone();
    let stranger = env.user(5);
    let mut p = env.config().params;
    p.max_trade_bps = 2_500;

    assert_err(env.propose_params_as(&stranger, p).1, CopierError::NotAdmin);
    let admin_before = env.lamports(&admin.pubkey());
    let (id, res) = env.propose_params_as(&admin, p);
    ok(res);
    let pending = env.pending(id).unwrap();
    assert_eq!(pending.kind, ChangeKind::Params);
    assert_eq!(pending.eta, env.now() + TIMELOCK);
    assert_eq!(pending.proposer, admin.pubkey());
    assert_eq!(env.config().next_change_id, id + 1);
    assert_eq!(env.config().params, Params::default(), "nothing applies at proposal");

    // Not before eta, by anyone.
    env.warp(TIMELOCK - 1);
    assert_err(env.execute_pending(&stranger, id), CopierError::TimelockNotElapsed);
    env.warp(1);
    ok(env.execute_pending(&stranger, id));
    assert_eq!(env.config().params, p);
    assert!(env.pending(id).is_none());
    assert_eq!(env.lamports(&admin.pubkey()), admin_before - 5_000, "pending rent refunded to the proposer");

    // Cancel: admin only, before execution; the change never applies.
    let mut q = p;
    q.max_trade_bps = 1;
    let (id2, res) = env.propose_params_as(&admin, q);
    ok(res);
    assert_err(env.cancel_pending_as(&stranger, id2), CopierError::NotAdmin);
    ok(env.cancel_pending_as(&admin, id2));
    assert!(env.pending(id2).is_none());
    env.warp(TIMELOCK);
    assert_eq!(env.config().params, p);

    // Several changes may be queued and execute independently.
    let (a, r1) = env.propose_params_as(&admin, Params::default());
    ok(r1);
    let k = Keypair::new().pubkey();
    let (b, r2) = env.propose_keeper_as(&admin, k);
    ok(r2);
    env.warp(TIMELOCK);
    ok(env.execute_pending(&stranger, b));
    ok(env.execute_pending(&stranger, a));
    let c = env.config();
    assert_eq!((c.keeper, c.params), (k, Params::default()));
    assert_eq!(c.keeper_heartbeat_ts, env.now(), "a new keeper starts with a fresh heartbeat");
}

#[test]
fn descriptor_whitelist_rules_and_timelock() {
    let mut env = Env::new();
    let admin = env.admin.insecure_clone();
    let d = default_descriptors();
    let forbidden = [
        [214, 144, 76, 236, 95, 139, 49, 180],   // create_v2
        [234, 102, 194, 203, 150, 72, 62, 229],  // extend_account
        [94, 6, 202, 115, 255, 96, 232, 183],    // init_user_volume_accumulator
        [155, 234, 231, 146, 236, 158, 162, 30], // migrate
        [242, 35, 198, 137, 82, 225, 242, 182],  // deposit (AMM)
        [183, 18, 70, 156, 148, 109, 161, 34],   // withdraw (AMM)
        [233, 146, 209, 142, 207, 104, 64, 188], // create_pool
        [32, 246, 191, 52, 8, 201, 73, 186],     // sweep_creator_fee
    ];
    for disc in forbidden {
        let mut bad = d.clone();
        bad[0].disc = disc;
        assert_err(env.propose_descriptors_as(&admin, bad).1, CopierError::DescriptorDiscForbidden);
    }
    let mut bad = d.clone();
    bad[0].program = TOKEN_ID;
    assert_err(env.propose_descriptors_as(&admin, bad).1, CopierError::DescriptorProgramNotAllowed);
    let mut bad = d.clone();
    bad[0].venue = Venue::Pool; // pump program with a pool venue
    assert_err(env.propose_descriptors_as(&admin, bad).1, CopierError::DescriptorProgramNotAllowed);
    let mut bad = d.clone();
    bad[0].user_idx = 17; // ≥ min_accounts
    assert_err(env.propose_descriptors_as(&admin, bad).1, CopierError::DescriptorIndices);
    let mut bad = d.clone();
    bad[0].base_mint_idx = bad[0].user_idx;
    assert_err(env.propose_descriptors_as(&admin, bad).1, CopierError::DescriptorIndices);
    let mut bad = d.clone();
    bad[1].min_accounts = MAX_DESCRIPTOR_ACCOUNTS + 1;
    assert_err(env.propose_descriptors_as(&admin, bad).1, CopierError::DescriptorIndices);
    let too_many = [d.clone(), d.clone(), d.clone(), d[..3].to_vec()].concat();
    assert_eq!(too_many.len(), 33);
    assert_err(env.propose_descriptors_as(&admin, too_many).1, CopierError::TooManyDescriptors);
    // Exits can never be removed: every (venue, side) keeps a descriptor.
    assert_err(env.propose_descriptors_as(&admin, vec![]).1, CopierError::DescriptorsIncomplete);
    for (venue, side) in [(Venue::Curve, Side::Buy), (Venue::Curve, Side::Sell), (Venue::Pool, Side::Buy), (Venue::Pool, Side::Sell)] {
        let without: Vec<_> = d.iter().copied().filter(|x| !(x.venue == venue && x.side == side)).collect();
        assert_err(env.propose_descriptors_as(&admin, without).1, CopierError::DescriptorsIncomplete);
    }

    assert_eq!(env.config().descriptors_proven, (1 << 10) - 1, "the seeded list is proven");

    // "Complete" lists whose exits have never worked are refused: every venue must keep a Sell
    // descriptor identical to a proven one of the current list.
    let broken = |mut x: TradeDescriptor| {
        x.disc = [9, 9, 9, 9, 9, 9, 9, 9];
        x
    };
    let (curve_sell, pool_sell) = (broken(d[1]), broken(d[7]));
    assert_err(
        env.propose_descriptors_as(&admin, vec![d[0], curve_sell, d[6], pool_sell]).1,
        CopierError::DescriptorsDropProvenExit,
    );
    assert_err(
        env.propose_descriptors_as(&admin, vec![d[0], d[1], d[6], pool_sell]).1,
        CopierError::DescriptorsDropProvenExit,
    );
    // Laundering through an intermediate list fails too: added descriptors start unproven.
    env.set_descriptors([d.clone(), vec![curve_sell, pool_sell]].concat());
    let c = env.config();
    assert_eq!(c.descriptors_proven, (1 << 10) - 1, "the broken additions are not proven");
    assert_err(
        env.propose_descriptors_as(&admin, vec![d[0], curve_sell, d[6], pool_sell]).1,
        CopierError::DescriptorsDropProvenExit,
    );

    // A minimal complete set plus a new (hypothetical) pump instruction, through the timelock.
    let new_venue = TradeDescriptor {
        program: PUMP,
        disc: [1, 2, 3, 4, 5, 6, 7, 8],
        side: Side::Buy,
        venue: Venue::Curve,
        user_idx: 8,
        base_mint_idx: 1,
        venue_idx: 5,
        min_accounts: 17,
    };
    let set = vec![d[0], d[1], d[6], d[7], new_venue];
    env.set_descriptors(set.clone());
    assert_eq!(env.config().descriptors, set);
    assert_eq!(env.config().descriptors_proven, 0b1111, "proven bits follow their descriptors");
}

#[test]
fn a_newer_proposal_supersedes_an_older_one_of_the_same_kind() {
    let mut env = Env::new();
    let admin = env.admin.insecure_clone();
    let anyone = env.user(5);
    let mut a = Params::default();
    a.max_trade_bps = 2_500;
    let mut b = Params::default();
    b.max_trade_bps = 500;
    let (id_a, r) = env.propose_params_as(&admin, a);
    ok(r);
    let (id_k, r) = env.propose_keeper_as(&admin, Keypair::new().pubkey());
    ok(r);
    let (id_b, r) = env.propose_params_as(&admin, b);
    ok(r);
    let c = env.config();
    assert_eq!(c.latest_change_ids[ChangeKind::Params as usize], id_b);
    assert_eq!(c.latest_change_ids[ChangeKind::Keeper as usize], id_k, "other kinds are unaffected");
    assert_eq!(c.latest_change_ids[ChangeKind::Descriptors as usize], NO_CHANGE);
    env.warp(TIMELOCK);
    // The superseded change can't execute, before or after the newer one.
    assert_err(env.execute_pending(&anyone, id_a), CopierError::PendingChangeSuperseded);
    ok(env.execute_pending(&anyone, id_b));
    assert_err(env.execute_pending(&anyone, id_a), CopierError::PendingChangeSuperseded);
    assert_eq!(env.config().params, b);
    assert_eq!(env.config().latest_change_ids[ChangeKind::Params as usize], NO_CHANGE);
    ok(env.execute_pending(&anyone, id_k));
    // Anyone discards the superseded one (rent back to the proposer); a live one can't be.
    let (id_c, r) = env.propose_params_as(&admin, a);
    ok(r);
    assert_err(env.discard_pending(&anyone, id_c), CopierError::PendingChangeLive);
    let admin_before = env.lamports(&admin.pubkey());
    let rent = env.lamports(&pending_pda(id_a));
    ok(env.discard_pending(&anyone, id_a));
    assert!(env.pending(id_a).is_none());
    assert_eq!(env.lamports(&admin.pubkey()), admin_before + rent);
    // Cancelling the live proposal clears its kind.
    ok(env.cancel_pending_as(&admin, id_c));
    assert_eq!(env.config().latest_change_ids[ChangeKind::Params as usize], NO_CHANGE);
}

#[test]
fn pending_changes_expire_after_the_execute_window() {
    let mut env = Env::new();
    let admin = env.admin.insecure_clone();
    let anyone = env.user(5);
    let mut p = Params::default();
    p.max_trade_bps = 2_000;
    let (id, r) = env.propose_params_as(&admin, p);
    ok(r);
    let pending = env.pending(id).unwrap();
    assert_eq!(pending.expires_at, pending.eta + EXECUTE_WINDOW_SECS);
    env.warp(TIMELOCK + EXECUTE_WINDOW_SECS + 1);
    assert_err(env.execute_pending(&anyone, id), CopierError::PendingChangeExpired);
    ok(env.discard_pending(&anyone, id));
    assert_eq!(env.config().params, Params::default());
    assert_eq!(env.config().latest_change_ids[ChangeKind::Params as usize], NO_CHANGE);
    // The last moment of the window still executes.
    let (id2, r) = env.propose_params_as(&admin, p);
    ok(r);
    env.warp(TIMELOCK + EXECUTE_WINDOW_SECS);
    assert_err(env.discard_pending(&anyone, id2), CopierError::PendingChangeLive);
    ok(env.execute_pending(&anyone, id2));
    assert_eq!(env.config().params, p);
}

#[test]
fn pause_keeper_invalidates_queued_keeper_changes() {
    let mut env = Env::new();
    let admin = env.admin.insecure_clone();
    let anyone = env.user(5);
    let leaked = Keypair::new().pubkey();
    let (id, r) = env.propose_keeper_as(&admin, leaked);
    ok(r);
    let (id_p, r) = env.propose_params_as(&admin, Params::default());
    ok(r);
    ok(env.pause_keeper_as(&admin));
    let c = env.config();
    assert_eq!(c.latest_change_ids[ChangeKind::Keeper as usize], NO_CHANGE);
    assert_eq!(c.latest_change_ids[ChangeKind::Params as usize], id_p, "only keeper changes are invalidated");
    env.warp(TIMELOCK);
    assert_err(env.execute_pending(&anyone, id), CopierError::PendingChangeSuperseded);
    assert_eq!(env.config().keeper, Pubkey::default());
    ok(env.discard_pending(&anyone, id));
    ok(env.execute_pending(&anyone, id_p));
    // A keeper proposed after the pause installs normally.
    let fresh = env.user(1);
    let (id2, r) = env.propose_keeper_as(&admin, fresh.pubkey());
    ok(r);
    env.execute_after_timelock(id2);
    assert_eq!(env.config().keeper, fresh.pubkey());
}

#[test]
fn admin_handover_invalidates_everything_the_old_admin_queued() {
    let mut env = Env::new();
    let old = env.admin.insecure_clone();
    let anyone = env.user(5);
    let next = env.user(5);
    let (k, r) = env.propose_keeper_as(&old, Keypair::new().pubkey());
    ok(r);
    let (p, r) = env.propose_params_as(&old, Params::default());
    ok(r);
    let (d, r) = env.propose_descriptors_as(&old, default_descriptors());
    ok(r);
    ok(env.propose_admin_as(&old, next.pubkey()));
    env.warp(TIMELOCK);
    ok(env.accept_admin_as(&next));
    assert_eq!(env.config().latest_change_ids, [NO_CHANGE; 4]);
    for id in [k, p, d] {
        assert_err(env.execute_pending(&anyone, id), CopierError::PendingChangeSuperseded);
        ok(env.discard_pending(&anyone, id));
    }
    // The new admin's own proposals work.
    let (id, r) = env.propose_params_as(&next, Params::default());
    ok(r);
    env.execute_after_timelock(id);
}

#[test]
fn keeper_changes_are_timelocked_but_pause_is_instant() {
    let mut env = Env::new();
    let admin = env.admin.insecure_clone();
    let stranger = env.user(5);
    let keeper = env.keeper.insecure_clone();

    // Heartbeat: keeper only, moves the global liveness clock.
    env.warp(100);
    ok(env.keeper_heartbeat_as(&keeper));
    assert_eq!(env.config().keeper_heartbeat_ts, env.now());
    assert_err(env.keeper_heartbeat_as(&stranger), CopierError::NotKeeper);

    // A new keeper only after the timelock; the old one keeps working meanwhile.
    let next = env.user(5);
    assert_err(env.propose_keeper_as(&stranger, next.pubkey()).1, CopierError::NotAdmin);
    let (id, res) = env.propose_keeper_as(&admin, next.pubkey());
    ok(res);
    ok(env.keeper_heartbeat_as(&keeper));
    assert_err(env.keeper_heartbeat_as(&next), CopierError::NotKeeper);
    env.execute_after_timelock(id);
    assert_eq!(env.config().keeper, next.pubkey());
    ok(env.keeper_heartbeat_as(&next));
    assert_err(env.keeper_heartbeat_as(&keeper), CopierError::NotKeeper);

    // Pause: admin only, immediate, leaves no keeper at all.
    assert_err(env.pause_keeper_as(&stranger), CopierError::NotAdmin);
    let ts = env.config().keeper_heartbeat_ts;
    ok(env.pause_keeper_as(&admin));
    assert_eq!(env.config().keeper, Pubkey::default());
    assert_eq!(env.config().keeper_heartbeat_ts, ts, "a pause is not a heartbeat");
    assert_err(env.keeper_heartbeat_as(&next), CopierError::NotKeeper);
}

#[test]
fn admin_handover_is_two_step_and_timelocked() {
    let mut env = Env::new();
    let admin = env.admin.insecure_clone();
    let stranger = env.user(5);
    let next = env.user(5);
    assert_err(env.propose_admin_as(&stranger, next.pubkey()), CopierError::NotAdmin);
    ok(env.propose_admin_as(&admin, next.pubkey()));
    assert_eq!(env.config().pending_admin_eta, env.now() + TIMELOCK);
    assert_err(env.accept_admin_as(&stranger), CopierError::NotPendingAdmin);
    assert_err(env.accept_admin_as(&next), CopierError::TimelockNotElapsed);
    env.warp(TIMELOCK);
    ok(env.accept_admin_as(&next));
    let c = env.config();
    assert_eq!(c.admin, next.pubkey());
    assert_eq!(c.pending_admin, Pubkey::default());
    // The old admin is powerless, the new one proposes.
    assert_err(env.pause_keeper_as(&admin), CopierError::NotAdmin);
    ok(env.propose_keeper_as(&next, admin.pubkey()).1);
}
