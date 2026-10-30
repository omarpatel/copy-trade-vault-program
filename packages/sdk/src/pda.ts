import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  MAYHEM_PROGRAM_ID,
  COPIER_PROGRAM_ID,
  PUMP_AMM_PROGRAM_ID,
  PUMP_FEES_PROGRAM_ID,
  PUMP_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  WSOL_MINT,
} from "./constants";
import { SEEDS } from "./params";

const enc = (s: string) => Buffer.from(s, "utf8");
const pda = (seeds: Uint8Array[], program: PublicKey) => PublicKey.findProgramAddressSync(seeds, program)[0];

// ---- Copier ----

export function configPda(programId = COPIER_PROGRAM_ID): PublicKey {
  return pda([enc(SEEDS.config)], programId);
}

export function copierPda(mint: PublicKey, programId = COPIER_PROGRAM_ID): PublicKey {
  return pda([enc(SEEDS.copier), mint.toBuffer()], programId);
}

/** System-owned zero-data PDA holding the copier's SOL; the pump `user` of every copier trade and a fee shareholder. */
export function vaultPda(mint: PublicKey, programId = COPIER_PROGRAM_ID): PublicKey {
  return pda([enc(SEEDS.vault), mint.toBuffer()], programId);
}

export function positionPda(mint: PublicKey, tokenMint: PublicKey, programId = COPIER_PROGRAM_ID): PublicKey {
  return pda([enc(SEEDS.position), mint.toBuffer(), tokenMint.toBuffer()], programId);
}

/** System-owned zero-data PDA that receives the 25% the platform token share and buys + burns the platform token. */
export function burnPoolPda(programId = COPIER_PROGRAM_ID): PublicKey {
  return pda([enc(SEEDS.burnPool)], programId);
}

/** A timelocked admin change: `["pending", id as u64 LE]` (`id` = `config.nextChangeId` when proposed). */
export function pendingChangePda(id: bigint | number, programId = COPIER_PROGRAM_ID): PublicKey {
  const le = Buffer.alloc(8);
  le.writeBigUInt64LE(BigInt(id));
  return pda([enc(SEEDS.pending), le], programId);
}

/** Associated token account of `owner` (off-curve owners allowed: vaults, PDAs). */
export function ata(owner: PublicKey, mint: PublicKey, tokenProgram = TOKEN_2022_PROGRAM_ID): PublicKey {
  return getAssociatedTokenAddressSync(mint, owner, true, tokenProgram);
}

/** wSOL (SPL Token) associated token account of `owner`. */
export function wsolAta(owner: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(WSOL_MINT, owner, true, TOKEN_PROGRAM_ID);
}

// ---- pump (bonding curve) ----

export const pumpGlobalPda = () => pda([enc("global")], PUMP_PROGRAM_ID);
export const pumpEventAuthorityPda = () => pda([enc("__event_authority")], PUMP_PROGRAM_ID);
export const pumpMintAuthorityPda = () => pda([enc("mint-authority")], PUMP_PROGRAM_ID);
export const pumpGlobalVolumeAccumulatorPda = () => pda([enc("global_volume_accumulator")], PUMP_PROGRAM_ID);
export const pumpUserVolumeAccumulatorPda = (user: PublicKey) =>
  pda([enc("user_volume_accumulator"), user.toBuffer()], PUMP_PROGRAM_ID);
/** pump_fees `FeeConfig` of `program` (pump or pump_amm). */
export const feeConfigPda = (program: PublicKey) => pda([enc("fee_config"), program.toBuffer()], PUMP_FEES_PROGRAM_ID);

export function bondingCurvePda(mint: PublicKey): PublicKey {
  return pda([enc("bonding-curve"), mint.toBuffer()], PUMP_PROGRAM_ID);
}

/** pump_fees `SharingConfig` of a coin; `BondingCurve.creator` once fee sharing is set up. */
export function sharingConfigPda(mint: PublicKey): PublicKey {
  return pda([enc("sharing-config"), mint.toBuffer()], PUMP_FEES_PROGRAM_ID);
}

/** pump creator vault (lamports) of a curve creator: `["creator-vault", creator]`. */
export function creatorVaultPda(creator: PublicKey): PublicKey {
  return pda([enc("creator-vault"), creator.toBuffer()], PUMP_PROGRAM_ID);
}

export const poolAuthorityPda = (mint: PublicKey) => pda([enc("pool-authority"), mint.toBuffer()], PUMP_PROGRAM_ID);

// ---- pump mayhem (create_v2 accounts) ----

export const mayhemGlobalParamsPda = () => pda([enc("global-params")], MAYHEM_PROGRAM_ID);
export const mayhemSolVaultPda = () => pda([enc("sol-vault")], MAYHEM_PROGRAM_ID);
export const mayhemStatePda = (mint: PublicKey) => pda([enc("mayhem-state"), mint.toBuffer()], MAYHEM_PROGRAM_ID);
export const mayhemTokenVault = (mint: PublicKey) => ata(mayhemSolVaultPda(), mint, TOKEN_2022_PROGRAM_ID);

// ---- pump_amm ----

export const ammGlobalConfigPda = () => pda([enc("global_config")], PUMP_AMM_PROGRAM_ID);
export const ammEventAuthorityPda = () => pda([enc("__event_authority")], PUMP_AMM_PROGRAM_ID);
export const ammGlobalVolumeAccumulatorPda = () => pda([enc("global_volume_accumulator")], PUMP_AMM_PROGRAM_ID);
export const ammUserVolumeAccumulatorPda = (user: PublicKey) =>
  pda([enc("user_volume_accumulator"), user.toBuffer()], PUMP_AMM_PROGRAM_ID);
export const ammLpMintPda = (pool: PublicKey) => pda([enc("pool_lp_mint"), pool.toBuffer()], PUMP_AMM_PROGRAM_ID);

/** The canonical pool pump migrates a graduated curve into: index 0, quoted in wSOL. */
export function canonicalPoolPda(mint: PublicKey, quoteMint = WSOL_MINT): PublicKey {
  const index = Buffer.alloc(2);
  return pda([enc("pool"), index, poolAuthorityPda(mint).toBuffer(), mint.toBuffer(), quoteMint.toBuffer()], PUMP_AMM_PROGRAM_ID);
}

/** PumpSwap coin-creator vault authority: `["creator_vault", coin_creator]` (underscore, unlike pump). */
export function ammCreatorVaultAuthority(coinCreator: PublicKey): PublicKey {
  return pda([enc("creator_vault"), coinCreator.toBuffer()], PUMP_AMM_PROGRAM_ID);
}
