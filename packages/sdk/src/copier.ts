/**
 * Copier program instruction builders. All synchronous and offline: account metas come straight
 * from the IDL (order, writable, signer), data from the IDL coder. Each returns
 * `TransactionInstruction[]`; none adds compute-budget instructions (see `buildV0Tx`).
 */
import { BN } from "@coral-xyz/anchor";
import { createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import { PublicKey, TransactionInstruction, type AccountMeta } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  INSTRUCTIONS_SYSVAR_ID,
  MEMO_PROGRAM_ID,
  COPIER_PROGRAM_ID,
  PUMP_AMM_IX,
  PUMP_AMM_PROGRAM_ID,
  PUMP_IX,
  PUMP_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "./constants";
import {
  MAX_DESCRIPTOR_ACCOUNTS,
  MAX_DESCRIPTORS,
  MAX_INDEX_TARGETS,
  MAX_TIMELOCK_SECS,
  MIN_TIMELOCK_SECS,
  PARAM_RANGES,
  TRADER_MAX_BPS,
  TRADER_MIN_BPS,
} from "./params";
import { ata, burnPoolPda, configPda, copierPda, pendingChangePda, positionPda, sharingConfigPda, vaultPda, wsolAta, bondingCurvePda } from "./pda";
import {
  canonicalPoolKeys,
  createFeeSharingConfigIx,
  CURVE_V3_INDEX,
  curveBuyData,
  curveSellData,
  distributeCreatorFeesV2Ix,
  POOL_V2_INDEX,
  poolBuyData,
  poolSellData,
  pumpBuyExactQuoteInV2Ix,
  pumpCreateV2Ix,
  sweepCreatorFeeIx,
  sweepPoolCreatorFeeIx,
  transferCreatorFeesToPumpV2Ix,
  updateFeeSharesV2Ix,
} from "./pump";
import {
  descriptorToIdl,
  copierProgram,
  paramsToIdl,
  type CopierAccount,
  type CopierIdl,
  type PendingChangeAccount,
  type ProgramParams,
  type TradeDescriptor,
  type TradeSide,
} from "./program";
import { venueTradeAccounts, type VenueAccounts } from "./venue";

// ---------------------------------------------------------------------------------------------
// IDL-driven instruction assembly
// ---------------------------------------------------------------------------------------------

type IxName = CopierIdl["instructions"][number]["name"];
type IxAccounts<N extends IxName> = Record<Extract<CopierIdl["instructions"][number], { name: N }>["accounts"][number]["name"], PublicKey>;

const bn = (v: bigint | number) => new BN(v.toString());

/**
 * One Copier instruction: `accounts` by IDL name (every account required, checked at compile time),
 * flags from the IDL, `remaining` appended verbatim.
 */
function copierIx<N extends IxName>(
  name: N,
  args: Record<string, unknown>,
  accounts: IxAccounts<N>,
  remaining: AccountMeta[] = [],
): TransactionInstruction {
  const program = copierProgram();
  const def = program.idl.instructions.find((i) => i.name === name);
  if (!def) throw new Error(`copier IDL has no instruction ${name}`);
  const named = accounts as Record<string, PublicKey>;
  const keys: AccountMeta[] = def.accounts.map((a) => {
    if (!("name" in a) || "accounts" in a) throw new Error(`nested account groups are not supported (${name})`);
    const pubkey = named[a.name];
    if (!pubkey) throw new Error(`${name}: missing account ${a.name}`);
    // An omitted optional account is passed as the program id, read-only (Anchor's `None`).
    const none = "optional" in a && a.optional && pubkey.equals(COPIER_PROGRAM_ID);
    return { pubkey, isSigner: "signer" in a && a.signer, isWritable: !none && "writable" in a && a.writable };
  });
  return new TransactionInstruction({
    programId: COPIER_PROGRAM_ID,
    keys: [...keys, ...remaining],
    data: program.coder.instruction.encode(name, args),
  });
}

/** `["<programId>"]` under the upgradeable loader: the program's ProgramData account. */
export function programDataPda(programId = COPIER_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([programId.toBuffer()], new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"))[0];
}

// ---------------------------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------------------------

/**
 * `initialize_config(keeper, timelock_secs)`: once, by the program's upgrade authority; seeds the
 * default params and descriptors and fixes the admin timelock (60 s – 7 days).
 */
export function buildInitializeConfigIx(p: { admin: PublicKey; keeper: PublicKey; timelockSecs: number }): TransactionInstruction[] {
  if (!Number.isInteger(p.timelockSecs) || p.timelockSecs < MIN_TIMELOCK_SECS || p.timelockSecs > MAX_TIMELOCK_SECS) {
    throw new Error(`timelock must be ${MIN_TIMELOCK_SECS}–${MAX_TIMELOCK_SECS} s, got ${p.timelockSecs}`);
  }
  return [
    copierIx("initializeConfig", { keeper: p.keeper, timelockSecs: bn(p.timelockSecs) }, {
      admin: p.admin,
      config: configPda(),
      programData: programDataPda(),
      burnPool: burnPoolPda(),
      systemProgram: SYSTEM_PROGRAM_ID,
    }),
  ];
}

/** Names of the params outside `PARAM_RANGES` (empty when `propose_params` would accept them). */
export function paramsOutOfRange(params: ProgramParams): (keyof ProgramParams)[] {
  return (Object.keys(PARAM_RANGES) as (keyof ProgramParams)[]).filter((k) => {
    const { min, max } = PARAM_RANGES[k];
    const v = params[k];
    return v < min || v > max;
  });
}

/** Accounts of every `propose_*` but index targets: the PendingChange PDA is `["pending", changeId]`. */
const proposeAccounts = (admin: PublicKey, changeId: bigint) => ({
  admin,
  config: configPda(),
  pending: pendingChangePda(changeId),
  systemProgram: SYSTEM_PROGRAM_ID,
});

/** `propose_keeper(keeper)`: timelocked keeper change. `changeId` = `config.nextChangeId`. */
export function buildProposeKeeperIx(p: { admin: PublicKey; keeper: PublicKey; changeId: bigint }): TransactionInstruction[] {
  return [copierIx("proposeKeeper", { keeper: p.keeper }, proposeAccounts(p.admin, p.changeId))];
}

/** `propose_params(params)`: timelocked params change; throws on params outside `PARAM_RANGES`. */
export function buildProposeParamsIx(p: { admin: PublicKey; params: ProgramParams; changeId: bigint }): TransactionInstruction[] {
  const bad = paramsOutOfRange(p.params);
  if (bad.length) throw new Error(`params out of range: ${bad.join(", ")}`);
  return [copierIx("proposeParams", { params: paramsToIdl(p.params) }, proposeAccounts(p.admin, p.changeId))];
}

const sameDescriptor = (a: TradeDescriptor, b: TradeDescriptor) =>
  a.program.equals(b.program) &&
  a.side === b.side &&
  a.venue === b.venue &&
  a.userIdx === b.userIdx &&
  a.baseMintIdx === b.baseMintIdx &&
  a.venueIdx === b.venueIdx &&
  a.minAccounts === b.minAccounts &&
  a.disc.length === b.disc.length &&
  a.disc.every((x, i) => x === b.disc[i]);

/**
 * The program's descriptor rules (`validate_descriptors`), checked before proposing: ≤ 32 entries;
 * curve entries on pump, pool entries on pump_amm; distinct user / mint / venue indices below
 * `minAccounts` ≤ 40; a Buy and a Sell for both venues; and, against the live list, a Sell per venue
 * byte-identical to a proven one (`config.descriptorsProven`). Returns the new list's proven bitmask.
 * The program additionally rejects non-trade pump discriminators (`DescriptorDiscForbidden`).
 */
export function validateDescriptors(
  next: TradeDescriptor[],
  current?: { descriptors: TradeDescriptor[]; descriptorsProven: number },
): number {
  if (next.length > MAX_DESCRIPTORS) throw new Error(`TooManyDescriptors: ${next.length} > ${MAX_DESCRIPTORS}`);
  next.forEach((d, i) => {
    const program = d.venue === "curve" ? PUMP_PROGRAM_ID : PUMP_AMM_PROGRAM_ID;
    if (!d.program.equals(program)) throw new Error(`DescriptorProgramNotAllowed: descriptor ${i}`);
    const ok =
      Math.max(d.userIdx, d.baseMintIdx, d.venueIdx) < d.minAccounts &&
      d.minAccounts <= MAX_DESCRIPTOR_ACCOUNTS &&
      d.userIdx !== d.baseMintIdx &&
      d.userIdx !== d.venueIdx &&
      d.baseMintIdx !== d.venueIdx;
    if (!ok) throw new Error(`DescriptorIndices: descriptor ${i}`);
  });
  for (const venue of ["curve", "pool"] as const) {
    for (const side of ["buy", "sell"] as const) {
      if (!next.some((d) => d.venue === venue && d.side === side)) throw new Error(`DescriptorsIncomplete: no ${venue} ${side}`);
    }
  }
  if (!current) return next.length >= 32 ? 0xffff_ffff : 2 ** next.length - 1;
  const proven = (d: TradeDescriptor) =>
    current.descriptors.some((c, j) => sameDescriptor(c, d) && ((current.descriptorsProven >>> j) & 1) === 1);
  const mask = next.reduce((m, d, i) => (proven(d) ? (m | (1 << i)) >>> 0 : m), 0);
  for (const venue of ["curve", "pool"] as const) {
    if (!next.some((d, i) => d.venue === venue && d.side === "sell" && ((mask >>> i) & 1) === 1)) {
      throw new Error(`DescriptorsDropProvenExit: no proven ${venue} sell kept`);
    }
  }
  return mask;
}

/**
 * `propose_descriptors(descriptors)`: timelocked whitelist change. Pass the live `config` to check
 * the program's rules first (`validateDescriptors`).
 */
export function buildProposeDescriptorsIx(p: {
  admin: PublicKey;
  descriptors: TradeDescriptor[];
  changeId: bigint;
  config?: { descriptors: TradeDescriptor[]; descriptorsProven: number };
}): TransactionInstruction[] {
  validateDescriptors(p.descriptors, p.config);
  return [copierIx("proposeDescriptors", { descriptors: p.descriptors.map(descriptorToIdl) }, proposeAccounts(p.admin, p.changeId))];
}

/** The PendingChange fields `execute_pending` / `cancel_pending` need (`copier` is the Copier state PDA). */
export type PendingChangeRef = Pick<PendingChangeAccount, "id" | "kind" | "proposer" | "copier">;

/**
 * `execute_pending`: applies a proposal between its `eta` and `expiresAt` while it is still its kind's
 * live change (`pendingChangeStatus` = "executable"). Permissionless and signer-free (any fee payer);
 * closes the PendingChange and returns its rent to the proposer.
 */
export function buildExecutePendingIx(p: { change: PendingChangeRef }): TransactionInstruction[] {
  const { change } = p;
  return [
    copierIx("executePending", {}, {
      config: configPda(),
      pending: pendingChangePda(change.id),
      proposer: change.proposer,
      // Optional account: only IndexTargets changes touch a copier; Anchor's `None` is the program id.
      copier: change.kind === "indexTargets" ? change.copier : COPIER_PROGRAM_ID,
    }),
  ];
}

/** `cancel_pending` (admin): drops a proposal before it executes. */
export function buildCancelPendingIx(p: { admin: PublicKey; change: PendingChangeRef }): TransactionInstruction[] {
  return [
    copierIx("cancelPending", {}, {
      admin: p.admin,
      config: configPda(),
      pending: pendingChangePda(p.change.id),
      proposer: p.change.proposer,
    }),
  ];
}

/**
 * `discard_pending` (permissionless, signer-free): closes a superseded or expired PendingChange and
 * returns its rent to the proposer (`pendingChangeStatus` tells which ones qualify).
 */
export function buildDiscardPendingIx(p: { change: Pick<PendingChangeAccount, "id" | "proposer"> }): TransactionInstruction[] {
  return [
    copierIx("discardPending", {}, {
      config: configPda(),
      pending: pendingChangePda(p.change.id),
      proposer: p.change.proposer,
    }),
  ];
}

/** `pause_keeper` (admin, instant): clears `config.keeper`; a new keeper then needs `propose_keeper`. */
export function buildPauseKeeperIx(p: { admin: PublicKey }): TransactionInstruction[] {
  return [copierIx("pauseKeeper", {}, { admin: p.admin, config: configPda() })];
}

/**
 * `keeper_heartbeat` (keeper): proves liveness. Exits turn permissionless once no heartbeat (or
 * keeper-signed trade / burn) landed for `keeperGraceSecs`.
 */
export function buildKeeperHeartbeatIx(p: { keeper: PublicKey }): TransactionInstruction[] {
  return [copierIx("keeperHeartbeat", {}, { keeper: p.keeper, config: configPda() })];
}

/** `propose_admin(new_admin)`: `accept_admin` opens after `config.timelockSecs`. */
export function buildProposeAdminIx(p: { admin: PublicKey; newAdmin: PublicKey }): TransactionInstruction[] {
  return [copierIx("proposeAdmin", { newAdmin: p.newAdmin }, { admin: p.admin, config: configPda() })];
}

export function buildAcceptAdminIx(p: { pendingAdmin: PublicKey }): TransactionInstruction[] {
  return [copierIx("acceptAdmin", {}, { pendingAdmin: p.pendingAdmin, config: configPda() })];
}

/** `set_platform_mint(mint)`: once; `mint` must be a registered Index copier. */
export function buildSetPlatformMintIx(p: { admin: PublicKey; mint: PublicKey }): TransactionInstruction[] {
  return [copierIx("setPlatformMint", { mint: p.mint }, { admin: p.admin, config: configPda(), copier: copierPda(p.mint) })];
}

// ---------------------------------------------------------------------------------------------
// Launch / registration
// ---------------------------------------------------------------------------------------------

function checkTraderBps(traderBps: number): void {
  if (!Number.isInteger(traderBps) || traderBps < TRADER_MIN_BPS || traderBps > TRADER_MAX_BPS) {
    throw new Error(`target cut must be ${TRADER_MIN_BPS}–${TRADER_MAX_BPS} bps, got ${traderBps}`);
  }
}

function checkTargets(targets: PublicKey[], mint: PublicKey): void {
  if (targets.length === 0 || targets.length > MAX_INDEX_TARGETS) throw new Error(`1–${MAX_INDEX_TARGETS} targets required`);
  if (new Set(targets.map(String)).size !== targets.length) throw new Error("duplicate target");
  if (targets.some((t) => t.equals(vaultPda(mint)))) throw new Error("the vault cannot be a target");
}

/** `register_copier(trader_bps)`: the launcher registers a Single copier after the fee-sharing setup. */
export function buildRegisterCopierIx(p: { launcher: PublicKey; mint: PublicKey; target: PublicKey; traderBps: number }): TransactionInstruction[] {
  checkTraderBps(p.traderBps);
  return [
    copierIx("registerCopier", { traderBps: p.traderBps }, {
      launcher: p.launcher,
      config: configPda(),
      mint: p.mint,
      bondingCurve: bondingCurvePda(p.mint),
      sharingConfig: sharingConfigPda(p.mint),
      target: p.target,
      vault: vaultPda(p.mint),
      copier: copierPda(p.mint),
      systemProgram: SYSTEM_PROGRAM_ID,
    }),
  ];
}

/** `register_index(targets)` (admin): an Index copier whose vault takes 100% of creator fees. */
export function buildRegisterIndexIx(p: { admin: PublicKey; mint: PublicKey; targets: PublicKey[] }): TransactionInstruction[] {
  checkTargets(p.targets, p.mint);
  return [
    copierIx("registerIndex", { targets: p.targets }, {
      admin: p.admin,
      config: configPda(),
      mint: p.mint,
      bondingCurve: bondingCurvePda(p.mint),
      sharingConfig: sharingConfigPda(p.mint),
      vault: vaultPda(p.mint),
      copier: copierPda(p.mint),
      systemProgram: SYSTEM_PROGRAM_ID,
    }),
  ];
}

/**
 * `propose_index_targets(targets)` (admin, Index copiers): a timelocked change; it applies on
 * `execute_pending` after `config.timelockSecs`.
 */
export function buildProposeIndexTargetsIx(p: { admin: PublicKey; mint: PublicKey; targets: PublicKey[]; changeId: bigint }): TransactionInstruction[] {
  checkTargets(p.targets, p.mint);
  return [
    copierIx("proposeIndexTargets", { targets: p.targets }, {
      admin: p.admin,
      config: configPda(),
      copier: copierPda(p.mint),
      pending: pendingChangePda(p.changeId),
      systemProgram: SYSTEM_PROGRAM_ID,
    }),
  ];
}

/**
 * The launch transaction's instructions (SPEC §1): pump `create_v2(creator = launcher)` →
 * `create_fee_sharing_config` → `update_fee_shares_v2([{target, X}, {vault, 10000 − X}])` (admin
 * revoked: the split is final) → `register_copier(X)`. Signers: launcher and the mint keypair.
 * Compile it as a v0 tx with the Copier platform ALT (`platformLookupTableAddresses`) and
 * `LAUNCH_COMPUTE_UNITS`.
 */
export function buildLaunchIxs(p: {
  launcher: PublicKey;
  mint: PublicKey;
  name: string;
  symbol: string;
  uri: string;
  target: PublicKey;
  traderBps: number;
}): TransactionInstruction[] {
  checkTraderBps(p.traderBps);
  const vault = vaultPda(p.mint);
  if (p.target.equals(vault)) throw new Error("the vault cannot be the target");
  return [
    pumpCreateV2Ix({ mint: p.mint, user: p.launcher, creator: p.launcher, name: p.name, symbol: p.symbol, uri: p.uri }),
    createFeeSharingConfigIx({ payer: p.launcher, mint: p.mint }),
    updateFeeSharesV2Ix({
      authority: p.launcher,
      mint: p.mint,
      shareholders: [
        { address: p.target, shareBps: p.traderBps },
        { address: vault, shareBps: 10_000 - p.traderBps },
      ],
      currentShareholders: [p.launcher],
    }),
    ...buildRegisterCopierIx({ launcher: p.launcher, mint: p.mint, target: p.target, traderBps: p.traderBps }),
  ];
}

/** An Index copier launch (admin): create_v2 + fee sharing `[{vault, 10000}]` + `register_index(targets)`. */
export function buildLaunchIndexIxs(p: {
  admin: PublicKey;
  mint: PublicKey;
  name: string;
  symbol: string;
  uri: string;
  targets: PublicKey[];
}): TransactionInstruction[] {
  checkTargets(p.targets, p.mint);
  return [
    pumpCreateV2Ix({ mint: p.mint, user: p.admin, creator: p.admin, name: p.name, symbol: p.symbol, uri: p.uri }),
    createFeeSharingConfigIx({ payer: p.admin, mint: p.mint }),
    updateFeeSharesV2Ix({
      authority: p.admin,
      mint: p.mint,
      shareholders: [{ address: vaultPda(p.mint), shareBps: 10_000 }],
      currentShareholders: [p.admin],
    }),
    ...buildRegisterIndexIx({ admin: p.admin, mint: p.mint, targets: p.targets }),
  ];
}

/**
 * The optional dev buy (second tx / Jito bundle after the launch): idempotent ATA create + pump
 * `buy_exact_quote_in_v2` paying the creator fee into `creator_vault(sharing_config)`.
 */
export function buildDevBuyIxs(p: { buyer: PublicKey; mint: PublicKey; solIn: bigint; minTokensOut: bigint }): TransactionInstruction[] {
  return [
    createAssociatedTokenAccountIdempotentInstruction(p.buyer, ata(p.buyer, p.mint), p.buyer, p.mint, TOKEN_2022_PROGRAM_ID),
    pumpBuyExactQuoteInV2Ix({
      user: p.buyer,
      mint: p.mint,
      creator: sharingConfigPda(p.mint),
      solIn: p.solIn,
      minTokensOut: p.minTokensOut,
    }),
  ];
}

// ---------------------------------------------------------------------------------------------
// Vault bookkeeping
// ---------------------------------------------------------------------------------------------

/** `deposit(lamports)`: capital (not profit) into a copier's vault. */
export function buildDepositIx(p: { depositor: PublicKey; mint: PublicKey; lamports: bigint }): TransactionInstruction[] {
  const vault = vaultPda(p.mint);
  return [
    copierIx("deposit", { lamports: bn(p.lamports) }, {
      depositor: p.depositor,
      copier: copierPda(p.mint),
      vault,
      vaultWsol: wsolAta(vault),
      systemProgram: SYSTEM_PROGRAM_ID,
    }),
  ];
}

/** `sync`: books lamports the vault received without the program (creator fees) as `fees_in`. */
export function buildSyncIx(p: { mint: PublicKey }): TransactionInstruction[] {
  const vault = vaultPda(p.mint);
  return [copierIx("sync", {}, { copier: copierPda(p.mint), vault, vaultWsol: wsolAta(vault) })];
}

/** `verify_trader(target_idx)`: the target wallet signs to mark itself verified on this copier. */
export function buildVerifyTraderIx(p: { target: PublicKey; mint: PublicKey; targetIdx: number }): TransactionInstruction[] {
  return [copierIx("verifyTrader", { targetIdx: p.targetIdx }, { target: p.target, copier: copierPda(p.mint) })];
}

export function buildUnverifyTraderIx(p: { target: PublicKey; mint: PublicKey; targetIdx: number }): TransactionInstruction[] {
  return [copierIx("unverifyTrader", { targetIdx: p.targetIdx }, { target: p.target, copier: copierPda(p.mint) })];
}

/** `fund_platform_burn`: moves the copier's pending 25% the platform token share to the burn pool (permissionless). */
export function buildFundPlatformBurnIx(p: { mint: PublicKey }): TransactionInstruction[] {
  const vault = vaultPda(p.mint);
  return [
    copierIx("fundPlatformBurn", {}, {
      config: configPda(),
      copier: copierPda(p.mint),
      vault,
      vaultWsol: wsolAta(vault),
      burnPool: burnPoolPda(),
      systemProgram: SYSTEM_PROGRAM_ID,
    }),
  ];
}

/** Fee shareholders of a copier in sharing-config order (as `buildLaunchIxs` / `buildLaunchIndexIxs` set them). */
export function copierShareholders(copier: Pick<CopierAccount, "kind" | "targets" | "mint">): PublicKey[] {
  const vault = vaultPda(copier.mint);
  return copier.kind === "single" ? [copier.targets[0]!, vault] : [vault];
}

/**
 * The permissionless creator-fee crank: after graduation the pool's `sweep_creator_fee` +
 * `transfer_creator_fees_to_pump_v2` (only when the pool holds creator fees or the AMM creator vault's
 * wSOL ATA exists; else transfer fails 3012) → pump `sweep_creator_fee` (curve v3 bucket) → `distribute_creator_fees_v2`
 * to `shareholders` (sharing-config order, see `copierShareholders`) → copier `sync` (unless `sync: false`).
 */
export function buildDistributeFeesIxs(p: {
  payer: PublicKey;
  mint: PublicKey;
  graduated: boolean;
  shareholders: PublicKey[];
  sync?: boolean;
}): TransactionInstruction[] {
  const sc = sharingConfigPda(p.mint);
  const ixs: TransactionInstruction[] = [];
  if (p.graduated) {
    ixs.push(
      sweepPoolCreatorFeeIx({ payer: p.payer, pool: canonicalPoolKeys(p.mint), coinCreator: sc }),
      transferCreatorFeesToPumpV2Ix({ payer: p.payer, coinCreator: sc }),
    );
  }
  ixs.push(sweepCreatorFeeIx({ payer: p.payer, mint: p.mint, creator: sc }));
  ixs.push(distributeCreatorFeesV2Ix({ payer: p.payer, mint: p.mint, shareholders: p.shareholders }));
  if (p.sync ?? true) ixs.push(...buildSyncIx({ mint: p.mint }));
  return ixs;
}

/** SPL Memo (no signers), e.g. `copier:<target signature>` on every copy trade. */
export function memoIx(text: string): TransactionInstruction {
  return new TransactionInstruction({ programId: MEMO_PROGRAM_ID, keys: [], data: Buffer.from(text, "utf8") });
}

// ---------------------------------------------------------------------------------------------
// Trades
// ---------------------------------------------------------------------------------------------

const DEFAULT_DESCRIPTOR = (program: PublicKey, disc: Uint8Array, side: TradeSide, venue: "curve" | "pool", idx: { user: number; baseMint: number; venue: number }, minAccounts: number): TradeDescriptor => ({
  program,
  disc,
  side,
  venue,
  userIdx: idx.user,
  baseMintIdx: idx.baseMint,
  venueIdx: idx.venue,
  minAccounts,
});

const V2_CURVE = { user: 13, baseMint: 1, venue: 10 };

/** The descriptors `initialize_config` seeds, in on-chain order (programs/copy-vault state.rs `default_descriptors`). */
export const DEFAULT_DESCRIPTORS: TradeDescriptor[] = [
  DEFAULT_DESCRIPTOR(PUMP_PROGRAM_ID, PUMP_IX.buyV3, "buy", "curve", CURVE_V3_INDEX, 17),
  DEFAULT_DESCRIPTOR(PUMP_PROGRAM_ID, PUMP_IX.sellV3, "sell", "curve", CURVE_V3_INDEX, 17),
  DEFAULT_DESCRIPTOR(PUMP_PROGRAM_ID, PUMP_IX.buyExactQuoteInV3, "buy", "curve", CURVE_V3_INDEX, 17),
  DEFAULT_DESCRIPTOR(PUMP_PROGRAM_ID, PUMP_IX.buyV2, "buy", "curve", V2_CURVE, 27),
  DEFAULT_DESCRIPTOR(PUMP_PROGRAM_ID, PUMP_IX.sellV2, "sell", "curve", V2_CURVE, 26),
  DEFAULT_DESCRIPTOR(PUMP_PROGRAM_ID, PUMP_IX.buyExactQuoteInV2, "buy", "curve", V2_CURVE, 27),
  DEFAULT_DESCRIPTOR(PUMP_AMM_PROGRAM_ID, PUMP_AMM_IX.buyExactQuoteInV2, "buy", "pool", POOL_V2_INDEX, 17),
  DEFAULT_DESCRIPTOR(PUMP_AMM_PROGRAM_ID, PUMP_AMM_IX.sellV2, "sell", "pool", POOL_V2_INDEX, 17),
  DEFAULT_DESCRIPTOR(PUMP_AMM_PROGRAM_ID, PUMP_AMM_IX.buyExactQuoteIn, "buy", "pool", POOL_V2_INDEX, 23),
  DEFAULT_DESCRIPTOR(PUMP_AMM_PROGRAM_ID, PUMP_AMM_IX.sell, "sell", "pool", POOL_V2_INDEX, 21),
];

/** Index of the (program, disc, side) descriptor in `descriptors`; throws when it is not whitelisted. */
export function findDescriptorIdx(descriptors: TradeDescriptor[], program: PublicKey, disc: Uint8Array, side: TradeSide): number {
  const i = descriptors.findIndex(
    (d) => d.program.equals(program) && d.side === side && d.disc.length === disc.length && d.disc.every((b, j) => b === disc[j]),
  );
  if (i < 0) throw new Error(`venue instruction ${Buffer.from(disc).toString("hex")} (${side}) is not whitelisted`);
  return i;
}

/** A resolved venue (`resolveVenue` result of kind curve / pool, or just its accounts). */
export type TradeVenue = { accounts: VenueAccounts } | VenueAccounts;

const venueAccountsOf = (v: TradeVenue): VenueAccounts => ("accounts" in v ? v.accounts : v);

/** The venue instruction a trade forwards: curve v3 / AMM v2, its data and its 17 accounts for `user`. */
function venueCall(venue: VenueAccounts, user: PublicKey, side: TradeSide, amountIn: bigint, minOut: bigint, descriptors: TradeDescriptor[], descriptorIdx?: number) {
  const curve = venue.kind === "curve";
  const program = curve ? PUMP_PROGRAM_ID : PUMP_AMM_PROGRAM_ID;
  const data =
    side === "buy"
      ? curve
        ? curveBuyData(amountIn, minOut)
        : poolBuyData(amountIn, minOut)
      : curve
        ? curveSellData(amountIn, minOut)
        : poolSellData(amountIn, minOut);
  const idx = descriptorIdx ?? findDescriptorIdx(descriptors, program, data.subarray(0, 8), side);
  return { descriptorIdx: idx, ixData: data, remaining: venueTradeAccounts(venue, user) };
}

interface TradeCommon {
  mint: PublicKey;
  targetIdx: number;
  /** `copier.targets[targetIdx]`. */
  target: PublicKey;
  tokenMint: PublicKey;
  venue: TradeVenue;
  /** `config.descriptors` (defaults to `DEFAULT_DESCRIPTORS`). */
  descriptors?: TradeDescriptor[];
  descriptorIdx?: number;
}

function tradeAccounts(p: TradeCommon) {
  const venue = venueAccountsOf(p.venue);
  if (!venue.tokenMint.equals(p.tokenMint)) throw new Error("venue is for another token");
  const vault = vaultPda(p.mint);
  return {
    venue,
    vault,
    named: {
      config: configPda(),
      copier: copierPda(p.mint),
      vault,
      tokenMint: p.tokenMint,
      position: positionPda(p.mint, p.tokenMint),
      target: p.target,
      targetTokenAccount: ata(p.target, p.tokenMint, venue.tokenProgram),
      vaultTokenAccount: ata(vault, p.tokenMint, venue.tokenProgram),
      vaultWsol: wsolAta(vault),
      tokenProgram: venue.tokenProgram,
      quoteTokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SYSTEM_PROGRAM_ID,
      instructions: INSTRUCTIONS_SYSVAR_ID,
    },
  };
}

/**
 * `copier_buy`: the vault copies `target`'s buy of `tokenMint` with `solIn` lamports. Curve venues
 * forward pump `buy_exact_quote_in_v3`, pools pump_amm `buy_exact_quote_in_v2`; the program creates
 * the vault's ATAs and wraps wSOL itself.
 *
 * Transaction rule (`VenueTouchedInTx`): a copy-vault trade or burn is the only non-trivial instruction of
 * its top-level transaction; ComputeBudget, Memo (`memoIx`), ATA create_idempotent and System transfer
 * (Jito tip) may join it as long as they do not list the curve / pool.
 */
export function buildCopierBuyIx(p: TradeCommon & { keeper: PublicKey; solIn: bigint; minTokensOut: bigint }): TransactionInstruction[] {
  const { venue, vault, named } = tradeAccounts(p);
  const call = venueCall(venue, vault, "buy", p.solIn, p.minTokensOut, p.descriptors ?? DEFAULT_DESCRIPTORS, p.descriptorIdx);
  return [
    copierIx(
      "copierBuy",
      { targetIdx: p.targetIdx, descriptorIdx: call.descriptorIdx, solIn: bn(p.solIn), minTokensOut: bn(p.minTokensOut), ixData: call.ixData },
      { keeper: p.keeper, ...named },
      call.remaining,
    ),
  ];
}

/**
 * `copier_sell`: the vault sells `tokensIn` (≤ `allowedSell`). `authority` is the keeper, or anyone
 * once no keeper heartbeat landed for `keeperGraceSecs` and the target holds nothing — then in
 * impact-capped slices (`publicSellMaxTokens`), one per copier per slot. Own transaction (see `buildCopierBuyIx`).
 */
export function buildCopierSellIx(p: TradeCommon & { authority: PublicKey; tokensIn: bigint; minSolOut: bigint }): TransactionInstruction[] {
  const { venue, vault, named } = tradeAccounts(p);
  const call = venueCall(venue, vault, "sell", p.tokensIn, p.minSolOut, p.descriptors ?? DEFAULT_DESCRIPTORS, p.descriptorIdx);
  return [
    copierIx(
      "copierSell",
      { targetIdx: p.targetIdx, descriptorIdx: call.descriptorIdx, tokensIn: bn(p.tokensIn), minSolOut: bn(p.minSolOut), ixData: call.ixData },
      { authority: p.authority, burnPool: burnPoolPda(), ...named },
      call.remaining,
    ),
  ];
}

/**
 * `buyback_burn`: the vault spends `solIn` (≤ min(buyback pool, `maxImpactBps` of the venue's real SOL))
 * on its own coin and burns it. Own transaction (see `buildCopierBuyIx`).
 */
export function buildBuybackBurnIx(p: {
  keeper: PublicKey;
  mint: PublicKey;
  solIn: bigint;
  minTokensOut: bigint;
  venue: TradeVenue;
  descriptors?: TradeDescriptor[];
  descriptorIdx?: number;
}): TransactionInstruction[] {
  const venue = venueAccountsOf(p.venue);
  if (!venue.tokenMint.equals(p.mint)) throw new Error("buyback venue must be the copier's own coin");
  const vault = vaultPda(p.mint);
  const call = venueCall(venue, vault, "buy", p.solIn, p.minTokensOut, p.descriptors ?? DEFAULT_DESCRIPTORS, p.descriptorIdx);
  return [
    copierIx(
      "buybackBurn",
      { descriptorIdx: call.descriptorIdx, solIn: bn(p.solIn), minTokensOut: bn(p.minTokensOut), ixData: call.ixData },
      {
        keeper: p.keeper,
        config: configPda(),
        copier: copierPda(p.mint),
        vault,
        mint: p.mint,
        vaultTokenAccount: ata(vault, p.mint, venue.tokenProgram),
        vaultWsol: wsolAta(vault),
        tokenProgram: venue.tokenProgram,
        quoteTokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SYSTEM_PROGRAM_ID,
        instructions: INSTRUCTIONS_SYSVAR_ID,
      },
      call.remaining,
    ),
  ];
}

/**
 * `burn_platform`: the burn pool spends `solIn` on the platform token (`config.platform_mint`) and burns it.
 * `solIn` ≤ `maxImpactBps` of the venue's real SOL; ≥ 60 s between calls. Own transaction (see `buildCopierBuyIx`).
 */
export function buildBurnPlatformIx(p: {
  keeper: PublicKey;
  platformMint: PublicKey;
  solIn: bigint;
  minTokensOut: bigint;
  venue: TradeVenue;
  descriptors?: TradeDescriptor[];
  descriptorIdx?: number;
}): TransactionInstruction[] {
  const venue = venueAccountsOf(p.venue);
  if (!venue.tokenMint.equals(p.platformMint)) throw new Error("burn venue must be the platform token's");
  const burnPool = burnPoolPda();
  const call = venueCall(venue, burnPool, "buy", p.solIn, p.minTokensOut, p.descriptors ?? DEFAULT_DESCRIPTORS, p.descriptorIdx);
  return [
    copierIx(
      "burnPlatform",
      { descriptorIdx: call.descriptorIdx, solIn: bn(p.solIn), minTokensOut: bn(p.minTokensOut), ixData: call.ixData },
      {
        keeper: p.keeper,
        config: configPda(),
        burnPool,
        platformMint: p.platformMint,
        burnPoolTokenAccount: ata(burnPool, p.platformMint, venue.tokenProgram),
        burnPoolWsol: wsolAta(burnPool),
        tokenProgram: venue.tokenProgram,
        quoteTokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SYSTEM_PROGRAM_ID,
        instructions: INSTRUCTIONS_SYSVAR_ID,
      },
      call.remaining,
    ),
  ];
}
