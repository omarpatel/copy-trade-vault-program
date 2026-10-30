/**
 * Test support: encodes Copier events exactly as the program emits them (`emit!` → `Program data:` log lines inside a
 * Copier invocation), using the SDK's IDL coder, so tests feed `parseCopierEvents` real log shapes.
 */
import { BN } from "@coral-xyz/anchor";
import { COPIER_PROGRAM_ID, copierProgram, type CopierEventMap, type CopierEventName } from "@copy-trade-vault/sdk";
import { PublicKey } from "@solana/web3.js";

const PROGRAM = COPIER_PROGRAM_ID.toBase58();
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Plain event data (bigint, base58, lower-case enum strings) → the IDL coder's input (BN, PublicKey, `{ variant: {} }`). */
function toIdl(value: unknown, key: string): unknown {
  if (typeof value === "bigint") return new BN(value.toString());
  if (typeof value === "number" && (key === "ts" || key === "eta" || key === "expiresAt")) return new BN(value);
  if (typeof value === "string" && BASE58.test(value)) return new PublicKey(value);
  if (typeof value === "string" && (key === "kind" || key === "venue" || key === "reason")) return { [value]: {} };
  if (Array.isArray(value)) return value.map((v) => toIdl(v, ""));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toIdl(v, k)]));
  return value;
}

export function programDataLine<K extends CopierEventName>(name: K, data: CopierEventMap[K]): string {
  const program = copierProgram();
  const ev = program.idl.events?.find((e) => e.name.toLowerCase() === name.toLowerCase());
  const type = program.idl.types?.find((t) => t.name.toLowerCase() === name.toLowerCase());
  if (!ev || !type) throw new Error(`IDL has no event ${name}`);
  const body = program.coder.types.encode(type.name, toIdl(data, ""));
  return `Program data: ${Buffer.concat([Buffer.from(ev.discriminator), body]).toString("base64")}`;
}

/** A successful top-level Copier instruction emitting `events`, optionally preceded by an SPL memo. */
export function copierTxLogs(events: { name: CopierEventName; data: CopierEventMap[CopierEventName] }[], memo?: string): string[] {
  const logs: string[] = [];
  if (memo) {
    logs.push(
      "Program MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr invoke [1]",
      `Program log: Memo (len ${memo.length}): "${memo}"`,
      "Program MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr consumed 3000 of 200000 compute units",
      "Program MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr success",
    );
  }
  logs.push(`Program ${PROGRAM} invoke [1]`, "Program log: Instruction: CopierBuy");
  for (const e of events) logs.push(programDataLine(e.name, e.data as never));
  logs.push(`Program ${PROGRAM} consumed 61234 of 197000 compute units`, `Program ${PROGRAM} success`);
  return logs;
}
