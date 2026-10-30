import { createHash } from "node:crypto";
import bs58 from "bs58";
import type { TargetTradeSide } from "@copy-trade-vault/sdk/api";
import type { RawInstruction, RawTokenBalance, RawTx } from "./rpc";

/**
 * What a target wallet did in one transaction, read from balance deltas rather than instruction layouts.
 * Pump, PumpSwap, Jupiter, terminal routers and the
 * undocumented v3/AMM-v2 instructions all move the same balances, so diffing survives venues we never decoded.
 *
 * Per tracked wallet W:
 * - keys = static keys ++ loaded writable ++ loaded readonly; W signs iff its index < numRequiredSignatures.
 * - token deltas are grouped by (owner == W, mint) — owner, not account address, so non-ATA accounts count too.
 * - wSOL (and Token-2022's native mint) is SOL: folded into the SOL side; USDC/USDT count as a quote counter-flow.
 * - SOL side = Δlamports + fee (when W paid it) + ΔwSOL − rent locked in token accounts W opened + rent W got back
 *   from token accounts it closed, so ATA creation/close does not read as trade flow.
 * - BUY = W signed, one non-SOL mint up, SOL/quote down. SELL = W signed, one mint down, SOL/quote up.
 *   Token→token swaps produce a SELL leg and a BUY leg. A signed move without counter-flow is a TRANSFER.
 *   An unsigned increase is an AIRDROP (never copied); an unsigned decrease is a TRANSFER out (delegate/limit
 *   fills), which the vault de-risks on like a sell.
 */

export const WSOL_MINT = "So11111111111111111111111111111111111111112";
const TOKEN_2022_NATIVE_MINT = "9pan9bMn5HatX4EJdBwg9VgCa7Uz5HL8N1m5D3NdXejP";
const SOL_MINTS: Record<string, true> = { [WSOL_MINT]: true, [TOKEN_2022_NATIVE_MINT]: true };
/** Stable quotes: a counter-flow, never a position. */
const QUOTE_MINTS: Record<string, true> = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: true, // USDC
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: true, // USDT
};

export const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
export const PUMP_AMM_PROGRAM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
export const JUPITER_PROGRAM = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";

const anchorDisc = (name: string) => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8).toString("hex");
/** pump `create` / `create_v2`: a buy in the same tx is the creator's dev buy. */
const PUMP_CREATE_DISCS: Record<string, true> = { [anchorDisc("create")]: true, [anchorDisc("create_v2")]: true };

export type VenueHint = "pump" | "pump_amm" | "jupiter" | "other";

export interface ClassifiedTrade {
  signature: string;
  slot: number;
  blockTime: number | null;
  target: string;
  /** The target signed the transaction. */
  signer: boolean;
  side: TargetTradeSide;
  tokenMint: string;
  decimals: number;
  /** Owner of the token accounts (SPL Token or Token-2022), from the token balances. */
  tokenProgram: string | null;
  /** Raw units held by the target across its accounts of this mint, before / after. */
  tokenBefore: bigint;
  tokenAfter: bigint;
  /** tokenAfter − tokenBefore. */
  tokenDelta: bigint;
  /**
   * Trade SOL flow from the target's side (negative = spent), rent-corrected, fee excluded, wSOL folded. Zero when the
   * leg has no SOL counter-flow of its own (transfers; token→token swaps; several legs sharing one SOL flow).
   */
  solDelta: bigint;
  /** The target's SOL + wSOL before the transaction (conviction denominator). */
  solBefore: bigint;
  /** |solDelta| / |tokenDelta| in lamports per raw unit; null without an attributed SOL flow. */
  priceLamportsPerToken: number | null;
  /** Programs the transaction invoked, most specific first. */
  venueHint: VenueHint;
  /** A pump create/create_v2 ran in this tx (the target launching its own coin). */
  isCreate: boolean;
}

/** Static keys, then the lookup-table keys (writable first): the index space of every account reference. */
export function accountKeys(tx: RawTx): string[] {
  const loaded = tx.meta?.loadedAddresses;
  const keys = tx.transaction.message.accountKeys;
  return loaded ? [...keys, ...loaded.writable, ...loaded.readonly] : keys;
}

/** Every wallet that owns a token balance in `tx` or appears among its keys (candidates for target matching). */
export function involvedWallets(tx: RawTx): Set<string> {
  const out = new Set(accountKeys(tx));
  for (const b of [...(tx.meta?.preTokenBalances ?? []), ...(tx.meta?.postTokenBalances ?? [])]) if (b.owner) out.add(b.owner);
  return out;
}

interface MintSide {
  amount: bigint;
  decimals: number;
  programId: string | null;
}

function sumByMint(balances: RawTokenBalance[], owner: string): Map<string, MintSide> {
  const out = new Map<string, MintSide>();
  for (const b of balances) {
    if (b.owner !== owner) continue;
    const prev = out.get(b.mint);
    out.set(b.mint, {
      amount: (prev?.amount ?? 0n) + BigInt(b.uiTokenAmount.amount),
      decimals: b.uiTokenAmount.decimals,
      programId: b.programId ?? prev?.programId ?? null,
    });
  }
  return out;
}

function venueOf(tx: RawTx, keys: string[]): { hint: VenueHint; isCreate: boolean } {
  const all: RawInstruction[] = [...tx.transaction.message.instructions];
  for (const inner of tx.meta?.innerInstructions ?? []) all.push(...inner.instructions);
  let pump = false;
  let amm = false;
  let jup = false;
  let isCreate = false;
  for (const ix of all) {
    const program = keys[ix.programIdIndex];
    if (program === PUMP_PROGRAM) {
      pump = true;
      if (!isCreate && ix.data) {
        const data = bs58.decode(ix.data);
        if (data.length >= 8 && PUMP_CREATE_DISCS[Buffer.from(data.subarray(0, 8)).toString("hex")]) isCreate = true;
      }
    } else if (program === PUMP_AMM_PROGRAM) amm = true;
    else if (program === JUPITER_PROGRAM) jup = true;
  }
  // A Jupiter route through a pump venue is still a pump-venue trade for copying purposes.
  const hint: VenueHint = pump ? "pump" : amm ? "pump_amm" : jup ? "jupiter" : "other";
  return { hint, isCreate };
}

/**
 * The target's legs in `tx` (empty: failed tx, wallet absent, or no non-SOL token moved). Several legs only for
 * multi-token transactions (token→token swaps).
 */
export function classifyTx(tx: RawTx, target: string): ClassifiedTrade[] {
  const meta = tx.meta;
  if (!meta || meta.err) return [];
  const keys = accountKeys(tx);
  const idx = keys.indexOf(target);
  const preTok = meta.preTokenBalances ?? [];
  const postTok = meta.postTokenBalances ?? [];
  const pre = sumByMint(preTok, target);
  const post = sumByMint(postTok, target);
  if (idx < 0 && pre.size === 0 && post.size === 0) return [];

  const signer = idx >= 0 && idx < tx.transaction.message.header.numRequiredSignatures;
  let lamportDelta = 0n;
  let solBefore = 0n;
  if (idx >= 0) {
    lamportDelta = BigInt(meta.postBalances[idx]! - meta.preBalances[idx]!);
    // The fee payer's drop includes the network fee (priority fee too), which is not part of the trade.
    if (idx === 0) lamportDelta += BigInt(meta.fee);
    solBefore = BigInt(meta.preBalances[idx]!);
  }

  // Rent parked in token accounts the target opened / released from accounts it closed in this tx.
  const preByIdx = new Map(preTok.filter((b) => b.owner === target).map((b) => [b.accountIndex, b]));
  const postByIdx = new Map(postTok.filter((b) => b.owner === target).map((b) => [b.accountIndex, b]));
  let rentCorrection = 0n;
  for (const [i, b] of postByIdx) {
    if (preByIdx.has(i) || meta.preBalances[i] !== 0) continue;
    const native = SOL_MINTS[b.mint] ? BigInt(b.uiTokenAmount.amount) : 0n;
    rentCorrection += BigInt(meta.postBalances[i]!) - native;
  }
  for (const [i, b] of preByIdx) {
    if (postByIdx.has(i) || meta.postBalances[i] !== 0) continue;
    const native = SOL_MINTS[b.mint] ? BigInt(b.uiTokenAmount.amount) : 0n;
    rentCorrection -= BigInt(meta.preBalances[i]!) - native;
  }

  let wsolDelta = 0n;
  let quoteDelta = 0n;
  const legs: { mint: string; before: bigint; after: bigint; delta: bigint; decimals: number; programId: string | null }[] = [];
  for (const mint of new Set([...pre.keys(), ...post.keys()])) {
    const before = pre.get(mint)?.amount ?? 0n;
    const after = post.get(mint)?.amount ?? 0n;
    const delta = after - before;
    if (SOL_MINTS[mint]) {
      solBefore += before;
      wsolDelta += delta;
      continue;
    }
    if (delta === 0n) continue;
    if (QUOTE_MINTS[mint]) {
      quoteDelta += delta;
      continue;
    }
    const side = post.get(mint) ?? pre.get(mint)!;
    legs.push({ mint, before, after, delta, decimals: side.decimals, programId: side.programId });
  }
  if (legs.length === 0) return [];

  const netSol = lamportDelta + wsolDelta + rentCorrection;
  const ups = legs.filter((l) => l.delta > 0n).length;
  const downs = legs.length - ups;
  const { hint, isCreate } = venueOf(tx, keys);
  const signature = tx.transaction.signatures[0]!;

  return legs.map((leg) => {
    const up = leg.delta > 0n;
    let side: TargetTradeSide;
    let solDelta = 0n;
    if (!signer) {
      side = up ? "airdrop" : "transfer_out";
    } else if (up) {
      const paid = netSol < 0n || quoteDelta < 0n || downs > 0;
      side = paid ? "buy" : "transfer_in";
      // Only a lone buy leg owns the SOL that left the wallet.
      if (paid && ups === 1 && netSol < 0n) solDelta = netSol;
    } else {
      const received = netSol > 0n || quoteDelta > 0n || ups > 0;
      side = received ? "sell" : "transfer_out";
      if (received && downs === 1 && netSol > 0n) solDelta = netSol;
    }
    const abs = leg.delta < 0n ? -leg.delta : leg.delta;
    const solAbs = solDelta < 0n ? -solDelta : solDelta;
    return {
      signature,
      slot: tx.slot,
      blockTime: tx.blockTime,
      target,
      signer,
      side,
      tokenMint: leg.mint,
      decimals: leg.decimals,
      tokenProgram: leg.programId,
      tokenBefore: leg.before,
      tokenAfter: leg.after,
      tokenDelta: leg.delta,
      solDelta,
      solBefore,
      priceLamportsPerToken: solDelta === 0n ? null : Number(solAbs) / Number(abs),
      venueHint: hint,
      isCreate,
    };
  });
}
