import { createHash, timingSafeEqual } from "node:crypto";
import type { CopyStatus, SkipReason, TargetTradeIngest, TargetTradeSide, TargetTradesIngestResponse, VenueOrUnsupported } from "@copy-trade-vault/sdk/api";
import type { FastifyInstance } from "fastify";
import type { TargetTradeRow } from "./db";
import { HttpError, isRecord, isSignature, parsePubkey, ValidationError } from "./sanitize";

export const MAX_INGEST_BATCH = 50;
export const MAX_INGEST_BYTES = 256 * 1024;

const SIDES: Record<TargetTradeSide, true> = { buy: true, sell: true, transfer_in: true, transfer_out: true, airdrop: true };
const STATUSES: Record<CopyStatus, true> = { copied: true, skipped: true, failed: true };
const VENUES: Record<VenueOrUnsupported, true> = { curve: true, pool: true, unsupported: true };
const REASONS: Record<SkipReason, true> = {
  not_signer: true,
  not_a_trade: true,
  unsupported_venue: true,
  signal_below_min: true,
  trade_cap: true,
  position_cap: true,
  impact_cap: true,
  max_positions: true,
  below_min_trade: true,
  vault_floor: true,
  own_mint: true,
  target_is_creator: true,
  token_dead: true,
  no_position: true,
  nothing_to_sell: true,
  non_sol_quote: true,
  mayhem: true,
  migrating: true,
  keeper_not_authorized: true,
  simulation_failed: true,
  send_failed: true,
  reentry_cooldown: true,
  held_by_other_target: true,
  stale_signal: true,
  paused: true,
  spend_window: true,
};

const INT = /^-?\d{1,20}$/;
const UINT = /^\d{1,20}$/;

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}

function field<T>(ok: boolean, label: string, i: number, value: T): T {
  if (!ok) throw new ValidationError(`trades[${i}].${label} is invalid`);
  return value;
}

function nullableUint(v: unknown, label: string, i: number): string | null {
  if (v === null || v === undefined) return null;
  return field(typeof v === "string" && UINT.test(v), label, i, v as string);
}

function unixMs(v: unknown, label: string, i: number): number {
  return field(typeof v === "number" && Number.isSafeInteger(v) && v >= 0, label, i, v as number);
}

/** Validates one keeper report into a `target_trades` row (`received_at` = now). */
export function parseTargetTrade(raw: unknown, i: number, now: number): TargetTradeRow {
  if (!isRecord(raw)) throw new ValidationError(`trades[${i}] must be an object`);
  const t = raw as Partial<Record<keyof TargetTradeIngest, unknown>>;
  const copier = field(parsePubkey(t.copier) !== null, "copier", i, t.copier as string);
  const target = field(parsePubkey(t.target) !== null, "target", i, t.target as string);
  const tokenMint = field(parsePubkey(t.tokenMint) !== null, "tokenMint", i, t.tokenMint as string);
  const signature = field(isSignature(t.signature), "signature", i, t.signature as string);
  const slot = field(typeof t.slot === "number" && Number.isSafeInteger(t.slot) && t.slot >= 0, "slot", i, t.slot as number);
  const blockTime =
    t.blockTime === null || t.blockTime === undefined
      ? null
      : field(typeof t.blockTime === "number" && Number.isSafeInteger(t.blockTime) && t.blockTime > 0, "blockTime", i, t.blockTime as number);
  const side = field(typeof t.side === "string" && t.side in SIDES, "side", i, t.side as TargetTradeSide);
  const status = field(typeof t.status === "string" && t.status in STATUSES, "status", i, t.status as CopyStatus);
  const reason =
    t.reason === null || t.reason === undefined ? null : field(typeof t.reason === "string" && t.reason in REASONS, "reason", i, t.reason as SkipReason);
  if (status === "skipped" && reason === null) throw new ValidationError(`trades[${i}].reason is required when skipped`);
  const venue =
    t.venue === null || t.venue === undefined ? null : field(typeof t.venue === "string" && t.venue in VENUES, "venue", i, t.venue as VenueOrUnsupported);
  const vaultSig =
    t.vaultSignature === null || t.vaultSignature === undefined
      ? null
      : field(isSignature(t.vaultSignature), "vaultSignature", i, t.vaultSignature as string);
  if (status === "copied" && vaultSig === null) throw new ValidationError(`trades[${i}].vaultSignature is required when copied`);
  const price =
    t.priceLamportsPerToken === null || t.priceLamportsPerToken === undefined
      ? null
      : field(
          typeof t.priceLamportsPerToken === "number" && Number.isFinite(t.priceLamportsPerToken) && t.priceLamportsPerToken >= 0,
          "priceLamportsPerToken",
          i,
          t.priceLamportsPerToken as number,
        );
  const error = t.error === null || t.error === undefined ? null : field(typeof t.error === "string", "error", i, String(t.error).slice(0, 500));
  return {
    copier,
    signature,
    target,
    slot,
    block_time: blockTime,
    side,
    token_mint: tokenMint,
    token_delta: field(typeof t.tokenDelta === "string" && INT.test(t.tokenDelta), "tokenDelta", i, t.tokenDelta as string),
    sol_delta: field(typeof t.solDelta === "string" && INT.test(t.solDelta), "solDelta", i, t.solDelta as string),
    target_sol_before: field(typeof t.targetSolBefore === "string" && UINT.test(t.targetSolBefore), "targetSolBefore", i, t.targetSolBefore as string),
    price,
    venue,
    status,
    reason,
    error,
    vault_sig: vaultSig,
    vault_sol_in: nullableUint(t.vaultSolIn, "vaultSolIn", i),
    vault_tokens_in: nullableUint(t.vaultTokensIn, "vaultTokensIn", i),
    detected_at: unixMs(t.detectedAt, "detectedAt", i),
    decided_at: unixMs(t.decidedAt, "decidedAt", i),
    source: "keeper",
    received_at: now,
  };
}

export function parseIngestBody(body: unknown, now: number): TargetTradeRow[] {
  if (!isRecord(body) || !Array.isArray(body.trades)) throw new ValidationError("body must be { trades: TargetTradeIngest[] }");
  if (body.trades.length === 0 || body.trades.length > MAX_INGEST_BATCH) {
    throw new ValidationError(`trades must hold 1..${MAX_INGEST_BATCH} entries`);
  }
  return body.trades.map((t, i) => parseTargetTrade(t, i, now));
}

/** `POST /internal/target-trades`: bearer-authenticated keeper reports (idempotent upsert on (copier, signature)). */
export function registerIngest(app: FastifyInstance, opts: { token: string; onTrades: (rows: TargetTradeRow[]) => void }): void {
  app.post("/internal/target-trades", { bodyLimit: MAX_INGEST_BYTES }, async (req, reply) => {
    const auth = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!token || !safeEqual(token, opts.token)) throw new HttpError(401, "invalid ingest token");
    const rows = parseIngestBody(req.body, Math.floor(Date.now() / 1000));
    opts.onTrades(rows);
    return reply.send({ accepted: rows.length } satisfies TargetTradesIngestResponse);
  });
}
