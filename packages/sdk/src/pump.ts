/**
 * Raw pump / pump_amm / pump_fees instructions, account lists exactly as in src/idl/pump*.json (crate
 * pump-rust-client 0.2.0 IDLs, which have the live v3 / AMM v2 interfaces). Tested account-by-account
 * against the IDLs in src/pump.test.ts.
 */
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
} from "@solana/spl-token";
import { SystemProgram, TransactionInstruction, type AccountMeta, PublicKey } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  MAYHEM_PROGRAM_ID,
  PUMP_AMM_IX,
  PUMP_AMM_PROGRAM_ID,
  PUMP_BUYBACK_FEE_RECIPIENTS,
  PUMP_FEE_RECIPIENTS,
  PUMP_FEES_IX,
  PUMP_FEES_PROGRAM_ID,
  PUMP_IX,
  PUMP_PROGRAM_ID,
  RENT_SYSVAR_ID,
  SYSTEM_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  WSOL_MINT,
} from "./constants";
import { BorshWriter, type Shareholder } from "./layout";
import {
  ammCreatorVaultAuthority,
  ammEventAuthorityPda,
  ammGlobalConfigPda,
  ammLpMintPda,
  ammUserVolumeAccumulatorPda,
  ata,
  bondingCurvePda,
  canonicalPoolPda,
  creatorVaultPda,
  feeConfigPda,
  mayhemGlobalParamsPda,
  mayhemSolVaultPda,
  mayhemStatePda,
  mayhemTokenVault,
  poolAuthorityPda,
  pumpEventAuthorityPda,
  pumpGlobalPda,
  pumpGlobalVolumeAccumulatorPda,
  pumpMintAuthorityPda,
  pumpUserVolumeAccumulatorPda,
  sharingConfigPda,
  wsolAta,
} from "./pda";

export const ro = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: false });
export const rw = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: true });
const signer = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: true, isWritable: true });

/** A uniformly random element (fee recipients are spread to avoid write-lock contention). */
export function pickRandom<T>(list: readonly T[]): T {
  if (list.length === 0) throw new Error("cannot pick from an empty list");
  return list[Math.floor(Math.random() * list.length)]!;
}

// ---------------------------------------------------------------------------------------------
// Launch: create_v2, create_fee_sharing_config, update_fee_shares_v2
// ---------------------------------------------------------------------------------------------

/** pump `create_v2` of a SOL-quoted Token-2022 coin (cashback off, schedule creator fee, no holder rewards). */
export function pumpCreateV2Ix(p: {
  mint: PublicKey;
  /** Pays and signs. */
  user: PublicKey;
  /** Receives creator fees until a sharing config takes over. */
  creator: PublicKey;
  name: string;
  symbol: string;
  uri: string;
  mayhem?: boolean;
}): TransactionInstruction {
  const curve = bondingCurvePda(p.mint);
  const data = new BorshWriter()
    .raw(PUMP_IX.createV2)
    .string(p.name)
    .string(p.symbol)
    .string(p.uri)
    .pubkey(p.creator)
    .bool(p.mayhem ?? false)
    .bool(false) // is_cashback_enabled: OptionBool (cashback is deprecated)
    .u64(0) // creator_fee_bps: OptionU64 (ignored on SOL coins)
    .bool(false) // is_holder_reward: OptionBool (incompatible with fee sharing)
    .build();
  return new TransactionInstruction({
    programId: PUMP_PROGRAM_ID,
    keys: [
      signer(p.mint),
      ro(pumpMintAuthorityPda()),
      rw(curve),
      rw(ata(curve, p.mint, TOKEN_2022_PROGRAM_ID)),
      ro(pumpGlobalPda()),
      signer(p.user),
      ro(SYSTEM_PROGRAM_ID),
      ro(TOKEN_2022_PROGRAM_ID),
      ro(ASSOCIATED_TOKEN_PROGRAM_ID),
      rw(MAYHEM_PROGRAM_ID),
      ro(mayhemGlobalParamsPda()),
      rw(mayhemSolVaultPda()),
      rw(mayhemStatePda(p.mint)),
      rw(mayhemTokenVault(p.mint)),
      ro(pumpEventAuthorityPda()),
      ro(PUMP_PROGRAM_ID),
    ],
    data,
  });
}

/**
 * pump_fees `create_fee_sharing_config` for a coin still on its curve: makes the sharing config the
 * curve's creator with `[payer: 100%]`. The optional pool accounts are passed as Anchor's
 * `None` placeholder (the pump_fees program id).
 */
export function createFeeSharingConfigIx(p: { payer: PublicKey; mint: PublicKey }): TransactionInstruction {
  return new TransactionInstruction({
    programId: PUMP_FEES_PROGRAM_ID,
    keys: [
      ro(pumpFeesEventAuthorityPda()),
      ro(PUMP_FEES_PROGRAM_ID),
      signer(p.payer),
      ro(pumpGlobalPda()),
      ro(p.mint),
      rw(sharingConfigPda(p.mint)),
      ro(SYSTEM_PROGRAM_ID),
      rw(bondingCurvePda(p.mint)),
      ro(PUMP_PROGRAM_ID),
      ro(pumpEventAuthorityPda()),
      ro(PUMP_FEES_PROGRAM_ID), // pool: None
      ro(PUMP_FEES_PROGRAM_ID), // pump_amm_program: None
      ro(PUMP_FEES_PROGRAM_ID), // pump_amm_event_authority: None
    ],
    data: Buffer.from(PUMP_FEES_IX.createFeeSharingConfig),
  });
}

export function pumpFeesEventAuthorityPda(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], PUMP_FEES_PROGRAM_ID)[0];
}

/**
 * pump_fees `update_fee_shares_v2` of a SOL coin: sets `shareholders` (sum 10_000 bps, ≤ 10, no
 * duplicates) and revokes the admin, so the split is final. `currentShareholders` (in config order)
 * are paid any pending fees first; right after `create_fee_sharing_config` that is `[authority]`.
 */
export function updateFeeSharesV2Ix(p: {
  authority: PublicKey;
  mint: PublicKey;
  shareholders: Shareholder[];
  currentShareholders: PublicKey[];
}): TransactionInstruction {
  const { shareholders } = p;
  if (shareholders.length === 0 || shareholders.length > 10) throw new Error("1 to 10 shareholders required");
  if (shareholders.some((s) => !Number.isInteger(s.shareBps) || s.shareBps <= 0)) throw new Error("every share must be > 0 bps");
  if (shareholders.reduce((s, x) => s + x.shareBps, 0) !== 10_000) throw new Error("shares must total 10_000 bps");
  if (new Set(shareholders.map((s) => s.address.toBase58())).size !== shareholders.length) throw new Error("duplicate shareholder");
  const sc = sharingConfigPda(p.mint);
  const pumpCreatorVault = creatorVaultPda(sc);
  const ammAuthority = ammCreatorVaultAuthority(sc);
  const w = new BorshWriter().raw(PUMP_FEES_IX.updateFeeSharesV2).u32(shareholders.length);
  for (const s of shareholders) w.pubkey(s.address).u16(s.shareBps);
  return new TransactionInstruction({
    programId: PUMP_FEES_PROGRAM_ID,
    keys: [
      ro(pumpFeesEventAuthorityPda()),
      ro(PUMP_FEES_PROGRAM_ID),
      signer(p.authority),
      ro(pumpGlobalPda()),
      ro(p.mint),
      rw(sc),
      ro(bondingCurvePda(p.mint)),
      rw(pumpCreatorVault),
      rw(wsolAta(pumpCreatorVault)),
      ro(SYSTEM_PROGRAM_ID),
      ro(PUMP_PROGRAM_ID),
      ro(pumpEventAuthorityPda()),
      ro(PUMP_AMM_PROGRAM_ID),
      ro(ammEventAuthorityPda()),
      ro(WSOL_MINT),
      ro(TOKEN_PROGRAM_ID),
      ro(ASSOCIATED_TOKEN_PROGRAM_ID),
      rw(ammAuthority),
      rw(wsolAta(ammAuthority)),
      ...p.currentShareholders.map(rw),
    ],
    data: w.build(),
  });
}

// ---------------------------------------------------------------------------------------------
// Bonding-curve trades
// ---------------------------------------------------------------------------------------------

/**
 * pump `buy_exact_quote_in_v2` (27 accounts): spend `solIn` lamports (fees included) for at least
 * `minTokensOut`. `creator` is the curve's on-chain creator (`sharing_config` on fee-sharing coins).
 */
export function pumpBuyExactQuoteInV2Ix(p: {
  user: PublicKey;
  mint: PublicKey;
  creator: PublicKey;
  solIn: bigint;
  minTokensOut: bigint;
  tokenProgram?: PublicKey;
  feeRecipient?: PublicKey;
  buybackFeeRecipient?: PublicKey;
}): TransactionInstruction {
  const tokenProgram = p.tokenProgram ?? TOKEN_2022_PROGRAM_ID;
  const feeRecipient = p.feeRecipient ?? pickRandom(PUMP_FEE_RECIPIENTS);
  const buyback = p.buybackFeeRecipient ?? pickRandom(PUMP_BUYBACK_FEE_RECIPIENTS);
  const curve = bondingCurvePda(p.mint);
  const creatorVault = creatorVaultPda(p.creator);
  const uva = pumpUserVolumeAccumulatorPda(p.user);
  return new TransactionInstruction({
    programId: PUMP_PROGRAM_ID,
    keys: [
      ro(pumpGlobalPda()),
      ro(p.mint),
      ro(WSOL_MINT),
      ro(tokenProgram),
      ro(TOKEN_PROGRAM_ID),
      ro(ASSOCIATED_TOKEN_PROGRAM_ID),
      rw(feeRecipient),
      rw(wsolAta(feeRecipient)),
      rw(buyback),
      rw(wsolAta(buyback)),
      rw(curve),
      rw(ata(curve, p.mint, tokenProgram)),
      rw(wsolAta(curve)),
      signer(p.user),
      rw(ata(p.user, p.mint, tokenProgram)),
      rw(wsolAta(p.user)),
      rw(creatorVault),
      rw(wsolAta(creatorVault)),
      ro(sharingConfigPda(p.mint)),
      ro(pumpGlobalVolumeAccumulatorPda()),
      rw(uva),
      rw(wsolAta(uva)),
      ro(feeConfigPda(PUMP_PROGRAM_ID)),
      ro(PUMP_FEES_PROGRAM_ID),
      ro(SYSTEM_PROGRAM_ID),
      ro(pumpEventAuthorityPda()),
      ro(PUMP_PROGRAM_ID),
    ],
    data: new BorshWriter().raw(PUMP_IX.buyExactQuoteInV2).u64(p.solIn).u64(p.minTokensOut).bool(true).build(),
  });
}

/**
 * The 17 accounts shared by pump `buy_v3` / `sell_v3` / `buy_exact_quote_in_v3` on a SOL curve.
 * `user` (index 8) is marked as a signer only when `userSigns` (a wallet); a copier vault PDA is
 * passed writable non-signer and the program signs for it.
 */
export function curveVenueAccounts(p: {
  user: PublicKey;
  mint: PublicKey;
  tokenProgram?: PublicKey;
  /** A `Global.buyback_fee_recipients` wallet (the wallet itself on SOL curves). */
  buybackFeeRecipient?: PublicKey;
  userSigns?: boolean;
}): AccountMeta[] {
  const tokenProgram = p.tokenProgram ?? TOKEN_2022_PROGRAM_ID;
  const curve = bondingCurvePda(p.mint);
  return [
    ro(pumpGlobalPda()),
    ro(p.mint),
    ro(WSOL_MINT),
    ro(tokenProgram),
    ro(TOKEN_PROGRAM_ID),
    rw(curve),
    rw(ata(curve, p.mint, tokenProgram)),
    rw(wsolAta(curve)),
    { pubkey: p.user, isSigner: p.userSigns ?? false, isWritable: true },
    rw(ata(p.user, p.mint, tokenProgram)),
    rw(wsolAta(p.user)),
    rw(pumpUserVolumeAccumulatorPda(p.user)),
    ro(feeConfigPda(PUMP_PROGRAM_ID)),
    rw(p.buybackFeeRecipient ?? pickRandom(PUMP_BUYBACK_FEE_RECIPIENTS)),
    ro(SYSTEM_PROGRAM_ID),
    ro(pumpEventAuthorityPda()),
    ro(PUMP_PROGRAM_ID),
  ];
}

/** Indices inside `curveVenueAccounts` (the program's TradeDescriptor for curve v3). */
export const CURVE_V3_INDEX = { user: 8, baseMint: 1, venue: 5, count: 17 } as const;

/** `buy_exact_quote_in_v3(spendable_quote_in, min_tokens_out, partial_fill = true)` data. */
export function curveBuyData(solIn: bigint, minTokensOut: bigint): Buffer {
  return new BorshWriter().raw(PUMP_IX.buyExactQuoteInV3).u64(solIn).u64(minTokensOut).bool(true).build();
}

/** `sell_v3(amount, min_sol_output)` data. */
export function curveSellData(tokensIn: bigint, minSolOut: bigint): Buffer {
  return new BorshWriter().raw(PUMP_IX.sellV3).u64(tokensIn).u64(minSolOut).build();
}

/** A wallet's pump curve buy: idempotent base ATA create + `buy_exact_quote_in_v3`. */
export function pumpBuyIxs(p: {
  user: PublicKey;
  mint: PublicKey;
  solIn: bigint;
  minTokensOut: bigint;
  tokenProgram?: PublicKey;
  buybackFeeRecipient?: PublicKey;
}): TransactionInstruction[] {
  const tokenProgram = p.tokenProgram ?? TOKEN_2022_PROGRAM_ID;
  return [
    createAssociatedTokenAccountIdempotentInstruction(p.user, ata(p.user, p.mint, tokenProgram), p.user, p.mint, tokenProgram),
    new TransactionInstruction({
      programId: PUMP_PROGRAM_ID,
      keys: curveVenueAccounts({ ...p, tokenProgram, userSigns: true }),
      data: curveBuyData(p.solIn, p.minTokensOut),
    }),
  ];
}

/** A wallet's pump curve sell (`sell_v3`). */
export function pumpSellIx(p: {
  user: PublicKey;
  mint: PublicKey;
  tokensIn: bigint;
  minSolOut: bigint;
  tokenProgram?: PublicKey;
  buybackFeeRecipient?: PublicKey;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: PUMP_PROGRAM_ID,
    keys: curveVenueAccounts({ ...p, userSigns: true }),
    data: curveSellData(p.tokensIn, p.minSolOut),
  });
}

// ---------------------------------------------------------------------------------------------
// PumpSwap trades
// ---------------------------------------------------------------------------------------------

/** The pool accounts a PumpSwap trade needs (from a decoded `Pool`, or derived for canonical pools). */
export interface PoolKeys {
  pool: PublicKey;
  baseMint: PublicKey;
  poolBaseTokenAccount: PublicKey;
  poolQuoteTokenAccount: PublicKey;
}

/** Keys of `mint`'s canonical (migrated) pool, derived without RPC. */
export function canonicalPoolKeys(mint: PublicKey, tokenProgram = TOKEN_2022_PROGRAM_ID): PoolKeys {
  const pool = canonicalPoolPda(mint);
  return { pool, baseMint: mint, poolBaseTokenAccount: ata(pool, mint, tokenProgram), poolQuoteTokenAccount: wsolAta(pool) };
}

/**
 * The 17 accounts shared by pump_amm `buy_v2` / `sell_v2` / `buy_exact_quote_in_v2` on a wSOL pool.
 * `user` (index 1) is a signer only when `userSigns`.
 */
export function poolVenueAccounts(p: {
  user: PublicKey;
  pool: PoolKeys;
  tokenProgram?: PublicKey;
  /** A `GlobalConfig.buyback_fee_recipients` wallet; its wSOL ATA is passed. */
  buybackFeeRecipient?: PublicKey;
  userSigns?: boolean;
}): AccountMeta[] {
  const tokenProgram = p.tokenProgram ?? TOKEN_2022_PROGRAM_ID;
  const { pool, baseMint, poolBaseTokenAccount, poolQuoteTokenAccount } = p.pool;
  return [
    rw(pool),
    { pubkey: p.user, isSigner: p.userSigns ?? false, isWritable: true },
    ro(ammGlobalConfigPda()),
    ro(baseMint),
    ro(WSOL_MINT),
    rw(ata(p.user, baseMint, tokenProgram)),
    rw(wsolAta(p.user)),
    rw(poolBaseTokenAccount),
    rw(poolQuoteTokenAccount),
    ro(tokenProgram),
    ro(TOKEN_PROGRAM_ID),
    ro(SYSTEM_PROGRAM_ID),
    rw(ammUserVolumeAccumulatorPda(p.user)),
    ro(feeConfigPda(PUMP_AMM_PROGRAM_ID)),
    rw(wsolAta(p.buybackFeeRecipient ?? pickRandom(PUMP_BUYBACK_FEE_RECIPIENTS))),
    ro(ammEventAuthorityPda()),
    ro(PUMP_AMM_PROGRAM_ID),
  ];
}

/** Indices inside `poolVenueAccounts` (the program's TradeDescriptor for AMM v2). */
export const POOL_V2_INDEX = { user: 1, baseMint: 3, venue: 0, count: 17 } as const;

/** pump_amm `buy_exact_quote_in_v2(spendable_quote_in, min_base_amount_out)` data. */
export function poolBuyData(solIn: bigint, minTokensOut: bigint): Buffer {
  return new BorshWriter().raw(PUMP_AMM_IX.buyExactQuoteInV2).u64(solIn).u64(minTokensOut).build();
}

/** pump_amm `sell_v2(base_amount_in, min_quote_amount_out)` data. */
export function poolSellData(tokensIn: bigint, minSolOut: bigint): Buffer {
  return new BorshWriter().raw(PUMP_AMM_IX.sellV2).u64(tokensIn).u64(minSolOut).build();
}

/**
 * A wallet's PumpSwap buy: wrap `solIn` into its wSOL ATA, idempotent base ATA create,
 * `buy_exact_quote_in_v2`, then close the wSOL ATA (unwrap the remainder).
 */
export function ammBuyIxs(p: {
  user: PublicKey;
  mint: PublicKey;
  solIn: bigint;
  minTokensOut: bigint;
  pool?: PoolKeys;
  tokenProgram?: PublicKey;
  buybackFeeRecipient?: PublicKey;
}): TransactionInstruction[] {
  const tokenProgram = p.tokenProgram ?? TOKEN_2022_PROGRAM_ID;
  const pool = p.pool ?? canonicalPoolKeys(p.mint, tokenProgram);
  const wsol = wsolAta(p.user);
  return [
    createAssociatedTokenAccountIdempotentInstruction(p.user, wsol, p.user, WSOL_MINT, TOKEN_PROGRAM_ID),
    SystemProgram.transfer({ fromPubkey: p.user, toPubkey: wsol, lamports: p.solIn }),
    createSyncNativeInstruction(wsol, TOKEN_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(p.user, ata(p.user, p.mint, tokenProgram), p.user, p.mint, tokenProgram),
    new TransactionInstruction({
      programId: PUMP_AMM_PROGRAM_ID,
      keys: poolVenueAccounts({ user: p.user, pool, tokenProgram, buybackFeeRecipient: p.buybackFeeRecipient, userSigns: true }),
      data: poolBuyData(p.solIn, p.minTokensOut),
    }),
    createCloseAccountInstruction(wsol, p.user, p.user, [], TOKEN_PROGRAM_ID),
  ];
}

/** A wallet's PumpSwap sell: wSOL ATA create, `sell_v2`, close the wSOL ATA (proceeds as lamports). */
export function ammSellIxs(p: {
  user: PublicKey;
  mint: PublicKey;
  tokensIn: bigint;
  minSolOut: bigint;
  pool?: PoolKeys;
  tokenProgram?: PublicKey;
  buybackFeeRecipient?: PublicKey;
}): TransactionInstruction[] {
  const tokenProgram = p.tokenProgram ?? TOKEN_2022_PROGRAM_ID;
  const pool = p.pool ?? canonicalPoolKeys(p.mint, tokenProgram);
  const wsol = wsolAta(p.user);
  return [
    createAssociatedTokenAccountIdempotentInstruction(p.user, wsol, p.user, WSOL_MINT, TOKEN_PROGRAM_ID),
    new TransactionInstruction({
      programId: PUMP_AMM_PROGRAM_ID,
      keys: poolVenueAccounts({ user: p.user, pool, tokenProgram, buybackFeeRecipient: p.buybackFeeRecipient, userSigns: true }),
      data: poolSellData(p.tokensIn, p.minSolOut),
    }),
    createCloseAccountInstruction(wsol, p.user, p.user, [], TOKEN_PROGRAM_ID),
  ];
}

// ---------------------------------------------------------------------------------------------
// Graduation
// ---------------------------------------------------------------------------------------------

/**
 * pump `migrate_v2`: moves a complete curve's liquidity into its canonical PumpSwap pool. `user` pays;
 * `withdrawAuthority` is `Global.withdraw_authority` (see `decodePumpGlobal`).
 */
export function pumpMigrateIx(p: {
  user: PublicKey;
  mint: PublicKey;
  withdrawAuthority: PublicKey;
  tokenProgram?: PublicKey;
}): TransactionInstruction {
  const tokenProgram = p.tokenProgram ?? TOKEN_2022_PROGRAM_ID;
  const curve = bondingCurvePda(p.mint);
  const pool = canonicalPoolPda(p.mint);
  const poolAuthority = poolAuthorityPda(p.mint);
  const lpMint = ammLpMintPda(pool);
  const boostVaultAuthority = PublicKey.findProgramAddressSync([Buffer.from("boost_vault"), pool.toBuffer()], PUMP_AMM_PROGRAM_ID)[0];
  return new TransactionInstruction({
    programId: PUMP_PROGRAM_ID,
    keys: [
      ro(pumpGlobalPda()),
      rw(p.withdrawAuthority),
      ro(p.mint),
      ro(WSOL_MINT),
      rw(curve),
      rw(ata(curve, p.mint, tokenProgram)),
      rw(wsolAta(curve)),
      signer(p.user),
      ro(SYSTEM_PROGRAM_ID),
      ro(PUMP_AMM_PROGRAM_ID),
      rw(pool),
      rw(poolAuthority),
      rw(ata(poolAuthority, p.mint, tokenProgram)),
      rw(wsolAta(poolAuthority)),
      ro(ammGlobalConfigPda()),
      rw(lpMint),
      rw(ata(poolAuthority, lpMint, TOKEN_2022_PROGRAM_ID)),
      rw(ata(pool, p.mint, tokenProgram)),
      rw(wsolAta(pool)),
      ro(tokenProgram),
      ro(TOKEN_PROGRAM_ID),
      ro(TOKEN_2022_PROGRAM_ID),
      ro(ASSOCIATED_TOKEN_PROGRAM_ID),
      ro(ammEventAuthorityPda()),
      ro(RENT_SYSVAR_ID),
      ro(pumpEventAuthorityPda()),
      ro(PUMP_PROGRAM_ID),
      // remaining (mandatory): the new pool's boost vault authority and its wSOL vault
      ro(boostVaultAuthority),
      rw(wsolAta(boostVaultAuthority)),
    ],
    data: Buffer.from(PUMP_IX.migrateV2),
  });
}

// ---------------------------------------------------------------------------------------------
// Creator fees: sweep, AMM → pump transfer, distribute
// ---------------------------------------------------------------------------------------------

/** pump `sweep_creator_fee`: pays the curve's v3 `creator_fee` bucket into `creator_vault(creator)`. No-op when empty. */
export function sweepCreatorFeeIx(p: { payer: PublicKey; mint: PublicKey; creator: PublicKey }): TransactionInstruction {
  const curve = bondingCurvePda(p.mint);
  const recipient = creatorVaultPda(p.creator);
  return new TransactionInstruction({
    programId: PUMP_PROGRAM_ID,
    keys: [
      signer(p.payer),
      ro(pumpGlobalPda()),
      ro(p.mint),
      ro(WSOL_MINT),
      ro(TOKEN_PROGRAM_ID),
      ro(ASSOCIATED_TOKEN_PROGRAM_ID),
      ro(SYSTEM_PROGRAM_ID),
      rw(curve),
      rw(wsolAta(curve)),
      rw(recipient),
      rw(wsolAta(recipient)),
      ro(pumpEventAuthorityPda()),
      ro(PUMP_PROGRAM_ID),
    ],
    data: Buffer.from(PUMP_IX.sweepCreatorFee),
  });
}

/** pump_amm `sweep_creator_fee`: pays `Pool.creator_fees` into the coin-creator vault authority's wSOL ATA. */
export function sweepPoolCreatorFeeIx(p: { payer: PublicKey; pool: PoolKeys; coinCreator: PublicKey }): TransactionInstruction {
  const recipient = ammCreatorVaultAuthority(p.coinCreator);
  return new TransactionInstruction({
    programId: PUMP_AMM_PROGRAM_ID,
    keys: [
      signer(p.payer),
      ro(ammGlobalConfigPda()),
      rw(p.pool.pool),
      ro(WSOL_MINT),
      ro(TOKEN_PROGRAM_ID),
      rw(p.pool.poolQuoteTokenAccount),
      ro(recipient),
      rw(wsolAta(recipient)),
      ro(SYSTEM_PROGRAM_ID),
      ro(ASSOCIATED_TOKEN_PROGRAM_ID),
      ro(ammEventAuthorityPda()),
      ro(PUMP_AMM_PROGRAM_ID),
    ],
    data: Buffer.from(PUMP_AMM_IX.sweepCreatorFee),
  });
}

/** pump_amm `transfer_creator_fees_to_pump_v2`: unwraps the AMM coin-creator vault into pump's `creator_vault(coinCreator)`. */
export function transferCreatorFeesToPumpV2Ix(p: { payer: PublicKey; coinCreator: PublicKey }): TransactionInstruction {
  const authority = ammCreatorVaultAuthority(p.coinCreator);
  const pumpVault = creatorVaultPda(p.coinCreator);
  return new TransactionInstruction({
    programId: PUMP_AMM_PROGRAM_ID,
    keys: [
      signer(p.payer),
      ro(WSOL_MINT),
      ro(TOKEN_PROGRAM_ID),
      ro(SYSTEM_PROGRAM_ID),
      ro(ASSOCIATED_TOKEN_PROGRAM_ID),
      ro(p.coinCreator),
      rw(authority),
      rw(wsolAta(authority)),
      rw(pumpVault),
      rw(wsolAta(pumpVault)),
      ro(ammEventAuthorityPda()),
      ro(PUMP_AMM_PROGRAM_ID),
    ],
    data: Buffer.from(PUMP_AMM_IX.transferCreatorFeesToPumpV2),
  });
}

/**
 * pump `distribute_creator_fees_v2` of a SOL coin: pays `creator_vault(sharing_config)` out to
 * `shareholders` (sharing-config order) by System transfers. Below the minimum it is a silent no-op.
 */
export function distributeCreatorFeesV2Ix(p: { payer: PublicKey; mint: PublicKey; shareholders: PublicKey[] }): TransactionInstruction {
  const sc = sharingConfigPda(p.mint);
  const creatorVault = creatorVaultPda(sc);
  return new TransactionInstruction({
    programId: PUMP_PROGRAM_ID,
    keys: [
      signer(p.payer),
      ro(p.mint),
      ro(bondingCurvePda(p.mint)),
      ro(sc),
      rw(creatorVault),
      ro(SYSTEM_PROGRAM_ID),
      ro(pumpEventAuthorityPda()),
      ro(PUMP_PROGRAM_ID),
      rw(wsolAta(creatorVault)),
      ro(WSOL_MINT),
      ro(TOKEN_PROGRAM_ID),
      ro(ASSOCIATED_TOKEN_PROGRAM_ID),
      ...p.shareholders.map(rw),
    ],
    data: new BorshWriter().raw(PUMP_IX.distributeCreatorFeesV2).bool(false).build(),
  });
}
