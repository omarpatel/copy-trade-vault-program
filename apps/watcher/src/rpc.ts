import type { Commitment } from "@solana/web3.js";
import { setTimeout as sleep } from "node:timers/promises";

/**
 * Raw JSON-RPC reads. Mainnet serves `version: 1` transactions (SIMD-0385) that web3.js 1.x cannot parse, and
 * `getTransaction` without `maxSupportedTransactionVersion: 1` fails on them with -32015;
 * so transactions are fetched here as plain JSON and classified from that shape.
 */

export interface RawTokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  programId?: string;
  uiTokenAmount: { amount: string; decimals: number };
}

export interface RawInstruction {
  programIdIndex: number;
  accounts: number[];
  /** base58 */
  data: string;
}

/** `getTransaction(…, {encoding: "json"})` result: legacy, v0 and v1 share this shape. */
export interface RawTx {
  slot: number;
  blockTime: number | null;
  version?: "legacy" | number;
  transaction: {
    signatures: string[];
    message: {
      accountKeys: string[];
      header: { numRequiredSignatures: number; numReadonlySignedAccounts: number; numReadonlyUnsignedAccounts: number };
      instructions: RawInstruction[];
    };
  };
  meta: {
    err: unknown;
    fee: number;
    preBalances: number[];
    postBalances: number[];
    preTokenBalances?: RawTokenBalance[] | null;
    postTokenBalances?: RawTokenBalance[] | null;
    loadedAddresses?: { writable: string[]; readonly: string[] } | null;
    innerInstructions?: { index: number; instructions: RawInstruction[] }[] | null;
    logMessages?: string[] | null;
  } | null;
}

export interface SignatureInfo {
  signature: string;
  slot: number;
  err: unknown;
  blockTime?: number | null;
}

export class RpcError extends Error {
  constructor(
    readonly method: string,
    readonly code: number | null,
    message: string,
  ) {
    super(`${method}: ${message}${code === null ? "" : ` (${code})`}`);
    this.name = "RpcError";
  }
}

const RETRY_STATUS: Record<number, true> = { 429: true, 502: true, 503: true, 504: true };

export class RawRpc {
  private nextId = 1;

  constructor(
    private readonly url: string,
    private readonly timeoutMs = 15_000,
  ) {}

  /** One JSON-RPC call; HTTP 429/5xx are retried with back-off (3 attempts). */
  async call<T>(method: string, params: unknown[]): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await sleep(300 * 2 ** attempt);
      let res: Response;
      try {
        res = await fetch(this.url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method, params }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        lastErr = err;
        continue;
      }
      if (RETRY_STATUS[res.status]) {
        await res.body?.cancel();
        lastErr = new RpcError(method, res.status, `HTTP ${res.status}`);
        continue;
      }
      const json = (await res.json()) as { result?: T; error?: { code?: number; message?: string } };
      if (json.error) throw new RpcError(method, json.error.code ?? null, json.error.message ?? "unknown error");
      return json.result as T;
    }
    throw lastErr instanceof Error ? lastErr : new RpcError(method, null, String(lastErr));
  }

  getTransaction(signature: string, commitment: Commitment = "confirmed"): Promise<RawTx | null> {
    return this.call<RawTx | null>("getTransaction", [
      signature,
      { encoding: "json", maxSupportedTransactionVersion: 1, commitment: commitment === "processed" ? "confirmed" : commitment },
    ]);
  }

  /** Newest first. `until` stops before that signature (exclusive), `before` starts below it. */
  getSignaturesForAddress(
    address: string,
    opts: { limit?: number; until?: string; before?: string; commitment?: Commitment } = {},
  ): Promise<SignatureInfo[]> {
    const { commitment, ...rest } = opts;
    return this.call<SignatureInfo[]>("getSignaturesForAddress", [
      address,
      { ...rest, commitment: commitment === "processed" ? "confirmed" : commitment ?? "confirmed" },
    ]);
  }
}
