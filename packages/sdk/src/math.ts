/**
 * Fee selection from a live pump_fees `FeeConfig` (crate `math::fees`): which schedule and tier a
 * trade pays right now. Needs PublicKey comparisons, so it lives apart from the web3-free `quote.ts`.
 */
import { PublicKey } from "@solana/web3.js";
import { TOKEN_2022_NATIVE_MINT, USDC_MINT, WSOL_MINT } from "./constants";
import type { BondingCurve, FeeConfig, Fees, Pool } from "./layout";
import { poolAuthorityPda } from "./pda";
import { pickFeeTier, type FeeBps } from "./quote";

const isSolLikeQuote = (quoteMint: PublicKey) =>
  quoteMint.equals(PublicKey.default) || quoteMint.equals(WSOL_MINT) || quoteMint.equals(TOKEN_2022_NATIVE_MINT);

/** Which schedule of a FeeConfig applies (crate `fees_for_quote_mint`). */
function scheduleFees(cfg: FeeConfig, isPumpPool: boolean, mcapLamports: bigint, quoteMint: PublicKey): Fees {
  if (!isPumpPool) return cfg.flatFees;
  if (isSolLikeQuote(quoteMint)) return pickFeeTier(cfg.feeTiers, mcapLamports);
  if (quoteMint.equals(USDC_MINT)) return pickFeeTier(cfg.stableFeeTiers, mcapLamports);
  const x = cfg.exoticFlatFees;
  return x.lpBps === 0 && x.protocolBps === 0 && x.creatorBps === 0 ? cfg.flatFees : x;
}

/**
 * Fee bps of a bonding-curve trade right now. `mintSupply` is the live mint supply (mayhem coins
 * use the curve's stored total supply). `creatorFeeConfigurable` = `Global.creator_fee_configurable`.
 */
export function curveFeeBps(cfg: FeeConfig, curve: BondingCurve, mintSupply: bigint, creatorFeeConfigurable = false): FeeBps {
  const supply = curve.isMayhemMode ? curve.tokenTotalSupply : mintSupply;
  const mcap = curve.virtualTokenReserves === 0n ? 0n : (curve.virtualQuoteReserves * supply) / curve.virtualTokenReserves;
  const f = scheduleFees(cfg, true, mcap, curve.quoteMint);
  const creatorBps = curve.creator.equals(PublicKey.default)
    ? 0
    : creatorFeeConfigurable && curve.creatorFeeBps !== 0n
      ? Number(curve.creatorFeeBps)
      : f.creatorBps;
  return { lpBps: 0, protocolBps: f.protocolBps, creatorBps };
}

/**
 * Fee bps of a PumpSwap trade right now. `quoteReserve` is the effective (pricing) quote reserve,
 * `baseReserve` the base vault balance, `mintSupply` the live base mint supply.
 */
export function poolFeeBps(
  cfg: FeeConfig,
  pool: Pool,
  baseReserve: bigint,
  quoteReserve: bigint,
  mintSupply: bigint,
  creatorFeeConfigurable = false,
): FeeBps {
  const mcap = baseReserve === 0n ? 0n : (quoteReserve * mintSupply) / baseReserve;
  const isPumpPool = poolAuthorityPda(pool.baseMint).equals(pool.creator);
  const f = scheduleFees(cfg, isPumpPool, mcap, pool.quoteMint);
  const creatorBps = pool.coinCreator.equals(PublicKey.default)
    ? 0
    : creatorFeeConfigurable && pool.creatorFeeBps !== 0n
      ? Number(pool.creatorFeeBps)
      : f.creatorBps;
  return { lpBps: f.lpBps, protocolBps: f.protocolBps, creatorBps };
}
