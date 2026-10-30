import bs58 from "bs58";
import type YellowstoneClient from "@triton-one/yellowstone-grpc";
import type { CommitmentLevel, SubscribeRequest, SubscribeUpdate, SubscribeUpdateTransaction } from "@triton-one/yellowstone-grpc";
import { errMsg, log } from "./log";
import type { RawInstruction, RawTokenBalance, RawTx } from "./rpc";

/**
 * Optional Yellowstone gRPC transaction stream (`GRPC_URL`, `GRPC_TOKEN`): one subscription with a filter that
 * requires a target among the accounts — with token-account expansion `BALANCE_CHANGED`, so transactions that only
 * touch a target's token accounts match too — `failed = false`, `vote = false`, at PROCESSED commitment.
 * Updates carry pre/post balances and token balances, so they go straight
 * to the classifier without a `getTransaction` round trip. The websocket watcher keeps running as cross-check.
 *
 * The client is a native (N-API) module published for Linux and macOS; where it cannot load (e.g. Windows dev
 * machines) the keeper logs `grpc_unavailable` and relies on the websocket + poll paths.
 */

const PING_MS = 15_000;
const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
/** `TokenAccountExpansionControlFlag.BALANCE_CHANGED`. */
const BALANCE_CHANGED = 1;
/** `CommitmentLevel.PROCESSED`. */
const PROCESSED = 0 as CommitmentLevel;

export interface GrpcStats {
  state: "unavailable" | "connecting" | "streaming" | "backoff" | "stopped";
  transactions: number;
  reconnects: number;
  lastUpdateAt: number | null;
  error: string | null;
}

interface Duplex {
  write(req: SubscribeRequest, cb?: (err?: Error | null) => void): boolean;
  on(event: "data", cb: (u: SubscribeUpdate) => void): unknown;
  on(event: "error" | "close" | "end", cb: (e?: unknown) => void): unknown;
  destroy(): void;
}

const keyOf = (bytes: Uint8Array) => bs58.encode(bytes);

/** A Yellowstone transaction update in the `getTransaction` JSON shape the classifier reads. */
export function grpcToRawTx(update: SubscribeUpdateTransaction, blockTime: number): RawTx | null {
  const info = update.transaction;
  const message = info?.transaction?.message;
  const meta = info?.meta;
  if (!info || !message || !meta || !message.header) return null;
  const ix = (i: { programIdIndex: number; accounts: Uint8Array; data: Uint8Array }): RawInstruction => ({
    programIdIndex: i.programIdIndex,
    accounts: [...i.accounts],
    data: bs58.encode(i.data),
  });
  const tb = (b: { accountIndex: number; mint: string; owner: string; programId: string; uiTokenAmount?: { amount: string; decimals: number } }): RawTokenBalance => ({
    accountIndex: b.accountIndex,
    mint: b.mint,
    owner: b.owner || undefined,
    programId: b.programId || undefined,
    uiTokenAmount: { amount: b.uiTokenAmount?.amount ?? "0", decimals: b.uiTokenAmount?.decimals ?? 0 },
  });
  return {
    slot: Number(update.slot),
    blockTime,
    version: message.versioned ? 0 : "legacy",
    transaction: {
      signatures: (info.transaction?.signatures ?? []).map(keyOf),
      message: {
        accountKeys: message.accountKeys.map(keyOf),
        header: message.header,
        instructions: message.instructions.map(ix),
      },
    },
    meta: {
      err: meta.err ? bs58.encode(meta.err.err) : null,
      fee: Number(meta.fee),
      preBalances: meta.preBalances.map(Number),
      postBalances: meta.postBalances.map(Number),
      preTokenBalances: meta.preTokenBalances.map(tb),
      postTokenBalances: meta.postTokenBalances.map(tb),
      loadedAddresses: { writable: meta.loadedWritableAddresses.map(keyOf), readonly: meta.loadedReadonlyAddresses.map(keyOf) },
      innerInstructions: meta.innerInstructions.map((inner) => ({ index: inner.index, instructions: inner.instructions.map(ix) })),
      logMessages: meta.logMessages,
    },
  };
}

export class GrpcSource {
  private stream: Duplex | null = null;
  private targets: string[] = [];
  private stats_: GrpcStats = { state: "connecting", transactions: 0, reconnects: 0, lastUpdateAt: null, error: null };
  private backoffMs = MIN_BACKOFF_MS;
  private pingTimer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private pingId = 1;

  constructor(
    private readonly url: string,
    private readonly token: string | undefined,
    private readonly onTx: (tx: RawTx) => void,
  ) {}

  stats(): GrpcStats {
    return { ...this.stats_ };
  }

  async start(targets: string[]): Promise<void> {
    this.targets = targets;
    await this.connect();
  }

  /** Replaces the subscription filter in place (Yellowstone accepts a new request on the open stream). */
  setTargets(targets: string[]): void {
    const changed = targets.length !== this.targets.length || targets.some((t, i) => t !== this.targets[i]);
    this.targets = targets;
    if (changed && this.stream) this.stream.write(this.request(), (err) => err && log("grpc_resubscribe_failed", { error: errMsg(err) }));
  }

  stop(): void {
    this.stopped = true;
    this.stats_.state = "stopped";
    clearInterval(this.pingTimer ?? undefined);
    clearTimeout(this.retryTimer ?? undefined);
    this.stream?.destroy();
  }

  private request(): SubscribeRequest {
    return {
      accounts: {},
      slots: {},
      transactions: {
        copier_targets: {
          vote: false,
          failed: false,
          accountInclude: this.targets,
          accountExclude: [],
          accountRequired: [],
          tokenAccounts: BALANCE_CHANGED,
        },
      },
      transactionsStatus: {},
      blocks: {},
      blocksMeta: {},
      entry: {},
      blockFooter: {},
      accountsDataSlice: [],
      commitment: PROCESSED,
    };
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    let Client: typeof YellowstoneClient;
    try {
      // Dynamic on purpose: the native binding only exists on Linux/macOS, and only GRPC_URL users need it.
      Client = (await import("@triton-one/yellowstone-grpc")).default;
    } catch (err) {
      this.stats_ = { ...this.stats_, state: "unavailable", error: errMsg(err) };
      log("grpc_unavailable", { error: errMsg(err), fallback: "websocket + poll" });
      return;
    }
    this.stats_.state = "connecting";
    try {
      const client = new Client(this.url, this.token, undefined);
      await client.connect();
      const stream = (await client.subscribe(this.request())) as unknown as Duplex;
      this.stream = stream;
      stream.on("data", (u: SubscribeUpdate) => this.onUpdate(u));
      stream.on("error", (e) => this.dropped(stream, errMsg(e)));
      stream.on("end", () => this.dropped(stream, "ended"));
      stream.on("close", () => this.dropped(stream, "closed"));
      this.stats_ = { ...this.stats_, state: "streaming", error: null };
      this.backoffMs = MIN_BACKOFF_MS;
      clearInterval(this.pingTimer ?? undefined);
      this.pingTimer = setInterval(() => {
        this.stream?.write({ ...this.request(), ping: { id: this.pingId++ } });
      }, PING_MS);
      this.pingTimer.unref();
      log("grpc_streaming", { origin: new URL(this.url).origin, targets: this.targets.length });
    } catch (err) {
      this.dropped(null, errMsg(err));
    }
  }

  private onUpdate(u: SubscribeUpdate): void {
    if (!u.transaction) return;
    const now = Date.now();
    this.stats_.lastUpdateAt = now;
    // PROCESSED updates precede the block time; the arrival time is within a slot of it.
    const tx = grpcToRawTx(u.transaction, Math.floor(now / 1000));
    if (!tx) return;
    this.stats_.transactions += 1;
    this.onTx(tx);
  }

  private dropped(stream: Duplex | null, why: string): void {
    if (stream && this.stream !== stream) return;
    this.stream = null;
    clearInterval(this.pingTimer ?? undefined);
    if (this.stopped) return;
    this.stats_ = { ...this.stats_, state: "backoff", error: why, reconnects: this.stats_.reconnects + 1 };
    log("grpc_reconnect", { why, retryInMs: this.backoffMs });
    clearTimeout(this.retryTimer ?? undefined);
    this.retryTimer = setTimeout(() => void this.connect(), this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
  }
}
