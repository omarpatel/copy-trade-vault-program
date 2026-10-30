import { PublicKey } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";

export { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID };

// ---------------------------------------------------------------------------------------------
// Programs
// ---------------------------------------------------------------------------------------------

export const COPIER_PROGRAM_ID = new PublicKey("9R8g8JtEqRAh5yZ4aXbf1mWcfgLq9kAo6fmx93MSK9k7");
export const PUMP_PROGRAM_ID = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
export const PUMP_AMM_PROGRAM_ID = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
export const PUMP_FEES_PROGRAM_ID = new PublicKey("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ");
export const MAYHEM_PROGRAM_ID = new PublicKey("MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e");
export const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
export const COMPUTE_BUDGET_PROGRAM_ID = new PublicKey("ComputeBudget111111111111111111111111111111");
export const SYSTEM_PROGRAM_ID = new PublicKey("11111111111111111111111111111111");
export const RENT_SYSVAR_ID = new PublicKey("SysvarRent111111111111111111111111111111111");
/** Instructions sysvar: the last named account of every copy-vault trade / burn (transaction-shape guard). */
export const INSTRUCTIONS_SYSVAR_ID = new PublicKey("Sysvar1nstructions1111111111111111111111111");
/** wSOL; also the `quote_mint` pump expects for SOL-quoted curves and pools. */
export const WSOL_MINT = NATIVE_MINT;
export const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
/** Token-2022's native mint (counts as a SOL-like quote for pump's fee schedule). */
export const TOKEN_2022_NATIVE_MINT = new PublicKey("9pan9bMn5HatX4EJdBwg9VgCa7Uz5HL8N1m5D3NdXejP");

/** Pump's frozen public lookup table (43 addresses, authority none). */
export const PUMP_FROZEN_ALT = new PublicKey("7mFD2mUtRS65XstiSAvCJuYmdesZoQwCwRJhq1p3eRMe");

// ---------------------------------------------------------------------------------------------
// pump / pump_amm / pump_fees static accounts (docs/research/pump-integration.md §1)
// ---------------------------------------------------------------------------------------------

export const PUMP_GLOBAL = new PublicKey("4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf");
export const PUMP_FEE_CONFIG = new PublicKey("8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt");
export const PUMP_AMM_GLOBAL_CONFIG = new PublicKey("ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw");
export const PUMP_AMM_FEE_CONFIG = new PublicKey("5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx");
export const PUMP_GLOBAL_VOLUME_ACCUMULATOR = new PublicKey("Hq2wp8uJ9jCPsYgNHex8RtqdvMPfVGoYwjvF1ATiwn2Y");

/**
 * `Global.buyback_fee_recipients` / `GlobalConfig.buyback_fee_recipients` as of 2026-10-04. Live values
 * come from `fetchPumpStatic`; this list seeds the platform ALT and is the fallback for builders.
 */
export const PUMP_BUYBACK_FEE_RECIPIENTS = [
  "5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD",
  "9M4giFFMxmFGXtc3feFzRai56WbBqehoSeRE5GK7gf7",
  "GXPFM2caqTtQYC2cJ5yJRi9VDkpsYZXzYdwYpGnLmtDL",
  "3BpXnfJaUTiwXnJNe7Ej1rcbzqTTQUvLShZaWazebsVR",
  "5cjcW9wExnJJiqgLjq7DEG75Pm6JBgE1hNv4B2vHXUW6",
  "EHAAiTxcdDwQ3U4bU6YcMsQGaekdzLS3B5SmYo46kJtL",
  "5eHhjP8JaYkz83CWwvGU2uMUXefd3AazWGx4gpcuEEYD",
  "A7hAgCzFw14fejgCp387JUJRMNyz4j89JKnhtKU8piqW",
].map((k) => new PublicKey(k));

/** `Global.fee_recipient` + `Global.fee_recipients[7]`: legacy/v2 bonding-curve trades of non-mayhem coins. */
export const PUMP_FEE_RECIPIENTS = [
  "62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV",
  "7VtfL8fvgNfhz17qKRMjzQEXgbdpnHHHQRh54R9jP2RJ",
  "7hTckgnGnLQR6sdH7YkqFTAA7VwTfYFaZ6EhEsU3saCX",
  "9rPYyANsfQZw3DnDmKE3YCQF5E8oD89UXoHn9JFEhJUz",
  "AVmoTthdrX6tKt4nDjco2D775W2YK3sDhxPcMmzUAmTY",
  "CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM",
  "FWsW1xNtWscwNmKv6wVsU1iTzRN6wmmk3MjxRP5tT7hz",
  "G5UZAVbAf46s7cKWoyKu8kYTip9DGTpbLZ2qa9Aq69dP",
].map((k) => new PublicKey(k));

// ---------------------------------------------------------------------------------------------
// Discriminators (asserted against src/idl/pump*.json and docs/research in src/discriminators.test.ts)
// ---------------------------------------------------------------------------------------------

const hex = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));

export const PUMP_IX = {
  createV2: hex("d6904cec5f8b31b4"),
  buyV2: hex("b817ee6167c5d33d"),
  sellV2: hex("5df6823ce7e940b2"),
  buyExactQuoteInV2: hex("c2ab1c46684d5b2f"),
  buyV3: hex("07051dc4f5176550"),
  sellV3: hex("1c92de7726c469d5"),
  buyExactQuoteInV3: hex("e1f7501ed5b38488"),
  sweepCreatorFee: hex("20f6bf3408c949ba"),
  distributeCreatorFeesV2: hex("ffcb134ff444089f"),
  migrateV2: hex("bbcb121fceedfe29"),
} as const;

export const PUMP_AMM_IX = {
  buy: hex("66063d1201daebea"),
  sell: hex("33e685a4017f83ad"),
  buyExactQuoteIn: hex("c62e1552b4d9e870"),
  buyV2: hex("b817ee6167c5d33d"),
  sellV2: hex("5df6823ce7e940b2"),
  buyExactQuoteInV2: hex("c2ab1c46684d5b2f"),
  sweepCreatorFee: hex("20f6bf3408c949ba"),
  transferCreatorFeesToPumpV2: hex("01214eb921432c5c"),
} as const;

export const PUMP_FEES_IX = {
  createFeeSharingConfig: hex("c34e564c6f34fbd5"),
  updateFeeSharesV2: hex("6ffb31064e4e6a12"),
} as const;

export const PUMP_ACCOUNT_DISC = {
  bondingCurve: hex("17b7f83760d8ac60"),
  pool: hex("f19a6d0411b16dbc"),
  sharingConfig: hex("d84a0900388c5d4b"),
  feeConfig: hex("8f3492bbdb7b4c9b"),
  global: hex("a7e8e8b1c86c727f"),
  globalConfig: hex("95089ccaa0fcb0d9"),
} as const;

/** Anchor `emit_cpi!` instruction tag (self-CPI event data prefix). */
export const ANCHOR_EVENT_CPI_TAG = hex("e445a52e51cb9a1d");
