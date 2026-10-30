import { PublicKey } from "@solana/web3.js";

export const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
export const MEMO_PROGRAMS: Record<string, true> = {
  MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr: true,
  Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo: true,
};

const INVOKE = /^Program (\w+) invoke \[\d+\]$/;
const RETURN = /^Program (\w+) (?:success|failed)/;
const DATA = "Program data: ";
const MEMO = /^Program log: Memo \(len \d+\): "(.*)"$/;
const COPIER_MEMO = /^copier:([1-9A-HJ-NP-Za-km-z]{64,88})$/;

/**
 * The target signature a keeper vault tx answers: its SPL Memo `copier:<target_signature>` (SPEC §2), read from the
 * memo program's own log line. null when the tx carries no such memo.
 */
export function copierMemoTarget(logs: string[]): string | null {
  let program: string | null = null;
  for (const line of logs) {
    const inv = INVOKE.exec(line);
    if (inv) {
      program = inv[1]!;
      continue;
    }
    if (!program || !MEMO_PROGRAMS[program]) continue;
    const memo = MEMO.exec(line);
    const sig = memo ? COPIER_MEMO.exec(memo[1]!) : null;
    if (sig) return sig[1]!;
  }
  return null;
}

/** pump `DistributeCreatorFeesEvent` (emitted by `distribute_creator_fees_v2`). */
export interface DistributeCreatorFeesEvent {
  timestamp: number;
  mint: string;
  bondingCurve: string;
  sharingConfig: string;
  admin: string;
  shareholders: { address: string; shareBps: number }[];
  distributed: bigint;
  quoteMint: string;
}

/** sha256("event:DistributeCreatorFeesEvent")[0..8], from pump's IDL. */
const DISTRIBUTE_EVENT = Buffer.from([165, 55, 129, 112, 4, 179, 202, 40]);

function decodeDistribute(b: Buffer): DistributeCreatorFeesEvent {
  let at = 8;
  const key = () => {
    const v = new PublicKey(b.subarray(at, at + 32)).toBase58();
    at += 32;
    return v;
  };
  const timestamp = Number(b.readBigInt64LE(at));
  at += 8;
  const mint = key();
  const bondingCurve = key();
  const sharingConfig = key();
  const admin = key();
  const n = b.readUInt32LE(at);
  at += 4;
  if (n > 64) throw new Error(`implausible shareholder count ${n}`);
  const shareholders: DistributeCreatorFeesEvent["shareholders"] = [];
  for (let i = 0; i < n; i++) {
    const address = key();
    shareholders.push({ address, shareBps: b.readUInt16LE(at) });
    at += 2;
  }
  const distributed = b.readBigUInt64LE(at);
  at += 8;
  return { timestamp, mint, bondingCurve, sharingConfig, admin, shareholders, distributed, quoteMint: key() };
}

/** Every `DistributeCreatorFeesEvent` pump logged in a transaction (inner calls included), in log order. */
export function parseDistributeEvents(logs: string[]): DistributeCreatorFeesEvent[] {
  const stack: string[] = [];
  const out: DistributeCreatorFeesEvent[] = [];
  for (const line of logs) {
    const inv = INVOKE.exec(line);
    if (inv) {
      stack.push(inv[1]!);
      continue;
    }
    if (RETURN.test(line)) {
      stack.pop();
      continue;
    }
    if (stack[stack.length - 1] !== PUMP_PROGRAM || !line.startsWith(DATA)) continue;
    const b = Buffer.from(line.slice(DATA.length), "base64");
    if (b.length < 8 || !b.subarray(0, 8).equals(DISTRIBUTE_EVENT)) continue;
    out.push(decodeDistribute(b));
  }
  return out;
}
