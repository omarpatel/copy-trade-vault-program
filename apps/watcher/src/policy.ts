import {
  allowedSell,
  impactCapLamports,
  tokenValueLamports,
  spendWindowRemaining,
  type SpendWindowState,
  type ProgramParams,
  type SellablePosition,
  type UnsupportedVenueCode,
  type VenueReserves,
} from "@copy-trade-vault/sdk";
import type { SkipReason } from "@copy-trade-vault/sdk/api";
import type { ClassifiedTrade } from "./classifier";

/**
 * Whether and how much the vault copies a classified target trade (SPEC §4 Policy).
 * Pure: every input is read by the caller, so the rules are testable and the same decision is reproducible from
 * the recorded inputs. The program re-checks every bound on chain; these rules exist so the keeper never sends a
 * transaction the program would reject, and so every skip carries a reason the UI can show.
 *
 * Buy size = min(equity × max_trade, signal × signal_multiple, venue real SOL × max_impact,
 *                equity × max_position − position cost, free SOL − floor − rent allowance,
 *                spend window left − rent allowance)
 *            × conviction, conviction = clamp(k × target_spent / target_sol_before, floor, 1),
 * where signal = min(SOL the target spent, Δtokens × spot) — the smaller of what the target paid and what the
 * program will value the balance increase at, so an airdrop-sized or bait buy can only pull a proportionally
 * small copy (anti-bait c ≤ 1).
 */

const BPS = 10_000n;
/** Rent the program may book on a buy (vault ATA + pump user volume accumulator), SPEC §2: ≤ 0.01 SOL. */
export const RENT_ALLOWANCE_LAMPORTS = 10_000_000n;
/**
 * The program values the signal at execution-time spot, after the target's own buy moved the price and possibly
 * after others traded: size against 95% of the keeper's estimate so a small move does not flip the cap.
 */
export const SIGNAL_MARGIN_BPS = 9_500n;
/** A partial sell worth less than this (and not the whole position) waits for more to accumulate. */
export const DUST_SELL_LAMPORTS = 100_000n;

export type Cap = "trade_cap" | "signal" | "impact_cap" | "position_cap" | "vault_floor" | "spend_window";

export type VenueView =
  | {
      kind: "curve" | "pool";
      reserves: VenueReserves;
      /** Wallets that created the coin or earn its creator fees (curve/pool creator; fee-sharing shareholders). */
      creatorWallets: string[];
    }
  | { kind: "unsupported"; code: UnsupportedVenueCode };

export interface PolicyKnobs {
  maxSignalAgeSecs: number;
  convictionK: number;
  convictionFloorBps: number;
  deadQuoteLamports: bigint;
  reentryCooldownSecs: number;
}

export interface BuyInput {
  trade: Pick<ClassifiedTrade, "side" | "signer" | "target" | "tokenMint" | "tokenDelta" | "solDelta" | "solBefore" | "blockTime" | "isCreate">;
  /** The copier's own coin. */
  platformMint: string;
  params: ProgramParams;
  venue: VenueView;
  /** `copierEquity`: vault equity and free SOL (lamports). */
  equity: bigint;
  freeSol: bigint;
  /** The vault's open position in this token, if any (`target`: the basket wallet that opened it, base58). */
  position: { cost: bigint; lastTradeTs: bigint; target: string } | null;
  openPositions: number;
  /** The copier's rolling spend window (`Copier.window_start` / `window_spent` / `window_equity`). */
  window: SpendWindowState;
  /** Unix seconds. */
  nowTs: number;
  knobs: PolicyKnobs;
}

export type BuyDecision =
  | { action: "buy"; solIn: bigint; signalLamports: bigint; convictionBps: number; binding: Cap }
  | { action: "skip"; reason: SkipReason; detail: string };

const UNSUPPORTED_REASON: Record<UnsupportedVenueCode, SkipReason> = {
  mayhem: "mayhem",
  cashback: "unsupported_venue",
  non_sol_quote: "non_sol_quote",
  migrating: "migrating",
  no_venue: "unsupported_venue",
  not_a_mint: "unsupported_venue",
  empty_pool: "unsupported_venue",
};

const skip = (reason: SkipReason, detail: string): BuyDecision => ({ action: "skip", reason, detail });

/** conviction in bps: clamp(k × spent / before, floor, 10_000); the floor when the spend is unknown. */
export function convictionBps(spent: bigint, solBefore: bigint, k: number, floorBps: number): number {
  if (spent <= 0n || solBefore <= 0n) return floorBps;
  const raw = Math.floor((k * Number(spent) * 10_000) / Number(solBefore));
  return Math.min(10_000, Math.max(floorBps, raw));
}

export function decideBuy(input: BuyInput): BuyDecision {
  const { trade, params, venue, knobs } = input;
  if (trade.side === "airdrop" || !trade.signer) return skip("not_signer", "the target did not sign this transaction");
  if (trade.side !== "buy") return skip("not_a_trade", `target ${trade.side.replace("_", " ")} is not a buy`);
  if (trade.blockTime !== null && input.nowTs - trade.blockTime > knobs.maxSignalAgeSecs) {
    return skip("stale_signal", `seen ${input.nowTs - trade.blockTime}s after the target's block (max ${knobs.maxSignalAgeSecs}s)`);
  }
  if (trade.tokenMint === input.platformMint) return skip("own_mint", "a copier never trades its own coin");
  if (venue.kind === "unsupported") return skip(UNSUPPORTED_REASON[venue.code], `venue: ${venue.code}`);
  if (trade.isCreate || venue.creatorWallets.includes(trade.target)) {
    return skip("target_is_creator", "the target created this coin or earns its creator fees");
  }
  const real = venue.reserves.realQuoteReserve;
  if (real < knobs.deadQuoteLamports) return skip("token_dead", `venue holds ${real} lamports of real SOL`);

  const valued = tokenValueLamports(trade.tokenDelta, venue.reserves);
  const spent = trade.solDelta < 0n ? -trade.solDelta : 0n;
  const signal = spent > 0n && spent < valued ? spent : valued;
  if (signal < params.minSignalLamports) {
    return skip("signal_below_min", `signal ${signal} < min ${params.minSignalLamports} lamports`);
  }

  if (!input.position && input.openPositions >= params.maxOpenPositions) {
    return skip("max_positions", `${input.openPositions}/${params.maxOpenPositions} positions open`);
  }
  if (input.position && input.position.target !== trade.target) {
    return skip("held_by_other_target", `this token's position follows ${input.position.target}; one target per position`);
  }
  if (input.position && input.nowTs - Number(input.position.lastTradeTs) < knobs.reentryCooldownSecs) {
    return skip("reentry_cooldown", `the vault traded this token ${input.nowTs - Number(input.position.lastTradeTs)}s ago`);
  }

  const positionCost = input.position?.cost ?? 0n;
  const positionRoom = (input.equity * BigInt(params.maxPositionBps)) / BPS - positionCost;
  const floorRoom = input.freeSol - params.vaultFloorLamports - RENT_ALLOWANCE_LAMPORTS;
  // The program measures window spend with the ATA / volume-accumulator rent the buy pays: hold that back.
  const windowLeft = spendWindowRemaining(input.window, params, input.equity, input.nowTs) - RENT_ALLOWANCE_LAMPORTS;
  const windowRoom = windowLeft > 0n ? windowLeft : 0n;
  const caps: [Cap, bigint][] = [
    ["trade_cap", (input.equity * BigInt(params.maxTradeBps)) / BPS],
    ["signal", (((signal * BigInt(params.signalMultipleBps)) / BPS) * SIGNAL_MARGIN_BPS) / BPS],
    ["impact_cap", impactCapLamports(venue.reserves, params.maxImpactBps)],
    ["position_cap", positionRoom > 0n ? positionRoom : 0n],
    ["vault_floor", floorRoom > 0n ? floorRoom : 0n],
    ["spend_window", windowRoom],
  ];
  let [binding, base] = caps[0]!;
  for (const [name, value] of caps) if (value < base) [binding, base] = [name, value];

  if (base < params.minTradeLamports) {
    const reason: SkipReason = binding === "signal" ? "signal_below_min" : binding;
    return skip(reason, `${binding} allows ${base} lamports < min trade ${params.minTradeLamports}`);
  }
  const conviction = convictionBps(spent, trade.solBefore, knobs.convictionK, knobs.convictionFloorBps);
  const scaled = (base * BigInt(conviction)) / BPS;
  // Low conviction shrinks the copy, but never below the smallest trade worth sending (base already allows it).
  const solIn = scaled < params.minTradeLamports ? params.minTradeLamports : scaled;
  return { action: "buy", solIn, signalLamports: signal, convictionBps: conviction, binding };
}

export interface SellInput {
  position: (SellablePosition & { tokens: bigint }) | null;
  /** The target's balance of the token now (its canonical token account). */
  targetNow: bigint;
  nowTs: number;
  maxHoldSecs: bigint;
  /** Venue reserves for the dust check; null skips it. */
  reserves: VenueReserves | null;
}

export type SellDecision =
  | { action: "sell"; tokensIn: bigint; forced: boolean }
  | { action: "skip"; reason: SkipReason; detail: string };

/** The proportional, state-based sell (`allowedSell`): converges to the target's fraction however many events were missed. */
export function decideSell(input: SellInput): SellDecision {
  const { position } = input;
  if (!position || position.tokens <= 0n) return { action: "skip", reason: "no_position", detail: "the vault holds none of this token" };
  const proportional = allowedSell(position, input.targetNow);
  const allowed = allowedSell(position, input.targetNow, { nowTs: input.nowTs, maxHoldSecs: input.maxHoldSecs });
  if (allowed <= 0n) {
    return { action: "skip", reason: "nothing_to_sell", detail: `target still holds ${input.targetNow} (snapshot ${position.targetSnapshot})` };
  }
  if (allowed < position.tokens && input.reserves && tokenValueLamports(allowed, input.reserves) < DUST_SELL_LAMPORTS) {
    return { action: "skip", reason: "nothing_to_sell", detail: `allowed ${allowed} tokens are dust` };
  }
  return { action: "sell", tokensIn: allowed, forced: allowed > proportional };
}
