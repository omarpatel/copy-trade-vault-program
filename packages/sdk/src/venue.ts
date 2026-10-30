/**
 * Where a token trades right now and the accounts / reserves / fees a copier trade on it needs.
 * curve PDA exists & !complete → pump curve (v3 trades); else canonical pool → PumpSwap (AMM v2);
 * else unsupported.
 */
import { PublicKey, type AccountInfo, type AccountMeta, type Commitment, type Connection } from "@solana/web3.js";
import {
  PUMP_AMM_FEE_CONFIG,
  PUMP_AMM_GLOBAL_CONFIG,
  PUMP_BUYBACK_FEE_RECIPIENTS,
  PUMP_FEE_CONFIG,
  PUMP_GLOBAL,
  PUMP_AMM_PROGRAM_ID,
  PUMP_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  WSOL_MINT,
} from "./constants";
import {
  decodeAmmGlobalConfig,
  decodeBondingCurve,
  decodeFeeConfig,
  decodePool,
  decodePumpGlobal,
  mintSupply,
  tokenAccountAmount,
  type AmmGlobalConfig,
  type BondingCurve,
  type FeeConfig,
  type Pool,
  type PumpGlobal,
} from "./layout";
import { curveFeeBps, poolFeeBps } from "./math";
import { curveReserves, poolReserves, type FeeBps, type VenueReserves } from "./quote";
import { bondingCurvePda, canonicalPoolPda } from "./pda";
import { curveVenueAccounts, pickRandom, poolVenueAccounts, type PoolKeys } from "./pump";

/** pump's global accounts every quote / trade reads; cache it (it changes rarely). */
export interface PumpState {
  global: PumpGlobal;
  ammGlobalConfig: AmmGlobalConfig;
  curveFeeConfig: FeeConfig;
  ammFeeConfig: FeeConfig;
}

const PUMP_STATE_KEYS = [PUMP_GLOBAL, PUMP_AMM_GLOBAL_CONFIG, PUMP_FEE_CONFIG, PUMP_AMM_FEE_CONFIG];

function pumpStateOf(infos: (AccountInfo<Buffer> | null)[]): PumpState {
  const [g, gc, cf, af] = infos;
  if (!g || !gc || !cf || !af) throw new Error("pump Global / GlobalConfig / FeeConfig accounts missing on this cluster");
  return {
    global: decodePumpGlobal(g.data),
    ammGlobalConfig: decodeAmmGlobalConfig(gc.data),
    curveFeeConfig: decodeFeeConfig(cf.data),
    ammFeeConfig: decodeFeeConfig(af.data),
  };
}

export async function fetchPumpState(connection: Connection, commitment: Commitment = "confirmed"): Promise<PumpState> {
  return pumpStateOf(await connection.getMultipleAccountsInfo(PUMP_STATE_KEYS, commitment));
}

/** The keys a venue trade needs besides the trader: everything `venueTradeAccounts` derives from. */
export interface VenueAccounts {
  kind: "curve" | "pool";
  tokenMint: PublicKey;
  /** Owner of the token mint (Token-2022 for create_v2 coins). */
  tokenProgram: PublicKey;
  /** Bonding curve or pool address. */
  venue: PublicKey;
  /** A live buyback fee recipient wallet, picked at random. */
  buybackFeeRecipient: PublicKey;
  /** Pool venues only. */
  pool?: PoolKeys;
}

/** The venue's 17 trade accounts for `user` (curve v3 or AMM v2 order; `user` non-signer unless `userSigns`). */
export function venueTradeAccounts(accounts: VenueAccounts, user: PublicKey, userSigns = false): AccountMeta[] {
  if (accounts.kind === "curve") {
    return curveVenueAccounts({
      user,
      mint: accounts.tokenMint,
      tokenProgram: accounts.tokenProgram,
      buybackFeeRecipient: accounts.buybackFeeRecipient,
      userSigns,
    });
  }
  if (!accounts.pool) throw new Error("pool venue without pool keys");
  return poolVenueAccounts({
    user,
    pool: accounts.pool,
    tokenProgram: accounts.tokenProgram,
    buybackFeeRecipient: accounts.buybackFeeRecipient,
    userSigns,
  });
}

export type ResolvedVenue =
  | {
      kind: "curve";
      accounts: VenueAccounts;
      reserves: VenueReserves;
      feeBps: FeeBps;
      curve: BondingCurve;
    }
  | {
      kind: "pool";
      accounts: VenueAccounts;
      reserves: VenueReserves;
      feeBps: FeeBps;
      pool: Pool;
    }
  | { kind: "unsupported"; tokenMint: PublicKey; code: UnsupportedVenueCode; reason: string };

export type UnsupportedVenueCode = "mayhem" | "cashback" | "non_sol_quote" | "migrating" | "no_venue" | "not_a_mint" | "empty_pool";

/**
 * Resolves `tokenMint`'s live venue with at most two RPC round trips (one more when `pumpState` is
 * not given). Mayhem, cashback and non-SOL-quoted coins are unsupported, as the program rejects them.
 */
export async function resolveVenue(
  connection: Connection,
  tokenMint: PublicKey,
  opts: { pumpState?: PumpState; commitment?: Commitment } = {},
): Promise<ResolvedVenue> {
  const commitment = opts.commitment ?? "confirmed";
  const curveKey = bondingCurvePda(tokenMint);
  const poolKey = canonicalPoolPda(tokenMint);
  const infos = await connection.getMultipleAccountsInfo(
    [curveKey, poolKey, tokenMint, ...(opts.pumpState ? [] : PUMP_STATE_KEYS)],
    commitment,
  );
  const [rawCurve, rawPool, mintInfo] = infos;
  // Anyone can fund a PDA address; only accounts the venue programs own are venues.
  const curveInfo = rawCurve?.owner.equals(PUMP_PROGRAM_ID) ? rawCurve : null;
  const poolInfo = rawPool?.owner.equals(PUMP_AMM_PROGRAM_ID) ? rawPool : null;
  const state = opts.pumpState ?? pumpStateOf(infos.slice(3));
  const unsupported = (code: UnsupportedVenueCode, reason: string): ResolvedVenue => ({ kind: "unsupported", tokenMint, code, reason });

  if (!mintInfo) return unsupported("not_a_mint", "mint not found");
  const tokenProgram = mintInfo.owner;
  if (!tokenProgram.equals(TOKEN_PROGRAM_ID) && !tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) return unsupported("not_a_mint", "not a token mint");
  const supply = mintSupply(mintInfo.data);

  if (curveInfo) {
    const curve = decodeBondingCurve(curveInfo.data);
    if (!curve.complete) {
      if (curve.isMayhemMode) return unsupported("mayhem", "mayhem coin");
      if (curve.isCashbackCoin) return unsupported("cashback", "cashback coin");
      if (!curve.quoteMint.equals(PublicKey.default) && !curve.quoteMint.equals(WSOL_MINT)) return unsupported("non_sol_quote", "not SOL-quoted");
      return {
        kind: "curve",
        accounts: {
          kind: "curve",
          tokenMint,
          tokenProgram,
          venue: curveKey,
          buybackFeeRecipient: pickRandom(state.global.buybackFeeRecipients.length ? state.global.buybackFeeRecipients : PUMP_BUYBACK_FEE_RECIPIENTS),
        },
        reserves: curveReserves(curve, supply),
        feeBps: curveFeeBps(state.curveFeeConfig, curve, supply, state.global.creatorFeeConfigurable),
        curve,
      };
    }
    if (!poolInfo) return unsupported("migrating", "curve complete, awaiting migration");
  }
  if (!poolInfo) return unsupported("no_venue", "no pump curve or canonical pool");

  const pool = decodePool(poolInfo.data);
  if (!pool.quoteMint.equals(WSOL_MINT)) return unsupported("non_sol_quote", "not SOL-quoted");
  if (pool.isMayhemMode) return unsupported("mayhem", "mayhem coin");
  if (pool.isCashbackCoin) return unsupported("cashback", "cashback coin");
  const [baseVault, quoteVault] = await connection.getMultipleAccountsInfo(
    [pool.poolBaseTokenAccount, pool.poolQuoteTokenAccount],
    commitment,
  );
  if (!baseVault || !quoteVault) return unsupported("empty_pool", "pool vaults missing");
  const reserves = poolReserves(pool, tokenAccountAmount(baseVault.data), tokenAccountAmount(quoteVault.data), supply);
  if (reserves.baseReserve === 0n || reserves.quoteReserve === 0n) return unsupported("empty_pool", "empty pool");
  const buybacks = state.ammGlobalConfig.buybackFeeRecipients;
  return {
    kind: "pool",
    accounts: {
      kind: "pool",
      tokenMint,
      tokenProgram,
      venue: poolKey,
      buybackFeeRecipient: pickRandom(buybacks.length ? buybacks : PUMP_BUYBACK_FEE_RECIPIENTS),
      pool: {
        pool: poolKey,
        baseMint: tokenMint,
        poolBaseTokenAccount: pool.poolBaseTokenAccount,
        poolQuoteTokenAccount: pool.poolQuoteTokenAccount,
      },
    },
    reserves,
    feeBps: poolFeeBps(state.ammFeeConfig, pool, reserves.baseReserve, reserves.quoteReserve, supply, state.ammGlobalConfig.creatorFeeConfigurable),
    pool,
  };
}
