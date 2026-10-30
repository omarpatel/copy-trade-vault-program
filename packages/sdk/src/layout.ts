/**
 * Decoders for the pump / pump_amm / pump_fees accounts copy-vault reads (offsets in
 * docs/research/pump-integration.md §4 and fee-sharing.md §1), plus the borsh writer the pump
 * instruction builders use. DataView rather than `Buffer#readBigUInt64LE`, which browser Buffer
 * polyfills may lack.
 */
import { PublicKey } from "@solana/web3.js";
import { PUMP_ACCOUNT_DISC } from "./constants";

type Bytes = Buffer | Uint8Array;

const view = (b: Bytes) => new DataView(b.buffer, b.byteOffset, b.byteLength);
const u64 = (b: Bytes, at: number) => (at + 8 <= b.length ? view(b).getBigUint64(at, true) : 0n);
const bool = (b: Bytes, at: number) => at < b.length && b[at] !== 0;
const pubkey = (b: Bytes, at: number) =>
  at + 32 <= b.length ? new PublicKey(b.subarray(at, at + 32)) : PublicKey.default;

function u128(b: Bytes, at: number): bigint {
  if (at + 16 > b.length) return 0n;
  const v = view(b);
  return (v.getBigUint64(at + 8, true) << 64n) | v.getBigUint64(at, true);
}

function i128(b: Bytes, at: number): bigint {
  if (at + 16 > b.length) return 0n;
  const v = view(b);
  return (v.getBigInt64(at + 8, true) << 64n) + v.getBigUint64(at, true);
}

function checkDisc(data: Bytes, disc: Uint8Array, what: string): void {
  for (let i = 0; i < 8; i++) {
    if (data[i] !== disc[i]) throw new Error(`not a pump ${what} account`);
  }
}

// ---- BondingCurve ----

export interface BondingCurve {
  virtualTokenReserves: bigint;
  virtualQuoteReserves: bigint;
  realTokenReserves: bigint;
  realQuoteReserves: bigint;
  tokenTotalSupply: bigint;
  complete: boolean;
  /** `sharing_config` PDA once fee sharing is set up. */
  creator: PublicKey;
  isMayhemMode: boolean;
  isCashbackCoin: boolean;
  /** `PublicKey.default` for SOL coins. */
  quoteMint: PublicKey;
  creatorFeeBps: bigint;
  canEditCreatorFee: boolean;
  isHolderReward: boolean;
  /** v3 un-swept creator fee bucket (lamports). */
  creatorFee: bigint;
  /** v3 un-swept protocol fee bucket (lamports). */
  protocolFees: bigint;
}

/** Older (shorter) curve accounts read their missing trailing fields as 0 / false / default. */
export function decodeBondingCurve(data: Bytes): BondingCurve {
  checkDisc(data, PUMP_ACCOUNT_DISC.bondingCurve, "BondingCurve");
  return {
    virtualTokenReserves: u64(data, 8),
    virtualQuoteReserves: u64(data, 16),
    realTokenReserves: u64(data, 24),
    realQuoteReserves: u64(data, 32),
    tokenTotalSupply: u64(data, 40),
    complete: bool(data, 48),
    creator: pubkey(data, 49),
    isMayhemMode: bool(data, 81),
    isCashbackCoin: bool(data, 82),
    quoteMint: pubkey(data, 83),
    creatorFeeBps: u64(data, 115),
    canEditCreatorFee: bool(data, 123),
    isHolderReward: bool(data, 124),
    creatorFee: u64(data, 125),
    protocolFees: u64(data, 133),
  };
}

// ---- Pool ----

export interface Pool {
  poolBump: number;
  index: number;
  /** Canonical pools: pump's `["pool-authority", mint]`. */
  creator: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  lpMint: PublicKey;
  poolBaseTokenAccount: PublicKey;
  poolQuoteTokenAccount: PublicKey;
  lpSupply: bigint;
  coinCreator: PublicKey;
  isMayhemMode: boolean;
  isCashbackCoin: boolean;
  /** Signed; added to the quote vault balance to price trades. */
  virtualQuoteReserves: bigint;
  creatorFeeBps: bigint;
  canEditCreatorFee: boolean;
  isHolderReward: boolean;
  /** AMM v2 un-swept buckets, held inside the quote vault. */
  protocolFees: bigint;
  creatorFees: bigint;
}

export function decodePool(data: Bytes): Pool {
  checkDisc(data, PUMP_ACCOUNT_DISC.pool, "Pool");
  return {
    poolBump: data[8] ?? 0,
    index: data.length >= 11 ? view(data).getUint16(9, true) : 0,
    creator: pubkey(data, 11),
    baseMint: pubkey(data, 43),
    quoteMint: pubkey(data, 75),
    lpMint: pubkey(data, 107),
    poolBaseTokenAccount: pubkey(data, 139),
    poolQuoteTokenAccount: pubkey(data, 171),
    lpSupply: u64(data, 203),
    coinCreator: pubkey(data, 211),
    isMayhemMode: bool(data, 243),
    isCashbackCoin: bool(data, 244),
    virtualQuoteReserves: i128(data, 245),
    creatorFeeBps: u64(data, 261),
    canEditCreatorFee: bool(data, 269),
    isHolderReward: bool(data, 270),
    protocolFees: u64(data, 271),
    creatorFees: u64(data, 279),
  };
}

// ---- SharingConfig ----

export interface Shareholder {
  address: PublicKey;
  shareBps: number;
}

export interface SharingConfig {
  bump: number;
  version: number;
  status: "paused" | "active";
  mint: PublicKey;
  admin: PublicKey;
  adminRevoked: boolean;
  shareholders: Shareholder[];
}

export function decodeSharingConfig(data: Bytes): SharingConfig {
  checkDisc(data, PUMP_ACCOUNT_DISC.sharingConfig, "SharingConfig");
  const v = view(data);
  const n = v.getUint32(76, true);
  if (n > 10 || 80 + 34 * n > data.length) throw new Error(`corrupt SharingConfig: ${n} shareholders`);
  const shareholders: Shareholder[] = [];
  for (let i = 0; i < n; i++) {
    shareholders.push({ address: pubkey(data, 80 + 34 * i), shareBps: v.getUint16(112 + 34 * i, true) });
  }
  return {
    bump: data[8]!,
    version: data[9]!,
    status: data[10] === 1 ? "active" : "paused",
    mint: pubkey(data, 11),
    admin: pubkey(data, 43),
    adminRevoked: bool(data, 75),
    shareholders,
  };
}

// ---- FeeConfig (pump_fees) ----

export interface Fees {
  lpBps: number;
  protocolBps: number;
  creatorBps: number;
}

export interface FeeTier {
  /** Market cap (lamports of the quote) from which this tier applies. */
  thresholdLamports: bigint;
  fees: Fees;
}

export interface FeeConfig {
  admin: PublicKey;
  flatFees: Fees;
  feeTiers: FeeTier[];
  stableFeeTiers: FeeTier[];
  exoticFlatFees: Fees;
}

export function decodeFeeConfig(data: Bytes): FeeConfig {
  checkDisc(data, PUMP_ACCOUNT_DISC.feeConfig, "FeeConfig");
  const v = view(data);
  let at = 8 + 1; // disc, bump
  const admin = pubkey(data, at);
  at += 32;
  const fees = (): Fees => {
    const f = { lpBps: Number(u64(data, at)), protocolBps: Number(u64(data, at + 8)), creatorBps: Number(u64(data, at + 16)) };
    at += 24;
    return f;
  };
  const tiers = (): FeeTier[] => {
    const n = v.getUint32(at, true);
    at += 4;
    const out: FeeTier[] = [];
    for (let i = 0; i < n; i++) {
      const thresholdLamports = u128(data, at);
      at += 16;
      out.push({ thresholdLamports, fees: fees() });
    }
    return out;
  };
  const flatFees = fees();
  const feeTiers = tiers();
  const stableFeeTiers = tiers();
  const exoticFlatFees = at + 24 <= data.length ? fees() : { lpBps: 0, protocolBps: 0, creatorBps: 0 };
  return { admin, flatFees, feeTiers, stableFeeTiers, exoticFlatFees };
}

// ---- pump Global / pump_amm GlobalConfig (the fields copy-vault uses) ----

function pubkeyList(data: Bytes, at: number, count: number): PublicKey[] {
  const out: PublicKey[] = [];
  for (let i = 0; i < count; i++) {
    const key = pubkey(data, at + 32 * i);
    if (!key.equals(PublicKey.default)) out.push(key);
  }
  return out;
}

export interface PumpGlobal {
  initialVirtualTokenReserves: bigint;
  initialVirtualSolReserves: bigint;
  initialRealTokenReserves: bigint;
  tokenTotalSupply: bigint;
  withdrawAuthority: PublicKey;
  /** `fee_recipient` + `fee_recipients[7]` (v2/legacy curve trades of non-mayhem coins). */
  feeRecipients: PublicKey[];
  reservedFeeRecipients: PublicKey[];
  buybackFeeRecipients: PublicKey[];
  creatorFeeConfigurable: boolean;
}

export function decodePumpGlobal(data: Bytes): PumpGlobal {
  checkDisc(data, PUMP_ACCOUNT_DISC.global, "Global");
  return {
    initialVirtualTokenReserves: u64(data, 73),
    initialVirtualSolReserves: u64(data, 81),
    initialRealTokenReserves: u64(data, 89),
    tokenTotalSupply: u64(data, 97),
    withdrawAuthority: pubkey(data, 113),
    feeRecipients: [...pubkeyList(data, 41, 1), ...pubkeyList(data, 162, 7)],
    reservedFeeRecipients: [...pubkeyList(data, 483, 1), ...pubkeyList(data, 516, 7)],
    buybackFeeRecipients: pubkeyList(data, 741, 8),
    creatorFeeConfigurable: bool(data, 1045),
  };
}

export interface AmmGlobalConfig {
  /** bit 3 = buys disabled, bit 4 = sells disabled. */
  disableFlags: number;
  protocolFeeRecipients: PublicKey[];
  buybackFeeRecipients: PublicKey[];
  creatorFeeConfigurable: boolean;
}

export function decodeAmmGlobalConfig(data: Bytes): AmmGlobalConfig {
  checkDisc(data, PUMP_ACCOUNT_DISC.globalConfig, "GlobalConfig");
  return {
    disableFlags: data[56] ?? 0,
    protocolFeeRecipients: pubkeyList(data, 57, 8),
    buybackFeeRecipients: pubkeyList(data, 643, 8),
    creatorFeeConfigurable: bool(data, 940),
  };
}

// ---- SPL token / mint prefixes ----

/** `amount` of an SPL Token / Token-2022 token account. */
export function tokenAccountAmount(data: Bytes): bigint {
  return u64(data, 64);
}

/** `supply` of an SPL Token / Token-2022 mint. */
export function mintSupply(data: Bytes): bigint {
  return u64(data, 36);
}

// ---- borsh writer for instruction data ----

export class BorshWriter {
  private readonly parts: Uint8Array[] = [];

  raw(bytes: Uint8Array): this {
    this.parts.push(bytes);
    return this;
  }

  u8(v: number): this {
    return this.raw(Uint8Array.of(v));
  }

  bool(v: boolean): this {
    return this.u8(v ? 1 : 0);
  }

  u16(v: number): this {
    const b = new Uint8Array(2);
    view(b).setUint16(0, v, true);
    return this.raw(b);
  }

  u32(v: number): this {
    const b = new Uint8Array(4);
    view(b).setUint32(0, v, true);
    return this.raw(b);
  }

  u64(v: bigint | number): this {
    const b = new Uint8Array(8);
    view(b).setBigUint64(0, BigInt(v), true);
    return this.raw(b);
  }

  string(s: string): this {
    const bytes = new TextEncoder().encode(s);
    return this.u32(bytes.length).raw(bytes);
  }

  pubkey(k: PublicKey): this {
    return this.raw(k.toBytes());
  }

  build(): Buffer {
    return Buffer.concat(this.parts);
  }
}
