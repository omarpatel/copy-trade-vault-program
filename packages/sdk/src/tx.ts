/**
 * v0 transaction assembly and the Copier platform address lookup table: every program-global account
 * copy-vault transactions touch, so the launch tx (create_v2 + fee sharing + register_copier) fits.
 */
import {
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  ComputeBudgetProgram,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  type Commitment,
  type Connection,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  COMPUTE_BUDGET_PROGRAM_ID,
  MAYHEM_PROGRAM_ID,
  MEMO_PROGRAM_ID,
  COPIER_PROGRAM_ID,
  PUMP_AMM_PROGRAM_ID,
  PUMP_BUYBACK_FEE_RECIPIENTS,
  PUMP_FEE_RECIPIENTS,
  PUMP_FEES_PROGRAM_ID,
  PUMP_PROGRAM_ID,
  RENT_SYSVAR_ID,
  SYSTEM_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  WSOL_MINT,
} from "./constants";
import {
  ammEventAuthorityPda,
  ammGlobalConfigPda,
  ammGlobalVolumeAccumulatorPda,
  burnPoolPda,
  configPda,
  feeConfigPda,
  mayhemGlobalParamsPda,
  mayhemSolVaultPda,
  pumpEventAuthorityPda,
  pumpGlobalPda,
  pumpGlobalVolumeAccumulatorPda,
  pumpMintAuthorityPda,
  wsolAta,
} from "./pda";
import { pumpFeesEventAuthorityPda } from "./pump";

/** Compute units to request for the launch tx (≈300–360k measured in litesvm with register_copier). */
export const LAUNCH_COMPUTE_UNITS = 400_000;
/** Compute units to request for the dev-buy tx (ATA create + buy_exact_quote_in_v2). */
export const DEV_BUY_COMPUTE_UNITS = 150_000;
/** Compute units for a copier_buy / copier_sell on curve v3 / AMM v2 before simulation sizing. */
export const COPIER_TRADE_COMPUTE_UNITS = 200_000;

/**
 * The static accounts of the Copier platform lookup table: programs, sysvars, Copier's config and
 * burn pool, pump's globals / fee configs / event authorities, mayhem's create accounts, and every
 * fee / buyback recipient with its wSOL ATA. No per-mint account.
 */
export function platformLookupTableAddresses(programId = COPIER_PROGRAM_ID): PublicKey[] {
  const recipients = [...PUMP_FEE_RECIPIENTS, ...PUMP_BUYBACK_FEE_RECIPIENTS];
  const keys = [
    programId,
    configPda(programId),
    burnPoolPda(programId),
    PUMP_PROGRAM_ID,
    PUMP_AMM_PROGRAM_ID,
    PUMP_FEES_PROGRAM_ID,
    MAYHEM_PROGRAM_ID,
    SYSTEM_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    COMPUTE_BUDGET_PROGRAM_ID,
    MEMO_PROGRAM_ID,
    RENT_SYSVAR_ID,
    WSOL_MINT,
    pumpGlobalPda(),
    pumpMintAuthorityPda(),
    pumpEventAuthorityPda(),
    pumpGlobalVolumeAccumulatorPda(),
    feeConfigPda(PUMP_PROGRAM_ID),
    ammGlobalConfigPda(),
    ammEventAuthorityPda(),
    ammGlobalVolumeAccumulatorPda(),
    feeConfigPda(PUMP_AMM_PROGRAM_ID),
    pumpFeesEventAuthorityPda(),
    mayhemGlobalParamsPda(),
    mayhemSolVaultPda(),
    ...recipients,
    ...recipients.map(wsolAta),
  ];
  const seen = new Set<string>();
  return keys.filter((k) => !seen.has(k.toBase58()) && seen.add(k.toBase58()));
}

/** Addresses per `extend_lookup_table` instruction (keeps each extend tx well under the size limit). */
const EXTEND_CHUNK = 20;

/**
 * Instructions creating a lookup table owned by `authority` holding `addresses`: one tx with the
 * create (+ first extend), then one tx per further extend. Send them in order; the table is usable a
 * slot after the last extend lands. `recentSlot` = a recent finalized slot (`getSlot("finalized")`).
 */
export function createLookupTableTxs(p: {
  authority: PublicKey;
  payer: PublicKey;
  recentSlot: number;
  addresses: PublicKey[];
}): { lookupTable: PublicKey; transactions: TransactionInstruction[][] } {
  const [create, lookupTable] = AddressLookupTableProgram.createLookupTable({
    authority: p.authority,
    payer: p.payer,
    recentSlot: p.recentSlot,
  });
  const transactions: TransactionInstruction[][] = [[create]];
  for (let i = 0; i < p.addresses.length; i += EXTEND_CHUNK) {
    const extend = AddressLookupTableProgram.extendLookupTable({
      lookupTable,
      authority: p.authority,
      payer: p.payer,
      addresses: p.addresses.slice(i, i + EXTEND_CHUNK),
    });
    if (i === 0) transactions[0]!.push(extend);
    else transactions.push([extend]);
  }
  return { lookupTable, transactions };
}

/** Fetches lookup tables by address; throws on a missing one (a tx compiled without it would be oversized). */
export async function fetchLookupTables(
  connection: Connection,
  addresses: PublicKey[],
  commitment: Commitment = "confirmed",
): Promise<AddressLookupTableAccount[]> {
  const infos = await connection.getMultipleAccountsInfo(addresses, commitment);
  return infos.map((info, i) => {
    if (!info) throw new Error(`lookup table ${addresses[i]!.toBase58()} not found`);
    return new AddressLookupTableAccount({ key: addresses[i]!, state: AddressLookupTableAccount.deserialize(info.data) });
  });
}

/**
 * An unsigned v0 transaction: optional compute-budget instructions first, then `instructions`,
 * compiled against `lookupTables`. Sign with every required signer (payer, mint keypair, …).
 */
export function buildV0Tx(p: {
  payer: PublicKey;
  instructions: TransactionInstruction[];
  recentBlockhash: string;
  lookupTables?: AddressLookupTableAccount[];
  computeUnitLimit?: number;
  computeUnitPriceMicroLamports?: number;
}): VersionedTransaction {
  const budget: TransactionInstruction[] = [];
  if (p.computeUnitLimit !== undefined) budget.push(ComputeBudgetProgram.setComputeUnitLimit({ units: p.computeUnitLimit }));
  if (p.computeUnitPriceMicroLamports) {
    budget.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: p.computeUnitPriceMicroLamports }));
  }
  const message = new TransactionMessage({
    payerKey: p.payer,
    recentBlockhash: p.recentBlockhash,
    instructions: [...budget, ...p.instructions],
  }).compileToV0Message(p.lookupTables ?? []);
  return new VersionedTransaction(message);
}
