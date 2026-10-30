/**
 * Wallet-side trading on pump.fun curves and PumpSwap pools for the seed / simulate scripts: quotes from live
 * reserves and pump's fee schedule, slippage-bounded buys and sells through the SDK's builders (curve v3,
 * AMM v2), plain coin launches, and graduation (buy out the curve, then `migrate`).
 */
import { Connection, Keypair, PublicKey, type AddressLookupTableAccount } from "@solana/web3.js";
import {
  PUMP_AMM_FEE_CONFIG,
  PUMP_FEE_CONFIG,
  PUMP_GLOBAL,
  TOKEN_2022_PROGRAM_ID,
  ammBuyIxs,
  ammSellIxs,
  ata,
  bondingCurvePda,
  canonicalPoolPda,
  curveFeeBps,
  curveReserves,
  decodeBondingCurve,
  decodeFeeConfig,
  decodePool,
  decodePumpGlobal,
  mintSupply,
  poolFeeBps,
  poolReserves,
  pumpBuyIxs,
  pumpCreateV2Ix,
  pumpMigrateIx,
  pumpSellIx,
  tokenAccountAmount,
  venueBuyQuote,
  venueSellQuote,
  withSlippage,
  type BondingCurve,
  type FeeBps,
  type FeeConfig,
  type Pool,
  type PumpGlobal,
  type VenueReserves,
} from "@copy-trade-vault/sdk";
import { send } from "./common";

export type Venue =
  | { kind: "curve"; curve: BondingCurve; reserves: VenueReserves; fees: FeeBps }
  | { kind: "pool"; pool: Pool; address: PublicKey; reserves: VenueReserves; fees: FeeBps }
  /** Curve complete but not migrated yet. */
  | { kind: "complete"; curve: BondingCurve }
  | { kind: "none" };

export interface TradeResult {
  signature: string;
  venue: "curve" | "pool";
  /** Tokens bought (buy) or sold (sell), raw units. */
  tokens: bigint;
  /** Lamports spent (buy) or the quoted proceeds (sell). */
  lamports: bigint;
}

const DEFAULT_SLIPPAGE_BPS = 500;

export class Market {
  private feeConfigs: { curve: FeeConfig; pool: FeeConfig } | null = null;
  private global: PumpGlobal | null = null;

  constructor(
    readonly connection: Connection,
    private readonly lookupTables: AddressLookupTableAccount[] = [],
  ) {}

  private async fees(): Promise<{ curve: FeeConfig; pool: FeeConfig }> {
    if (!this.feeConfigs) {
      const [curve, pool] = await this.connection.getMultipleAccountsInfo([PUMP_FEE_CONFIG, PUMP_AMM_FEE_CONFIG]);
      if (!curve || !pool) throw new Error("pump fee configs missing: the validator must clone them (pnpm localnet start --reset)");
      this.feeConfigs = { curve: decodeFeeConfig(curve.data), pool: decodeFeeConfig(pool.data) };
    }
    return this.feeConfigs;
  }

  async pumpGlobal(): Promise<PumpGlobal> {
    if (!this.global) {
      const info = await this.connection.getAccountInfo(PUMP_GLOBAL);
      if (!info) throw new Error("pump Global missing: the validator must clone it (pnpm localnet start --reset)");
      this.global = decodePumpGlobal(info.data);
    }
    return this.global;
  }

  /** Where `mint` trades right now, with reserves and the fee bps that apply. */
  async venue(mint: PublicKey): Promise<Venue> {
    const poolAddress = canonicalPoolPda(mint);
    const [curveInfo, mintInfo, poolInfo] = await this.connection.getMultipleAccountsInfo([bondingCurvePda(mint), mint, poolAddress]);
    const supply = mintInfo ? mintSupply(mintInfo.data) : undefined;
    const fees = await this.fees();
    if (curveInfo) {
      const curve = decodeBondingCurve(curveInfo.data);
      if (!curve.complete) {
        const reserves = curveReserves(curve, supply);
        return { kind: "curve", curve, reserves, fees: curveFeeBps(fees.curve, curve, reserves.supply) };
      }
      if (!poolInfo) return { kind: "complete", curve };
    }
    if (!poolInfo) return { kind: "none" };
    const pool = decodePool(poolInfo.data);
    const [base, quote] = await this.connection.getMultipleAccountsInfo([pool.poolBaseTokenAccount, pool.poolQuoteTokenAccount]);
    if (!base || !quote) return { kind: "none" };
    const reserves = poolReserves(pool, tokenAccountAmount(base.data), tokenAccountAmount(quote.data), supply);
    return {
      kind: "pool",
      pool,
      address: poolAddress,
      reserves,
      fees: poolFeeBps(fees.pool, pool, reserves.baseReserve, reserves.quoteReserve, reserves.supply),
    };
  }

  /** Raw token balance of `owner`'s Token-2022 ATA for `mint` (0 when it has none). */
  async tokenBalance(owner: PublicKey, mint: PublicKey): Promise<bigint> {
    const info = await this.connection.getAccountInfo(ata(owner, mint, TOKEN_2022_PROGRAM_ID));
    return info ? tokenAccountAmount(info.data) : 0n;
  }

  /** Buys `mint` for `solIn` lamports on its live venue (fails on an unsupported venue). */
  async buy(user: Keypair, mint: PublicKey, solIn: bigint, slippageBps = DEFAULT_SLIPPAGE_BPS): Promise<TradeResult> {
    const venue = await this.venue(mint);
    if (venue.kind !== "curve" && venue.kind !== "pool") throw new Error(`${mint.toBase58()} has no live venue (${venue.kind})`);
    const quote = venueBuyQuote(venue.reserves, solIn, venue.fees);
    if (quote.tokensOut <= 0n) throw new Error(`buy of ${solIn} lamports quotes 0 tokens`);
    const minTokensOut = withSlippage(quote.tokensOut, slippageBps);
    const ixs =
      venue.kind === "curve"
        ? pumpBuyIxs({ user: user.publicKey, mint, solIn, minTokensOut })
        : ammBuyIxs({ user: user.publicKey, mint, solIn, minTokensOut });
    const signature = await send(this.connection, user, ixs, [], { lookupTables: this.lookupTables, label: `${venue.kind} buy` });
    return { signature, venue: venue.kind, tokens: quote.tokensOut, lamports: solIn };
  }

  /** Sells `tokensIn` of `mint` on its live venue. */
  async sell(user: Keypair, mint: PublicKey, tokensIn: bigint, slippageBps = DEFAULT_SLIPPAGE_BPS): Promise<TradeResult> {
    const venue = await this.venue(mint);
    if (venue.kind !== "curve" && venue.kind !== "pool") throw new Error(`${mint.toBase58()} has no live venue (${venue.kind})`);
    const quote = venueSellQuote(venue.reserves, tokensIn, venue.fees);
    const minSolOut = withSlippage(quote.solOut, slippageBps);
    const ixs =
      venue.kind === "curve"
        ? [pumpSellIx({ user: user.publicKey, mint, tokensIn, minSolOut })]
        : ammSellIxs({ user: user.publicKey, mint, tokensIn, minSolOut });
    const signature = await send(this.connection, user, ixs, [], { lookupTables: this.lookupTables, label: `${venue.kind} sell` });
    return { signature, venue: venue.kind, tokens: tokensIn, lamports: quote.solOut };
  }

  /** A plain pump.fun coin (no fee sharing): `creator` launches and keeps the creator fees. */
  async createCoin(creator: Keypair, p: { name: string; symbol: string; uri: string }): Promise<{ mint: PublicKey; signature: string }> {
    const mint = Keypair.generate();
    const signature = await send(
      this.connection,
      creator,
      [pumpCreateV2Ix({ mint: mint.publicKey, user: creator.publicKey, creator: creator.publicKey, ...p })],
      [mint],
      { lookupTables: this.lookupTables, label: `create ${p.symbol}` },
    );
    return { mint: mint.publicKey, signature };
  }

  /**
   * Graduates `mint`: `whale` buys the rest of the curve (one buy sized past the remaining reserves; pump
   * fills what is left), then migrates it into its canonical PumpSwap pool. Returns the migrate signature.
   */
  async graduate(whale: Keypair, mint: PublicKey): Promise<string> {
    for (let round = 0; round < 6; round++) {
      const venue = await this.venue(mint);
      if (venue.kind === "pool") throw new Error(`${mint.toBase58()} already graduated`);
      if (venue.kind === "complete") break;
      if (venue.kind !== "curve") throw new Error(`${mint.toBase58()} has no curve`);
      // Lamports that buy every remaining token: x·y = k on the virtual reserves, plus fees and a margin.
      const { baseReserve: vT, quoteReserve: vQ, realBaseReserve: realT } = venue.reserves;
      const net = (vQ * vT) / (vT - realT) - vQ;
      const solIn = (net * 10_300n) / 10_000n + 10_000_000n;
      // Any fill is fine: the last buy of a curve is capped at its real reserves.
      await send(this.connection, whale, pumpBuyIxs({ user: whale.publicKey, mint, solIn, minTokensOut: 1n }), [], {
        lookupTables: this.lookupTables,
        label: "graduation buy",
      });
    }
    const global = await this.pumpGlobal();
    return send(this.connection, whale, [pumpMigrateIx({ user: whale.publicKey, mint, withdrawAuthority: global.withdrawAuthority })], [], {
      lookupTables: this.lookupTables,
      label: "migrate",
    });
  }
}
