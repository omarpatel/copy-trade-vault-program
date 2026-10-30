/**
 * Raw JSON-RPC `getTransaction`: web3.js 1.x cannot parse version-1 messages, and the
 * indexer only needs logs, balances, block time and the account key list.
 */

export interface TokenBalance {
  accountIndex: number;
  mint: string;
  owner: string | null;
  amount: bigint;
}

export interface RawTx {
  slot: number;
  blockTime: number | null;
  err: unknown;
  fee: bigint;
  logs: string[];
  /** Static keys followed by the loaded writable then readonly addresses (balance index space). */
  keys: string[];
  /** Static keys that signed (the first `numRequiredSignatures`). */
  signers: string[];
  preBalances: number[];
  postBalances: number[];
  preTokenBalances: TokenBalance[];
  postTokenBalances: TokenBalance[];
}

interface RpcTokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string };
}

interface RpcTxResult {
  slot: number;
  blockTime?: number | null;
  meta: {
    err: unknown;
    fee?: number;
    logMessages?: string[] | null;
    preBalances?: number[];
    postBalances?: number[];
    preTokenBalances?: RpcTokenBalance[] | null;
    postTokenBalances?: RpcTokenBalance[] | null;
    loadedAddresses?: { writable?: string[]; readonly?: string[] } | null;
  } | null;
  transaction: {
    message: {
      accountKeys?: (string | { pubkey: string })[];
      header?: { numRequiredSignatures: number };
    };
  };
}

/**
 * Ceiling for `maxSupportedTransactionVersion`: the node refuses newer txs otherwise. Public pump trades and keeper
 * txs may be version 1; nothing here decodes the message beyond its key list.
 */
const MAX_TX_VERSION = 255;
const TIMEOUT_MS = 15_000;
export const WSOL_MINT = "So11111111111111111111111111111111111111112";

let nextId = 1;

export async function rpcCall<T>(rpcUrl: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
  const body = (await res.json()) as { result?: T; error?: { code: number; message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message} (${body.error.code})`);
  return body.result as T;
}

const tokenBalances = (list: RpcTokenBalance[] | null | undefined): TokenBalance[] =>
  (list ?? []).map((b) => ({ accountIndex: b.accountIndex, mint: b.mint, owner: b.owner ?? null, amount: BigInt(b.uiTokenAmount.amount) }));

/** null while the node doesn't serve the transaction (not yet confirmed / unknown). */
export async function getRawTx(rpcUrl: string, signature: string): Promise<RawTx | null> {
  const r = await rpcCall<RpcTxResult | null>(rpcUrl, "getTransaction", [
    signature,
    { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: MAX_TX_VERSION },
  ]);
  if (!r) return null;
  const staticKeys = (r.transaction.message.accountKeys ?? []).map((k) => (typeof k === "string" ? k : k.pubkey));
  const loaded = r.meta?.loadedAddresses;
  return {
    slot: r.slot,
    blockTime: r.blockTime ?? null,
    err: r.meta?.err ?? null,
    fee: BigInt(r.meta?.fee ?? 0),
    logs: r.meta?.logMessages ?? [],
    keys: [...staticKeys, ...(loaded?.writable ?? []), ...(loaded?.readonly ?? [])],
    signers: staticKeys.slice(0, r.transaction.message.header?.numRequiredSignatures ?? 1),
    preBalances: r.meta?.preBalances ?? [],
    postBalances: r.meta?.postBalances ?? [],
    preTokenBalances: tokenBalances(r.meta?.preTokenBalances),
    postTokenBalances: tokenBalances(r.meta?.postTokenBalances),
  };
}

/** Lamport balance change of `address` in the tx (null when the address is not among its keys). */
export function lamportDelta(tx: RawTx, address: string): bigint | null {
  const i = tx.keys.indexOf(address);
  if (i < 0 || tx.preBalances[i] === undefined || tx.postBalances[i] === undefined) return null;
  return BigInt(tx.postBalances[i]!) - BigInt(tx.preBalances[i]!);
}

function ownerTokenTotal(list: TokenBalance[], owner: string, mint: string): bigint {
  let sum = 0n;
  for (const b of list) if (b.owner === owner && b.mint === mint) sum += b.amount;
  return sum;
}

/**
 * The target's side of a trade tx (balance deltas): token delta of `mint` over
 * every account it owns, SOL delta with its wSOL folded in and the tx fee added back when it paid it.
 */
export function walletDeltas(
  tx: RawTx,
  wallet: string,
  mint: string,
): { tokenDelta: bigint; solDelta: bigint; solBefore: bigint } | null {
  const i = tx.keys.indexOf(wallet);
  if (i < 0) return null;
  const pre = BigInt(tx.preBalances[i] ?? 0);
  const post = BigInt(tx.postBalances[i] ?? 0);
  const feePaid = i === 0 ? tx.fee : 0n;
  const wsol = ownerTokenTotal(tx.postTokenBalances, wallet, WSOL_MINT) - ownerTokenTotal(tx.preTokenBalances, wallet, WSOL_MINT);
  return {
    tokenDelta: ownerTokenTotal(tx.postTokenBalances, wallet, mint) - ownerTokenTotal(tx.preTokenBalances, wallet, mint),
    solDelta: post - pre + feePaid + wsol,
    solBefore: pre,
  };
}
