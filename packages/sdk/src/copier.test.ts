import assert from "node:assert/strict";
import { test } from "node:test";
import { BN, BorshInstructionCoder } from "@coral-xyz/anchor";
import { AddressLookupTableAccount, Keypair, PublicKey, type TransactionInstruction } from "@solana/web3.js";
import copierIdlJson from "./idl/copy_vault.json";
import { checkIxAgainstIdl, type Idl } from "./testing/idl-check";
import { INSTRUCTIONS_SYSVAR_ID, COPIER_PROGRAM_ID, PUMP_AMM_PROGRAM_ID, PUMP_IX, PUMP_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "./constants";
import { DEFAULT_PARAMS, EXECUTE_WINDOW_SECS, NO_CHANGE_ID, PARAM_RANGES } from "./params";
import {
  buildAcceptAdminIx,
  buildBurnPlatformIx,
  buildBuybackBurnIx,
  buildDepositIx,
  buildDevBuyIxs,
  buildDistributeFeesIxs,
  buildFundPlatformBurnIx,
  buildInitializeConfigIx,
  buildLaunchIndexIxs,
  buildLaunchIxs,
  buildCopierBuyIx,
  buildCopierSellIx,
  buildCancelPendingIx,
  buildDiscardPendingIx,
  buildExecutePendingIx,
  buildKeeperHeartbeatIx,
  buildPauseKeeperIx,
  buildProposeAdminIx,
  buildProposeDescriptorsIx,
  buildProposeIndexTargetsIx,
  buildProposeKeeperIx,
  buildProposeParamsIx,
  buildRegisterIndexIx,
  buildSetPlatformMintIx,
  buildSyncIx,
  buildUnverifyTraderIx,
  buildVerifyTraderIx,
  DEFAULT_DESCRIPTORS,
  findDescriptorIdx,
  copierShareholders,
  paramsOutOfRange,
  validateDescriptors,
} from "./copier";
import { CHANGE_KIND_INDEX, pendingChangeStatus, decodeConfig, decodeCopier, decodePendingChange, decodePosition, describeError, descriptorToIdl, copierEquity, copierProgram, COPIER_ACCOUNT_DISC, paramsToIdl, parseCopierEvents } from "./program";
import { burnPoolPda, canonicalPoolPda, copierPda, pendingChangePda, positionPda, vaultPda, wsolAta, ata, bondingCurvePda } from "./pda";
import { canonicalPoolKeys } from "./pump";
import { platformLookupTableAddresses, buildV0Tx, LAUNCH_COMPUTE_UNITS } from "./tx";
import type { VenueAccounts } from "./venue";

const IDL = copierIdlJson as unknown as Idl;
const key = () => Keypair.generate().publicKey;
const admin = key();
const keeper = key();
const mint = key();
const target = key();
const tokenMint = key();

const only = (ixs: TransactionInstruction[]) => {
  assert.equal(ixs.length, 1);
  return ixs[0]!;
};

const curveVenue: VenueAccounts = {
  kind: "curve",
  tokenMint,
  tokenProgram: TOKEN_2022_PROGRAM_ID,
  venue: bondingCurvePda(tokenMint),
  buybackFeeRecipient: key(),
};
const poolVenue: VenueAccounts = {
  kind: "pool",
  tokenMint,
  tokenProgram: TOKEN_2022_PROGRAM_ID,
  venue: canonicalPoolPda(tokenMint),
  buybackFeeRecipient: key(),
  pool: canonicalPoolKeys(tokenMint),
};

test("admin and bookkeeping builders match the IDL account lists", () => {
  checkIxAgainstIdl(IDL, "initialize_config", only(buildInitializeConfigIx({ admin, keeper, timelockSecs: 3_600 })));
  const proposeKeeper = checkIxAgainstIdl(IDL, "propose_keeper", only(buildProposeKeeperIx({ admin, keeper, changeId: 7n })));
  assert.ok(proposeKeeper.pending!.equals(pendingChangePda(7n)));
  checkIxAgainstIdl(IDL, "propose_params", only(buildProposeParamsIx({ admin, params: { ...DEFAULT_PARAMS }, changeId: 0n })));
  checkIxAgainstIdl(IDL, "propose_descriptors", only(buildProposeDescriptorsIx({ admin, descriptors: DEFAULT_DESCRIPTORS, changeId: 1n })));
  const proposeTargets = checkIxAgainstIdl(IDL, "propose_index_targets", only(buildProposeIndexTargetsIx({ admin, mint, targets: [target], changeId: 2n })));
  assert.ok(proposeTargets.copier!.equals(copierPda(mint)));
  checkIxAgainstIdl(IDL, "pause_keeper", only(buildPauseKeeperIx({ admin })));
  checkIxAgainstIdl(IDL, "keeper_heartbeat", only(buildKeeperHeartbeatIx({ keeper })));
  checkIxAgainstIdl(IDL, "propose_admin", only(buildProposeAdminIx({ admin, newAdmin: key() })));
  checkIxAgainstIdl(IDL, "accept_admin", only(buildAcceptAdminIx({ pendingAdmin: key() })));
  checkIxAgainstIdl(IDL, "set_platform_mint", only(buildSetPlatformMintIx({ admin, mint })));
  checkIxAgainstIdl(IDL, "register_index", only(buildRegisterIndexIx({ admin, mint, targets: [target, key()] })));
  checkIxAgainstIdl(IDL, "deposit", only(buildDepositIx({ depositor: admin, mint, lamports: 30_000_000_000n })));
  checkIxAgainstIdl(IDL, "sync", only(buildSyncIx({ mint })));
  checkIxAgainstIdl(IDL, "verify_trader", only(buildVerifyTraderIx({ target, mint, targetIdx: 0 })));
  checkIxAgainstIdl(IDL, "unverify_trader", only(buildUnverifyTraderIx({ target, mint, targetIdx: 0 })));
  checkIxAgainstIdl(IDL, "fund_platform_burn", only(buildFundPlatformBurnIx({ mint })));
});

test("execute / cancel pending: PDA from the change id, copier only for index-target changes", () => {
  const proposer = key();
  const keeperChange = { id: 3n, kind: "keeper" as const, proposer, copier: PublicKey.default };
  const exec = only(buildExecutePendingIx({ change: keeperChange }));
  const named = checkIxAgainstIdl(IDL, "execute_pending", exec);
  assert.ok(named.pending!.equals(pendingChangePda(3n)));
  assert.ok(named.proposer!.equals(proposer));
  assert.ok(named.copier!.equals(COPIER_PROGRAM_ID), "None placeholder");
  assert.equal(exec.keys[3]!.isWritable, false);
  assert.ok(exec.keys.every((k) => !k.isSigner), "execute_pending is signer-free");

  const targetsChange = { id: 4n, kind: "indexTargets" as const, proposer, copier: copierPda(mint) };
  const execTargets = only(buildExecutePendingIx({ change: targetsChange }));
  checkIxAgainstIdl(IDL, "execute_pending", execTargets);
  assert.ok(execTargets.keys[3]!.pubkey.equals(copierPda(mint)) && execTargets.keys[3]!.isWritable);

  const cancel = checkIxAgainstIdl(IDL, "cancel_pending", only(buildCancelPendingIx({ admin, change: targetsChange })));
  assert.ok(cancel.pending!.equals(pendingChangePda(4n)));
  // the id is a u64 LE seed
  const le = Buffer.alloc(8);
  le.writeBigUInt64LE(4n);
  assert.ok(pendingChangePda(4n).equals(PublicKey.findProgramAddressSync([Buffer.from("pending"), le], COPIER_PROGRAM_ID)[0]));
});

// Decoding needs the Borsh coder (the Program's coder is typed as the encode-only interface).
const ixCoder = new BorshInstructionCoder(copierProgram().idl);

/** An instruction's decoded args by name (the coder returns an untyped object). */
function argsOf(ix: TransactionInstruction): Record<string, unknown> {
  const decoded = ixCoder.decode(ix.data);
  assert.ok(decoded, "instruction data decodes");
  return Object.fromEntries(Object.entries(decoded.data));
}

test("instruction args round-trip through the IDL coder", () => {
  assert.equal(ixCoder.decode(only(buildDepositIx({ depositor: admin, mint, lamports: 1n })).data)?.name, "deposit");
  assert.equal(String(argsOf(only(buildDepositIx({ depositor: admin, mint, lamports: 123_456_789n }))).lamports), "123456789");
  const params = argsOf(only(buildProposeParamsIx({ admin, changeId: 0n, params: { ...DEFAULT_PARAMS, maxTradeBps: 1_234 } }))).params;
  assert.ok(params && typeof params === "object" && "maxTradeBps" in params && "spendWindowSecs" in params && "maxWindowSpendBps" in params);
  assert.equal(params.maxTradeBps, 1_234);
  assert.equal(String(params.spendWindowSecs), "3600");
  assert.equal(params.maxWindowSpendBps, 3_000);
  assert.equal(String(argsOf(only(buildInitializeConfigIx({ admin, keeper, timelockSecs: 86_400 }))).timelockSecs), "86400");
});

test("params and timelock are validated against the program's ranges before sending", () => {
  assert.deepEqual(paramsOutOfRange({ ...DEFAULT_PARAMS }), []);
  // every bound itself is accepted, one step outside is not
  for (const [field, { min, max }] of Object.entries(PARAM_RANGES)) {
    const below = typeof min === "bigint" ? min - 1n : min - 1;
    const above = typeof max === "bigint" ? max + 1n : max + 1;
    for (const [v, ok] of [[min, true], [max, true], [below, false], [above, false]] as const) {
      assert.equal(paramsOutOfRange({ ...DEFAULT_PARAMS, [field]: v }).length === 0, ok, `${field} = ${v}`);
    }
  }
  assert.throws(() => buildProposeParamsIx({ admin, changeId: 0n, params: { ...DEFAULT_PARAMS, slippageBps: 200 } }), /slippageBps/);
  assert.throws(() => buildInitializeConfigIx({ admin, keeper, timelockSecs: 59 }));
  assert.throws(() => buildInitializeConfigIx({ admin, keeper, timelockSecs: 604_801 }));
});

test("launch: create_v2 → fee sharing [target X, vault 10000−X] → register_copier, fits one v0 tx with the platform ALT", () => {
  const launcher = key();
  const mintKp = Keypair.generate();
  const ixs = buildLaunchIxs({ launcher, mint: mintKp.publicKey, name: "Copier of Ansem", symbol: "cANSEM", uri: "https://ipfs.io/ipfs/bafkreia5yqkl2vy3a7xg3ctwq2ztzqzbgwjm2ccd7ce2zhdmvq7v3bfb5a", target, traderBps: 1_000 });
  assert.equal(ixs.length, 4);
  assert.ok(ixs[0]!.programId.equals(PUMP_PROGRAM_ID));
  const register = checkIxAgainstIdl(IDL, "register_copier", ixs[3]!);
  assert.ok(register.vault!.equals(vaultPda(mintKp.publicKey)));
  assert.ok(register.target!.equals(target));
  // update_fee_shares_v2 args: [{target, 1000}, {vault, 9000}]
  const update = ixs[2]!.data;
  assert.ok(new PublicKey(update.subarray(12, 44)).equals(target));
  assert.equal(update.readUInt16LE(44), 1_000);
  assert.ok(new PublicKey(update.subarray(46, 78)).equals(vaultPda(mintKp.publicKey)));
  assert.equal(update.readUInt16LE(78), 9_000);

  const alt = new AddressLookupTableAccount({
    key: key(),
    state: { deactivationSlot: BigInt("18446744073709551615"), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, authority: undefined, addresses: platformLookupTableAddresses() },
  });
  const tx = buildV0Tx({ payer: launcher, instructions: ixs, recentBlockhash: PublicKey.default.toBase58(), lookupTables: [alt], computeUnitLimit: LAUNCH_COMPUTE_UNITS, computeUnitPriceMicroLamports: 100_000 });
  const size = tx.serialize().length;
  assert.ok(size <= 1_232, `launch tx is ${size} bytes`);
  assert.equal(tx.message.header.numRequiredSignatures, 2);

  assert.throws(() => buildLaunchIxs({ launcher, mint: mintKp.publicKey, name: "x", symbol: "x", uri: "x", target, traderBps: 99 }));
  assert.throws(() => buildLaunchIxs({ launcher, mint: mintKp.publicKey, name: "x", symbol: "x", uri: "x", target, traderBps: 2_501 }));
  assert.throws(() => buildLaunchIxs({ launcher, mint: mintKp.publicKey, name: "x", symbol: "x", uri: "x", target: vaultPda(mintKp.publicKey), traderBps: 500 }));
});

test("index launch and dev buy", () => {
  const ixs = buildLaunchIndexIxs({ admin, mint, name: "Index", symbol: "INDEX", uri: "https://x", targets: [target] });
  checkIxAgainstIdl(IDL, "register_index", ixs[3]!);
  const update = ixs[2]!.data;
  assert.equal(update.readUInt32LE(8), 1);
  assert.ok(new PublicKey(update.subarray(12, 44)).equals(vaultPda(mint)));
  assert.equal(update.readUInt16LE(44), 10_000);
  const [ataIx, buy] = buildDevBuyIxs({ buyer: admin, mint, solIn: 500_000_000n, minTokensOut: 1n });
  assert.ok(ataIx!.keys[1]!.pubkey.equals(ata(admin, mint)));
  assert.ok(buy!.programId.equals(PUMP_PROGRAM_ID));
});

test("copier_buy / copier_sell forward the venue ix with the vault as an unsigned user", () => {
  const cases = [
    { venue: curveVenue, program: PUMP_PROGRAM_ID, user: 8, buyIdx: 2, sellIdx: 1 },
    { venue: poolVenue, program: PUMP_AMM_PROGRAM_ID, user: 1, buyIdx: 6, sellIdx: 7 },
  ];
  const vault = vaultPda(mint);
  for (const c of cases) {
    const buy = only(buildCopierBuyIx({ keeper, mint, targetIdx: 0, target, tokenMint, solIn: 50_000_000n, minTokensOut: 7n, venue: c.venue }));
    const named = checkIxAgainstIdl(IDL, "copier_buy", buy, { remaining: 17 });
    assert.ok(named.position!.equals(positionPda(mint, tokenMint)));
    assert.ok(named.vault_token_account!.equals(ata(vault, tokenMint, TOKEN_2022_PROGRAM_ID)));
    assert.ok(named.target_token_account!.equals(ata(target, tokenMint, TOKEN_2022_PROGRAM_ID)));
    assert.ok(named.vault_wsol!.equals(wsolAta(vault)));
    const nNamed = buy.keys.length - 17;
    assert.ok(buy.keys[nNamed - 1]!.pubkey.equals(INSTRUCTIONS_SYSVAR_ID), "instructions sysvar is the last named account");
    const remaining = buy.keys.slice(nNamed);
    assert.ok(remaining[c.user]!.pubkey.equals(vault));
    assert.equal(remaining[c.user]!.isSigner, false);
    assert.equal(remaining.filter((k) => k.pubkey.equals(vault)).length, 1, "vault appears once in the venue accounts");
    assert.ok(remaining.at(-1)!.pubkey.equals(c.program));
    const args = argsOf(buy);
    assert.equal(args.descriptorIdx, c.buyIdx);
    const ixData = args.ixData;
    assert.ok(Buffer.isBuffer(ixData));
    assert.deepEqual([...ixData.subarray(0, 8)], [...DEFAULT_DESCRIPTORS[c.buyIdx]!.disc]);
    assert.equal(ixData.readBigUInt64LE(8), 50_000_000n);

    const sell = only(buildCopierSellIx({ authority: keeper, mint, targetIdx: 0, target, tokenMint, tokensIn: 99n, minSolOut: 1n, venue: { accounts: c.venue } }));
    const sellNamed = checkIxAgainstIdl(IDL, "copier_sell", sell, { remaining: 17 });
    assert.ok(sellNamed.burn_pool!.equals(burnPoolPda()));
    assert.equal(argsOf(sell).descriptorIdx, c.sellIdx);
  }
  assert.throws(() => buildCopierBuyIx({ keeper, mint, targetIdx: 0, target, tokenMint: key(), solIn: 1n, minTokensOut: 1n, venue: curveVenue }));
});

test("descriptor lookup honors a reordered on-chain list and rejects non-whitelisted venues", () => {
  const reordered = [...DEFAULT_DESCRIPTORS].reverse();
  const buy = only(buildCopierBuyIx({ keeper, mint, targetIdx: 0, target, tokenMint, solIn: 1n, minTokensOut: 1n, venue: curveVenue, descriptors: reordered }));
  assert.equal(argsOf(buy).descriptorIdx, 7);
  assert.throws(() => findDescriptorIdx(DEFAULT_DESCRIPTORS.slice(3), PUMP_PROGRAM_ID, DEFAULT_DESCRIPTORS[2]!.disc, "buy"));
  // same disc, other program: pump_amm sell_v2 is not pump sell_v2
  assert.equal(findDescriptorIdx(DEFAULT_DESCRIPTORS, PUMP_PROGRAM_ID, DEFAULT_DESCRIPTORS[7]!.disc, "sell"), 4);
});

test("buyback_burn and burn_platform trade as the vault / burn pool", () => {
  const ownVenue = { ...curveVenue, tokenMint: mint, venue: bondingCurvePda(mint) };
  const bb = only(buildBuybackBurnIx({ keeper, mint, solIn: 60_000_000n, minTokensOut: 1n, venue: ownVenue }));
  checkIxAgainstIdl(IDL, "buyback_burn", bb, { remaining: 17 });
  assert.ok(bb.keys[bb.keys.length - 17 + 8]!.pubkey.equals(vaultPda(mint)));
  const bm = only(buildBurnPlatformIx({ keeper, platformMint: mint, solIn: 60_000_000n, minTokensOut: 1n, venue: ownVenue }));
  checkIxAgainstIdl(IDL, "burn_platform", bm, { remaining: 17 });
  assert.ok(bm.keys[bm.keys.length - 17 + 8]!.pubkey.equals(burnPoolPda()));
  assert.throws(() => buildBuybackBurnIx({ keeper, mint, solIn: 1n, minTokensOut: 1n, venue: curveVenue }));
});

test("fee crank: sweeps, distribute to the shareholders in order, then sync", () => {
  const holders = copierShareholders({ kind: "single", targets: [target], mint });
  assert.deepEqual(holders.map(String), [target, vaultPda(mint)].map(String));
  assert.deepEqual(copierShareholders({ kind: "index", targets: [target], mint }).map(String), [vaultPda(mint).toBase58()]);
  const pre = buildDistributeFeesIxs({ payer: keeper, mint, graduated: false, shareholders: holders });
  assert.deepEqual(pre.map((i) => i.programId.toBase58()), [PUMP_PROGRAM_ID, PUMP_PROGRAM_ID, COPIER_PROGRAM_ID].map(String));
  const post = buildDistributeFeesIxs({ payer: keeper, mint, graduated: true, shareholders: holders, sync: false });
  // after graduation: pool sweep + AMM→pump transfer, then the curve sweep, then distribute
  assert.deepEqual(post.map((i) => i.programId.toBase58()), [PUMP_AMM_PROGRAM_ID, PUMP_AMM_PROGRAM_ID, PUMP_PROGRAM_ID, PUMP_PROGRAM_ID].map(String));
  assert.deepEqual([...post[2]!.data.subarray(0, 8)], [...PUMP_IX.sweepCreatorFee]);
  assert.deepEqual(post[3]!.keys.slice(-2).map((k) => k.pubkey.toBase58()), holders.map(String));
});

test("account decoders: discriminators and field normalization", async () => {
  const coder = copierProgram().coder.accounts;
  const copierState = {
    mint, launcher: admin, kind: { single: {} }, targets: [target], traderBps: 1_000, verified: 1, vaultBump: 254, bump: 253,
    createdAt: new BN(1_700_000_000), sharingConfig: key(), accountedLamports: new BN(5), feesIn: new BN(6), capitalIn: new BN(7),
    openCost: new BN(8), openPositions: 2, realizedPnl: new BN(-9), hwm: new BN(10), buybackPool: new BN(11), platformSent: new BN(12),
    burned: new BN(13), buybackSpent: new BN(14), trades: new BN(15), lastKeeperTs: new BN(16), graduatedPool: PublicKey.default,
    platformPending: new BN(17), lastBuybackTs: new BN(18), targetPositions: Array.from({ length: 16 }, (_, i) => i),
    windowStart: new BN(19), windowSpent: new BN(20), windowEquity: new BN(21), lastPublicSellSlot: new BN(22),
  };
  const raw = await coder.encode("copier", copierState);
  assert.deepEqual([...raw.subarray(0, 8)], [...COPIER_ACCOUNT_DISC.copier]);
  const m = decodeCopier(raw);
  assert.equal(m.kind, "single");
  assert.equal(m.realizedPnl, -9n);
  assert.equal(m.platformPending, 17n);
  assert.deepEqual(m.targetPositions.slice(0, 3), [0, 1, 2]);
  assert.ok(m.targets[0]!.equals(target));
  assert.deepEqual([m.windowStart, m.windowSpent, m.windowEquity, m.lastPublicSellSlot], [19n, 20n, 21n, 22n]);

  const position = {
    mint, tokenMint, target, tokens: new BN(1_000), cost: new BN(50_000_000), targetSnapshot: new BN(4), targetPeak: new BN(5),
    vaultPeak: new BN(6), openedAt: new BN(7), lastTradeTs: new BN(8), bump: 255,
  };
  const p = decodePosition(await coder.encode("position", position));
  assert.equal(p.cost, 50_000_000n);
  assert.ok(p.tokenMint.equals(tokenMint));

  const config = await coder.encode("config", {
    admin, pendingAdmin: PublicKey.default, keeper, platformMint: PublicKey.default,
    params: paramsToIdl({ ...DEFAULT_PARAMS }),
    descriptors: DEFAULT_DESCRIPTORS.map(descriptorToIdl),
    bump: 1, burnPoolBump: 2, platformBurned: new BN(3), platformBurnSpent: new BN(4),
    timelockSecs: new BN(86_400), nextChangeId: new BN(5), pendingAdminEta: new BN(6), keeperHeartbeatTs: new BN(7), lastPlatformBurnTs: new BN(8),
    latestChangeIds: [new BN(NO_CHANGE_ID.toString()), new BN(4), new BN(NO_CHANGE_ID.toString()), new BN(NO_CHANGE_ID.toString())],
    descriptorsProven: 0b11_1111_1111,
  });
  const c = decodeConfig(config);
  assert.deepEqual(c.params, { ...DEFAULT_PARAMS });
  assert.deepEqual(c.descriptors, DEFAULT_DESCRIPTORS);
  assert.deepEqual([c.timelockSecs, c.nextChangeId, c.pendingAdminEta, c.keeperHeartbeatTs, c.lastPlatformBurnTs], [86_400n, 5n, 6n, 7n, 8n]);
  assert.deepEqual(c.latestChangeIds, [NO_CHANGE_ID, 4n, NO_CHANGE_ID, NO_CHANGE_ID], "u64::MAX survives as an exact bigint");
  assert.equal(c.descriptorsProven, 0b11_1111_1111);
  assert.throws(() => decodeCopier(config));

  const pendingRaw = await coder.encode("pendingChange", {
    id: new BN(11), kind: { params: {} }, proposer: admin, proposedAt: new BN(100), eta: new BN(3_700), expiresAt: new BN(608_500), keeper: PublicKey.default,
    params: paramsToIdl({ ...DEFAULT_PARAMS, maxTradeBps: 500 }), descriptors: [], copier: PublicKey.default, targets: [], bump: 254,
  });
  assert.deepEqual([...pendingRaw.subarray(0, 8)], [...COPIER_ACCOUNT_DISC.pendingChange]);
  const pc = decodePendingChange(pendingRaw);
  assert.equal(pc.kind, "params");
  assert.equal(pc.id, 11n);
  assert.equal(pc.eta, 3_700n);
  assert.equal(pc.expiresAt, 608_500n);
  assert.equal(pc.params.maxTradeBps, 500);
  assert.ok(pc.proposer.equals(admin));
});

test("copierEquity copiers Copier::equity", () => {
  const copier = { buybackPool: 100n, platformPending: 50n, openCost: 1_000n };
  assert.deepEqual(copierEquity({ copier, vaultLamports: 5_000n, vaultWsol: 0n, rentExempt: 890n }), { freeSol: 3_960n, equity: 4_960n });
  assert.deepEqual(copierEquity({ copier, vaultLamports: 900n, rentExempt: 890n }), { freeSol: 0n, equity: 1_000n });
});

test("parseCopierEvents decodes Program data logs inside Copier invocations only", () => {
  const program = copierProgram();
  const encodeEvent = (name: string, data: Record<string, unknown>) => {
    const ev = program.idl.events!.find((e) => e.name === name)!;
    const body = program.coder.types.encode(name, data);
    return `Program data: ${Buffer.concat([Buffer.from(ev.discriminator), body]).toString("base64")}`;
  };
  const buy = encodeEvent("copierBuy", {
    mint, target, tokenMint, venue: { pool: {} }, solIn: new BN(50_000_000), tokensOut: new BN(123), targetBalance: new BN(456),
    signalLamports: new BN(70_000_000), equity: new BN(1_000_000_000), ts: new BN(1_759_500_000),
  });
  const split = encodeEvent("profitSplit", { mint, excess: new BN(200), toBuyback: new BN(150), toPlatform: new BN(50), ts: new BN(1) });
  const id = COPIER_PROGRAM_ID.toBase58();
  const logs = [
    `Program ${id} invoke [1]`,
    "Program log: Instruction: CopierBuy",
    `Program ${PUMP_PROGRAM_ID.toBase58()} invoke [2]`,
    split.replace(/^Program data: /, "Program data: "), // a pump-attributed data line must be ignored
    `Program ${PUMP_PROGRAM_ID.toBase58()} success`,
    buy,
    `Program ${id} consumed 80000 of 200000 compute units`,
    `Program ${id} success`,
    `Program ${id} invoke [1]`,
    split,
    `Program ${id} success`,
  ];
  const proposed = encodeEvent("changeProposed", { id: new BN(9), kind: { indexTargets: {} }, eta: new BN(1_759_600_000), expiresAt: new BN(1_760_204_800), ts: new BN(1_759_500_000) });
  const paused = encodeEvent("keeperPaused", { keeper, ts: new BN(5) });
  logs.push(`Program ${id} invoke [1]`, proposed, paused, `Program ${id} success`);
  const events = parseCopierEvents(logs);
  assert.deepEqual(events.map((e) => e.name), ["CopierBuy", "ProfitSplit", "ChangeProposed", "KeeperPaused"]);
  const e0 = events[0]!;
  assert.equal(e0.name, "CopierBuy");
  if (e0.name === "CopierBuy") {
    assert.equal(e0.data.venue, "pool");
    assert.equal(e0.data.mint, mint.toBase58());
    assert.equal(e0.data.solIn, 50_000_000n);
    assert.equal(e0.data.ts, 1_759_500_000);
  }
  assert.deepEqual(events[2]!.data, { id: 9n, kind: "indexTargets", eta: 1_759_600_000, expiresAt: 1_760_204_800, ts: 1_759_500_000 });
  assert.deepEqual(events[3]!.data, { keeper: keeper.toBase58(), ts: 5 });
});

test("describeError maps only Copier's own failures to Copier messages", () => {
  const id = COPIER_PROGRAM_ID.toBase58();
  const pump = PUMP_PROGRAM_ID.toBase58();
  const own = { message: "simulation failed", logs: [`Program ${id} invoke [1]`, `Program ${id} failed: custom program error: 0x1771`] };
  assert.equal(describeError(own), "Signer is not the config admin");
  // pump's 6000 bubbling up through Copier must not read as Copier's 6000
  const cpi = {
    message: "simulation failed",
    logs: [`Program ${id} invoke [1]`, `Program ${pump} invoke [2]`, `Program ${pump} failed: custom program error: 0x1770`, `Program ${id} failed: custom program error: 0x1770`],
  };
  assert.equal(describeError(cpi), "pump failed: custom program error: 0x1770");
});

test("discard_pending and cancel_pending match the IDL (cancel writes config)", () => {
  const change = { id: 12n, kind: "params" as const, proposer: admin, copier: PublicKey.default };
  const discard = only(buildDiscardPendingIx({ change }));
  const named = checkIxAgainstIdl(IDL, "discard_pending", discard);
  assert.ok(named.pending!.equals(pendingChangePda(12n)));
  assert.ok(discard.keys.every((k) => !k.isSigner), "discard_pending is signer-free");
  const cancel = only(buildCancelPendingIx({ admin, change }));
  checkIxAgainstIdl(IDL, "cancel_pending", cancel);
  assert.equal(cancel.keys[1]!.isWritable, true);
});

test("pendingChangeStatus follows the program's order: superseded, expired, queued, executable", () => {
  const change = { id: 5n, kind: "descriptors" as const, eta: 1_000n, expiresAt: 1_000n + BigInt(EXECUTE_WINDOW_SECS) };
  const live = { latestChangeIds: [NO_CHANGE_ID, NO_CHANGE_ID, 5n, NO_CHANGE_ID] };
  assert.equal(CHANGE_KIND_INDEX.descriptors, 2);
  assert.equal(pendingChangeStatus(change, live, 999), "queued");
  assert.equal(pendingChangeStatus(change, live, 1_000), "executable");
  assert.equal(pendingChangeStatus(change, live, change.expiresAt), "executable");
  assert.equal(pendingChangeStatus(change, live, change.expiresAt + 1n), "expired");
  // superseded wins even inside the window
  assert.equal(pendingChangeStatus(change, { latestChangeIds: [NO_CHANGE_ID, NO_CHANGE_ID, 6n, NO_CHANGE_ID] }, 1_000), "superseded");
  assert.equal(pendingChangeStatus(change, { latestChangeIds: [5n, NO_CHANGE_ID, NO_CHANGE_ID, NO_CHANGE_ID] }, 1_000), "superseded");
});

test("validateDescriptors copiers the program's whitelist rules", () => {
  const all = (2 ** DEFAULT_DESCRIPTORS.length) - 1;
  assert.equal(validateDescriptors(DEFAULT_DESCRIPTORS), all, "initialization proves the seeded list");
  const live = { descriptors: DEFAULT_DESCRIPTORS, descriptorsProven: 0b10_1000_0010 }; // proven: pump sell_v3 (1), amm sell_v2 (7), amm sell (9)
  // keeping the proven curve sell_v3 (1) and pool sell_v2 (7) in a reordered list carries their bits over
  const reordered = [DEFAULT_DESCRIPTORS[7]!, DEFAULT_DESCRIPTORS[6]!, DEFAULT_DESCRIPTORS[1]!, DEFAULT_DESCRIPTORS[2]!];
  assert.equal(validateDescriptors(reordered, live), 0b0101);
  // dropping every proven pool sell is refused, even with another (unproven) pool sell
  const noProvenPoolSell = [DEFAULT_DESCRIPTORS[1]!, DEFAULT_DESCRIPTORS[2]!, DEFAULT_DESCRIPTORS[6]!, { ...DEFAULT_DESCRIPTORS[7]!, minAccounts: 18 }];
  assert.throws(() => validateDescriptors(noProvenPoolSell, live), /DescriptorsDropProvenExit/);
  assert.throws(() => validateDescriptors([DEFAULT_DESCRIPTORS[1]!, DEFAULT_DESCRIPTORS[6]!, DEFAULT_DESCRIPTORS[7]!]), /DescriptorsIncomplete/);
  assert.throws(() => validateDescriptors([...DEFAULT_DESCRIPTORS.slice(0, 9), { ...DEFAULT_DESCRIPTORS[9]!, minAccounts: 41 }]), /DescriptorIndices/);
  assert.throws(() => validateDescriptors([...DEFAULT_DESCRIPTORS.slice(1), { ...DEFAULT_DESCRIPTORS[0]!, venue: "pool" }]), /DescriptorProgramNotAllowed/);
  assert.throws(() => validateDescriptors(Array.from({ length: 33 }, () => DEFAULT_DESCRIPTORS[0]!)), /TooManyDescriptors/);
  assert.throws(() => buildProposeDescriptorsIx({ admin, changeId: 0n, descriptors: noProvenPoolSell, config: live }), /DescriptorsDropProvenExit/);
});
