import {
  ComputeBudgetProgram,
  PACKET_DATA_SIZE,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  type AddressLookupTableAccount,
  type Connection,
  type Keypair,
  type TransactionInstruction,
} from "@solana/web3.js";
import { setTimeout as sleep } from "node:timers/promises";
import bs58 from "bs58";
import { fetchLookupTables, memoIx } from "@copy-trade-vault/sdk";
import type { KeeperConfig } from "./config";
import { errMsg, log } from "./log";

/**
 * Sends the keeper's transactions (SPEC §4 Execute): simulate at the compute ceiling, set the limit to simulated
 * units × 1.1, bid the recent fee market of the written accounts within [PRIORITY_MICROLAMPORTS,
 * MAX_PRIORITY_MICROLAMPORTS], attach the SPL memo `copier:<target signature>`, sign, send and confirm.
 *
 * With `JITO_URL` the transaction goes out as a single-transaction Jito bundle carrying a tip transfer that also
 * lists the read-only `jitodontfront…` account: the block engine then refuses any bundle that places a transaction
 * ahead of ours, which removes in-bundle sandwiches of the (public, predictable) vault copy.
 * It is not sent to the public RPC in that mode, since that would hand searchers the front-run anyway.
 */

const MAX_COMPUTE_UNITS = 1_400_000;
const CU_MARGIN = 1.1;
const FEE_PERCENTILE = 0.75;
const MAX_FEE_ACCOUNTS = 128;
const STATUS_POLL_MS = 400;
const REBROADCAST_MS = 2_000;
/** Any read-only account starting with `jitodontfront` enables Jito's don't-front protection. */
export const JITO_DONT_FRONT = new PublicKey("jitodontfront111111111111111111111111111111");
/** Jito mainnet tip accounts (used when the block engine's `getTipAccounts` is unreachable). */
const JITO_TIP_ACCOUNTS = [
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
];
/** Simulation replaces the blockhash, so the simulated message needs none of its own. */
const PLACEHOLDER_BLOCKHASH = PublicKey.default.toBase58();

/** The program (or runtime) rejected the transaction in simulation; nothing was sent. */
export class SimulationError extends Error {
  /** The Anchor error name (`Error Code: <name>.` in the logs), when the program raised one. */
  readonly code: string | null;

  constructor(
    readonly detail: string,
    readonly logs: string[],
  ) {
    super(`simulation failed: ${detail}`);
    this.name = "SimulationError";
    this.code = anchorErrorCode(logs);
  }
}

function anchorErrorCode(logs: string[]): string | null {
  for (let i = logs.length - 1; i >= 0; i--) {
    const m = /Error Code: (\w+)\./.exec(logs[i]!);
    if (m) return m[1]!;
  }
  return null;
}

/** Landed but failed, or never landed before the blockhash expired. */
export class SendError extends Error {
  constructor(
    message: string,
    readonly signature: string | null,
    readonly logs: string[] = [],
  ) {
    super(message);
    this.name = "SendError";
  }
}

export interface Sent {
  signature: string;
  simulatedUnits: number;
  computeUnits: number;
  priorityMicroLamports: number;
  jito: boolean;
  logs: string[];
}

export interface Simulated {
  units: number;
  logs: string[];
  /** Post-simulation lamports of the `watch` accounts (null = account absent after the tx). */
  lamports: (number | null)[];
}

/** The most specific error line of a failed simulation/transaction (Anchor error message, custom code, or raw err). */
export function describeFailure(err: unknown, logs: string[]): string {
  for (let i = logs.length - 1; i >= 0; i--) {
    const anchor = /Error Message: (.+?)\.?$/.exec(logs[i]!);
    if (anchor) return anchor[1]!;
  }
  for (let i = logs.length - 1; i >= 0; i--) {
    const custom = /failed: (custom program error: 0x[0-9a-f]+|.+)$/.exec(logs[i]!);
    if (custom && logs[i]!.startsWith("Program ")) return custom[1]!;
  }
  return typeof err === "string" ? err : JSON.stringify(err);
}

export class Executor {
  private table: AddressLookupTableAccount | null = null;
  private tipAccounts: PublicKey[] = JITO_TIP_ACCOUNTS.map((a) => new PublicKey(a));

  constructor(
    private readonly connection: Connection,
    private readonly cfg: KeeperConfig,
    /** Confirmation cadence (tests shorten it). */
    private readonly timing: { statusPollMs: number; rebroadcastMs: number } = { statusPollMs: STATUS_POLL_MS, rebroadcastMs: REBROADCAST_MS },
  ) {}

  /** Loads the lookup table and Jito's tip accounts; failures degrade (legacy-only sends, default tip accounts). */
  async start(): Promise<void> {
    await this.loadTable(this.cfg.alt);
    if (this.cfg.jito) {
      try {
        const accounts = await this.jitoCall<string[]>("getTipAccounts", []);
        if (accounts.length) this.tipAccounts = accounts.map((a) => new PublicKey(a));
      } catch (err) {
        log("jito_tip_accounts_default", { error: errMsg(err) });
      }
    }
  }

  /** (Re)loads the lookup table used for v0 sends; null = legacy only. */
  async loadTable(alt: PublicKey | null): Promise<void> {
    this.table = null;
    if (!alt) return;
    try {
      [this.table] = await fetchLookupTables(this.connection, [alt], this.cfg.commitment);
      this.tableFailure = null;
    } catch (err) {
      // The keeper retries every refresh until the table exists: report each distinct failure once.
      const failure = `${alt.toBase58()}: ${errMsg(err)}`;
      if (failure !== this.tableFailure) log("alt_unavailable", { alt: alt.toBase58(), error: errMsg(err) });
      this.tableFailure = failure;
    }
  }
  private tableFailure: string | null = null;

  get lookupTable(): string | null {
    return this.table?.key.toBase58() ?? null;
  }

  private compile(payer: PublicKey, ixs: TransactionInstruction[], blockhash: string): VersionedTransaction {
    const message = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: ixs });
    const tx = new VersionedTransaction(this.table ? message.compileToV0Message([this.table]) : message.compileToLegacyMessage());
    const size = 1 + 64 * tx.message.header.numRequiredSignatures + tx.message.serialize().length;
    if (size > PACKET_DATA_SIZE) {
      throw new SimulationError(`transaction is ${size} bytes (max ${PACKET_DATA_SIZE})${this.table ? "" : "; set COPIER_ALT"}`, []);
    }
    return tx;
  }

  /** Simulates `ixs` at the compute ceiling; throws `SimulationError` on rejection. */
  async simulate(payer: PublicKey, ixs: TransactionInstruction[], watch: PublicKey[] = []): Promise<Simulated> {
    const tx = this.compile(payer, [ComputeBudgetProgram.setComputeUnitLimit({ units: MAX_COMPUTE_UNITS }), ...ixs], PLACEHOLDER_BLOCKHASH);
    const { value } = await this.connection.simulateTransaction(tx, {
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: this.cfg.commitment,
      ...(watch.length ? { accounts: { addresses: watch.map((k) => k.toBase58()), encoding: "base64" as const } } : {}),
    });
    const logs = value.logs ?? [];
    if (value.err) throw new SimulationError(describeFailure(value.err, logs), logs);
    return { units: value.unitsConsumed ?? MAX_COMPUTE_UNITS, logs, lamports: (value.accounts ?? []).map((a) => (a ? a.lamports : null)) };
  }

  /**
   * Simulates, prices, signs, sends and confirms `ixs` with `signer` as fee payer. `memo` (e.g. `copier:<sig>`) is
   * appended as an SPL Memo instruction.
   */
  async send(signer: Keypair, ixs: TransactionInstruction[], opts: { memo?: string } = {}): Promise<Sent> {
    const payer = signer.publicKey;
    const body = [...ixs];
    if (opts.memo) body.push(memoIx(opts.memo));
    const jito = this.cfg.jito;
    if (jito) {
      const tip = SystemProgram.transfer({
        fromPubkey: payer,
        toPubkey: this.tipAccounts[Math.floor(Math.random() * this.tipAccounts.length)]!,
        lamports: jito.tipLamports,
      });
      tip.keys.push({ pubkey: JITO_DONT_FRONT, isSigner: false, isWritable: false });
      body.push(tip);
    }
    // The price instruction is part of the simulated message so its own units are counted.
    const [sim, micro, latest] = await Promise.all([
      this.simulate(payer, [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }), ...body]),
      this.priorityFee(payer, ixs),
      this.connection.getLatestBlockhash(this.cfg.commitment),
    ]);
    const computeUnits = Math.min(MAX_COMPUTE_UNITS, Math.ceil(sim.units * CU_MARGIN));
    const budget = [ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits })];
    if (micro > 0) budget.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: micro }));
    const tx = this.compile(payer, [...budget, ...body], latest.blockhash);
    tx.sign([signer]);
    const raw = tx.serialize();
    const signature = await this.broadcast(raw);
    const logs = await this.confirm(signature, raw, latest.lastValidBlockHeight);
    return { signature, simulatedUnits: sim.units, computeUnits, priorityMicroLamports: micro, jito: jito !== null, logs };
  }

  /** µlamports/CU: the 75th percentile of recent fees to write-lock these accounts, clamped to the configured bounds. */
  private async priorityFee(payer: PublicKey, ixs: TransactionInstruction[]): Promise<number> {
    const { floor, cap } = this.cfg.priority;
    if (cap === 0) return 0;
    const keys = new Map<string, PublicKey>([[payer.toBase58(), payer]]);
    for (const ix of ixs) for (const k of ix.keys) if (k.isWritable) keys.set(k.pubkey.toBase58(), k.pubkey);
    try {
      const recent = await this.connection.getRecentPrioritizationFees({ lockedWritableAccounts: [...keys.values()].slice(0, MAX_FEE_ACCOUNTS) });
      const fees = recent.map((f) => f.prioritizationFee).sort((a, b) => a - b);
      const market = fees.length ? fees[Math.ceil(fees.length * FEE_PERCENTILE) - 1]! : 0;
      return Math.min(cap, Math.max(floor, market));
    } catch {
      return floor;
    }
  }

  private async broadcast(raw: Uint8Array): Promise<string> {
    if (this.cfg.jito) {
      await this.jitoCall<string>("sendBundle", [[Buffer.from(raw).toString("base64")], { encoding: "base64" }]);
      return signatureOf(raw);
    }
    return this.connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 });
  }

  /**
   * Polls the signature (rebroadcasting every 2 s) until confirmed or the blockhash expired; returns the logs.
   * Expiry is checked whatever the status says: a transaction seen only `processed` (a minority fork) can never be
   * confirmed once the confirmed chain passed its last valid block height, and waiting on it would hold the copier's
   * lock forever.
   */
  private async confirm(signature: string, raw: Uint8Array, lastValidBlockHeight: number): Promise<string[]> {
    let nextBroadcast = Date.now() + this.timing.rebroadcastMs;
    for (;;) {
      await sleep(this.timing.statusPollMs);
      const due = Date.now() >= nextBroadcast;
      // Height before status: any block that could still include the transaction is then visible to the status read.
      const pastExpiry = due && (await this.connection.getBlockHeight("confirmed")) > lastValidBlockHeight;
      const [status] = (await this.connection.getSignatureStatuses([signature])).value;
      if (status && (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized" || this.cfg.commitment === "processed")) {
        const tx = await this.connection
          .getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 })
          .catch(() => null);
        const logs = tx?.meta?.logMessages ?? [];
        if (status.err) throw new SendError(`landed but failed: ${describeFailure(status.err, logs)}`, signature, logs);
        return logs;
      }
      if (pastExpiry) {
        throw new SendError(
          status
            ? `blockhash expired; the transaction only reached ${status.confirmationStatus ?? "processed"} (dropped fork)`
            : "blockhash expired before the transaction landed",
          signature,
        );
      }
      if (due) {
        nextBroadcast = Date.now() + this.timing.rebroadcastMs;
        void this.broadcast(raw).catch(() => undefined);
      }
    }
  }

  private async jitoCall<T>(method: string, params: unknown[]): Promise<T> {
    const base = this.cfg.jito!.url;
    const url = /\/api\/v1(\/|$)/.test(base) ? base : `${base}/api/v1/${method === "getTipAccounts" ? "getTipAccounts" : "bundles"}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
      signal: AbortSignal.timeout(10_000),
    });
    const json = (await res.json()) as { result?: T; error?: { message?: string } };
    if (json.error || json.result === undefined) throw new Error(`jito ${method}: ${json.error?.message ?? `HTTP ${res.status}`}`);
    return json.result;
  }
}

/** base58 of a serialized transaction's first signature. */
function signatureOf(raw: Uint8Array): string {
  const tx = VersionedTransaction.deserialize(raw);
  return bs58.encode(tx.signatures[0]!);
}
