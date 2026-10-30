import { PublicKey, type Connection } from "@solana/web3.js";
import { setTimeout as sleep } from "node:timers/promises";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, tokenAccountAmount } from "@copy-trade-vault/sdk";
import type { KeeperConfig } from "./config";
import { errMsg, log } from "./log";
import { RpcError, type RawRpc, type RawTx, type SignatureInfo } from "./rpc";
import type { State } from "./state";
import { Stream, type StreamStats } from "./ws";

/**
 * Finds target-wallet transactions with as little noise as possible. Top KOL wallets are
 * mentioned by ~1,000 mostly failed spam transactions per 15 s, so mention-based feeds are not used. Instead:
 *
 * 1. State subscriptions on one websocket, per target:
 *    - `accountSubscribe(target)`: lamports move on every trade the target pays for;
 *    - `programSubscribe(Token | Token-2022, memcmp owner@32 = target)`: any balance change of its token accounts.
 * 2. A token-account change is confirmed through that token account's own signatures (low-noise, unlike the
 *    wallet's): `getSignaturesForAddress(<token account>)` → raw `getTransaction(maxSupportedTransactionVersion: 1)`.
 * 3. A lamports change re-reads the token accounts the vaults care about (the targets' accounts of mints the vaults
 *    hold), which drives sells even where a provider refuses `programSubscribe` on the token programs.
 * 4. Poll fallback: every `POLL_MS` (every `POLL_FALLBACK_MS` while the socket is down or refused a subscription),
 *    each target's own signatures since its persisted cursor, plus the tracked token accounts. Also run on every
 *    websocket reconnect, so the gap is backfilled.
 * 5. Yellowstone gRPC (`GRPC_URL`) feeds full transactions straight into `ingest`, skipping the fetch.
 *
 * Durability and order: every address (a target wallet, or one of its token accounts) is drained through its
 * target's serial lane — all signatures since the persisted cursor, walked back page by page until the cursor is
 * reached (resumable across polls when the gap is large), then handled oldest first, one at a time. The cursor moves
 * to a signature only after that signature was handled (classified, decided, marked seen), so a crash at any point
 * re-reads everything not yet handled, and a target's sell can never be decided before the buy it follows.
 * Different targets drain in parallel; `getTransaction` fetches share one concurrency limit.
 */

const FETCH_WAITS_MS = [0, 150, 300, 600, 1_200, 2_500];
/** A signature whose transaction the node does not serve (or whose handling throws) this many times is given up. */
const MAX_ATTEMPTS = 5;
/** A processed notification can precede the token account's confirmed signature list; look again this often. */
const ATA_SIG_RETRIES_MS = [0, 400, 800, 1_600, 3_200];
const LAMPORTS_DEBOUNCE_MS = 250;
/** `getSignaturesForAddress` page size (the RPC maximum) and pages walked per drain before resuming next time. */
const PAGE_SIZE = 1_000;
const MAX_PAGES_PER_DRAIN = 5;
/** History older than this is ignored on the first change of a token account the keeper has no cursor for. */
const FIRST_SIGHT_HORIZON_SECS = 600;

export type TxSource = "ws" | "poll" | "grpc" | "backfill";

export interface TrackedAccount {
  target: string;
  tokenAccount: string;
}

export interface DetectorStats {
  targets: number;
  trackedAccounts: number;
  stream: StreamStats | null;
  /** Targets whose token-program subscription the provider refused (served by polling instead). */
  refusedTargets: number;
  queued: number;
  inFlight: number;
  fetched: number;
  failed: number;
  /** Addresses whose backlog walk is still in progress (large gap after downtime). */
  walking: number;
  bySource: Record<TxSource, number>;
  lastPollAt: number | null;
  pollIntervalMs: number;
}

interface TargetSubs {
  lamports: number;
  token: number;
  token2022: number;
  lastLamports: number | null;
  debounce: NodeJS.Timeout | null;
}

/** A backlog walk from the newest signature back to the cursor, continued by later drains when it is long. */
interface Walk {
  cursor: string;
  /** Next page starts below this signature. */
  before: string;
  /** Newest signature of the whole window (the cursor's final position). */
  newest: { signature: string; slot: number };
  /** Successful signatures of the window, newest first. */
  pending: { signature: string; slot: number }[];
}

export type TxHandler = (tx: RawTx, source: TxSource, detectedAt: number) => Promise<void>;

/** Fetching failed in a way that says nothing about the transaction (RPC down, rate limit): retry later, no give-up. */
class TransientFetchError extends Error {}

export interface DetectorOptions {
  websocket: boolean;
  /** Page size / pages per drain (tests use small values). */
  pageSize?: number;
  maxPagesPerDrain?: number;
}

export class Detector {
  private readonly stream: Stream | null;
  private readonly subs = new Map<string, TargetSubs>();
  /** Last seen amount per token account (diffed against notifications). */
  private readonly amounts = new Map<string, bigint>();
  private tracked: TrackedAccount[] = [];
  /** Signature → its handling in progress (any path waits for it instead of skipping it). */
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly failures = new Map<string, number>();
  /** Per-target serial lanes (tail of the chain). */
  private readonly lanes = new Map<string, Promise<unknown>>();
  /** Drains queued but not started yet, per address key: later requests share them. */
  private readonly queuedDrains = new Map<string, Promise<number>>();
  private readonly walks = new Map<string, Walk>();
  private readonly waiting: (() => void)[] = [];
  private readonly pageSize: number;
  private readonly maxPagesPerDrain: number;
  private active = 0;
  private fetched = 0;
  private failed = 0;
  private readonly bySource: Record<TxSource, number> = { ws: 0, poll: 0, grpc: 0, backfill: 0 };
  private pollTimer: NodeJS.Timeout | null = null;
  private polling = false;
  private lastPollAt: number | null = null;
  private stopped = false;

  constructor(
    private readonly cfg: KeeperConfig,
    private readonly connection: Pick<Connection, "getMultipleAccountsInfo">,
    private readonly rpc: Pick<RawRpc, "getSignaturesForAddress" | "getTransaction">,
    private readonly state: State,
    private readonly onTx: TxHandler,
    opts: DetectorOptions,
  ) {
    this.pageSize = opts.pageSize ?? PAGE_SIZE;
    this.maxPagesPerDrain = opts.maxPagesPerDrain ?? MAX_PAGES_PER_DRAIN;
    this.stream = opts.websocket ? new Stream(cfg.wsUrl, cfg.commitment) : null;
    if (this.stream) this.stream.onReconnect = () => void this.poll("backfill");
  }

  start(): void {
    this.schedulePoll(0);
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.pollTimer ?? undefined);
    for (const s of this.subs.values()) clearTimeout(s.debounce ?? undefined);
    this.stream?.close();
  }

  get targets(): string[] {
    return [...this.subs.keys()];
  }

  /** Subscribes new targets and drops removed ones. */
  setTargets(targets: string[]): void {
    const next = new Set(targets);
    for (const [target, s] of this.subs) {
      if (next.has(target)) continue;
      this.stream?.remove(s.lamports);
      this.stream?.remove(s.token);
      this.stream?.remove(s.token2022);
      clearTimeout(s.debounce ?? undefined);
      this.subs.delete(target);
    }
    for (const target of next) {
      if (this.subs.has(target)) continue;
      const s: TargetSubs = { lamports: 0, token: 0, token2022: 0, lastLamports: null, debounce: null };
      if (this.stream) {
        s.lamports = this.stream.account(target, (n) => this.onLamports(target, n.lamports));
        s.token = this.stream.tokenAccountsOf(TOKEN_PROGRAM_ID.toBase58(), target, (n) => this.onTokenAccount(target, n.pubkey, n.data, "ws"));
        s.token2022 = this.stream.tokenAccountsOf(TOKEN_2022_PROGRAM_ID.toBase58(), target, (n) => this.onTokenAccount(target, n.pubkey, n.data, "ws"));
      }
      this.subs.set(target, s);
      // A new target is primed (its history is not replayed) on the next poll.
      this.schedulePoll(0);
    }
  }

  /** After a cluster change: forget balances and walks; cursors are gone from SQLite, so the next poll re-primes. */
  resetCluster(): void {
    this.amounts.clear();
    this.walks.clear();
    this.tracked = [];
    this.schedulePoll(0);
  }

  /** Token accounts whose balance drives vault sells (the targets' accounts of mints a vault holds). */
  setTracked(accounts: TrackedAccount[]): void {
    this.tracked = accounts;
  }

  stats(): DetectorStats {
    let refused = 0;
    for (const s of this.subs.values()) if (this.stream && (this.stream.refused(s.token) || this.stream.refused(s.token2022))) refused++;
    return {
      targets: this.subs.size,
      trackedAccounts: this.tracked.length,
      stream: this.stream?.stats() ?? null,
      refusedTargets: refused,
      queued: this.waiting.length,
      inFlight: this.inFlight.size,
      fetched: this.fetched,
      failed: this.failed,
      walking: this.walks.size,
      bySource: { ...this.bySource },
      lastPollAt: this.lastPollAt,
      pollIntervalMs: this.pollInterval(),
    };
  }

  /** A full transaction from a push source (gRPC): handled without a fetch, deduplicated like everything else. */
  async ingest(tx: RawTx, source: TxSource): Promise<void> {
    const signature = tx.transaction.signatures[0];
    if (!signature || this.stopped || this.state.hasSeen(signature)) return;
    try {
      await this.handleOnce(signature, async () => {
        await this.onTx(tx, source, Date.now());
        this.state.markSeen(signature);
        this.bySource[source] += 1;
      });
    } catch (err) {
      // Not marked seen: the poll / token-account paths pick it up from their cursors.
      log("ingest_failed", { signature, source, error: errMsg(err) });
    }
  }

  /** One full poll round: every target wallet, then the tracked token accounts. Resolves when all drains are done. */
  async poll(source: TxSource = "poll"): Promise<void> {
    if (this.stopped || this.polling) return;
    this.polling = true;
    try {
      await Promise.all([...this.subs.keys()].map((t) => this.drainWallet(t, source)));
      await this.refreshTracked(source);
      this.lastPollAt = Date.now();
    } finally {
      this.polling = false;
      this.schedulePoll(this.pollInterval());
    }
  }

  private pollInterval(): number {
    const degraded =
      !this.stream ||
      !this.stream.healthy ||
      [...this.subs.values()].some((s) => this.stream!.refused(s.token) || this.stream!.refused(s.token2022));
    return degraded ? this.cfg.pollFallbackMs : this.cfg.pollMs;
  }

  private schedulePoll(delayMs: number): void {
    if (this.stopped) return;
    clearTimeout(this.pollTimer ?? undefined);
    this.pollTimer = setTimeout(() => void this.poll("poll"), delayMs);
  }

  // ------------------------------------------------------------------ lanes

  /** Runs `fn` after everything queued on `target`'s lane. */
  private onLane<T>(target: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.lanes.get(target) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const settled = next.catch(() => undefined);
    this.lanes.set(target, settled);
    void settled.then(() => {
      if (this.lanes.get(target) === settled) this.lanes.delete(target);
    });
    return next;
  }

  /** Queues a drain of `key` on `target`'s lane; a drain already queued (not started) absorbs the request. */
  private requestDrain(target: string, key: string, run: () => Promise<number>): Promise<number> {
    const queued = this.queuedDrains.get(key);
    if (queued) return queued;
    const p = this.onLane(target, () => {
      this.queuedDrains.delete(key);
      return run();
    });
    this.queuedDrains.set(key, p);
    return p;
  }

  private drainWallet(target: string, source: TxSource): Promise<number> {
    const key = `wallet:${target}`;
    return this.requestDrain(target, key, () => this.drain(key, target, source, "prime")).catch((err) => {
      if (!this.dropUnknownCursor(key, err)) log("poll_failed", { target, error: errMsg(err) });
      return 0;
    });
  }

  /**
   * Handles every successful signature of `address` newer than its cursor, oldest first, moving the cursor after
   * each. First sight (no cursor): `prime` only records the newest signature; `horizon` handles the recent ones.
   * Returns how many signatures were handled.
   */
  private async drain(key: string, address: string, source: TxSource, firstSight: "prime" | "horizon"): Promise<number> {
    if (this.stopped) return 0;
    const cursor = this.state.cursor(key);
    if (!cursor) {
      const page = await this.rpc.getSignaturesForAddress(address, { limit: firstSight === "prime" ? 1 : this.pageSize, commitment: this.cfg.commitment });
      const newest = page[0];
      if (!newest) return 0;
      if (firstSight === "prime") {
        this.state.setCursor(key, newest.signature, newest.slot);
        log("target_primed", { key, cursor: newest.signature });
        return 0;
      }
      const horizon = Math.floor(Date.now() / 1000) - FIRST_SIGHT_HORIZON_SECS;
      const recent = page.filter((s) => !s.err && (s.blockTime ?? horizon) >= horizon);
      return this.handleWindow(key, source, recent, { signature: newest.signature, slot: newest.slot });
    }

    let walk = this.walks.get(key);
    if (walk && walk.cursor !== cursor.signature) walk = undefined;
    let pages = 0;
    if (!walk) {
      const first = await this.page(address, cursor.signature, undefined);
      pages = 1;
      const newest = first[0];
      if (!newest) return 0;
      walk = { cursor: cursor.signature, before: newest.signature, newest: { signature: newest.signature, slot: newest.slot }, pending: [] };
      if (!this.collect(walk, first)) return this.finishWalk(key, walk, source);
    }
    for (; pages < this.maxPagesPerDrain; pages++) {
      if (!this.collect(walk, await this.page(address, walk.cursor, walk.before))) return this.finishWalk(key, walk, source);
    }
    // The gap is longer than one drain walks: keep the partial walk; the next drain continues below `before`.
    this.walks.set(key, walk);
    log("backlog_walk", { key, collected: walk.pending.length, before: walk.before });
    return 0;
  }

  private page(address: string, until: string, before: string | undefined): Promise<SignatureInfo[]> {
    return this.rpc.getSignaturesForAddress(address, { limit: this.pageSize, until, before, commitment: this.cfg.commitment });
  }

  /** Adds a page to the walk; false when the page reached the cursor (the walk is complete). */
  private collect(walk: Walk, page: SignatureInfo[]): boolean {
    for (const s of page) if (!s.err) walk.pending.push({ signature: s.signature, slot: s.slot });
    const last = page[page.length - 1];
    if (last) walk.before = last.signature;
    return page.length >= this.pageSize;
  }

  private finishWalk(key: string, walk: Walk, source: TxSource): Promise<number> {
    this.walks.delete(key);
    return this.handleWindow(key, source, walk.pending, walk.newest);
  }

  /** Handles `sigs` (newest first) oldest first, advancing the cursor after each, then to `newest`. */
  private async handleWindow(key: string, source: TxSource, sigs: { signature: string; slot: number }[], newest: { signature: string; slot: number }): Promise<number> {
    let handled = 0;
    for (let i = sigs.length - 1; i >= 0; i--) {
      if (this.stopped) return handled;
      const s = sigs[i]!;
      await this.handleSignature(s.signature, source);
      this.state.setCursor(key, s.signature, s.slot);
      handled++;
    }
    // Failed transactions in the window need no handling: the cursor can pass them.
    this.state.setCursor(key, newest.signature, newest.slot);
    return handled;
  }

  /**
   * A cursor signature the node does not know (-32020: history pruned, or another ledger) makes every
   * `getSignaturesForAddress(until)` fail; it is dropped so the address is primed again. True when that happened.
   */
  private dropUnknownCursor(key: string, err: unknown): boolean {
    if (!(err instanceof RpcError) || err.code !== -32020) return false;
    this.state.deleteCursor(key);
    this.walks.delete(key);
    log("cursor_reset", { key, reason: err.message });
    return true;
  }

  // ------------------------------------------------------------------ token accounts

  /** Re-reads the tracked token accounts and feeds changes into the token-account path. */
  private async refreshTracked(source: TxSource): Promise<void> {
    await this.refreshSome(this.tracked, source);
  }

  private async refreshSome(accounts: TrackedAccount[], source: TxSource): Promise<void> {
    const confirms: Promise<void>[] = [];
    for (let i = 0; i < accounts.length; i += 100) {
      const chunk = accounts.slice(i, i + 100);
      try {
        const infos = await this.connection.getMultipleAccountsInfo(
          chunk.map((a) => new PublicKey(a.tokenAccount)),
          this.cfg.commitment,
        );
        // A closed account (target sold out and closed it) reads as a zero balance.
        infos.forEach((info, j) => {
          const c = this.onTokenAccount(chunk[j]!.target, chunk[j]!.tokenAccount, info?.data ?? null, source);
          if (c) confirms.push(c);
        });
      } catch (err) {
        log("tracked_refresh_failed", { error: errMsg(err) });
      }
    }
    await Promise.all(confirms);
  }

  private onLamports(target: string, lamports: number): void {
    const s = this.subs.get(target);
    if (!s) return;
    const changed = s.lastLamports !== null && s.lastLamports !== lamports;
    s.lastLamports = lamports;
    if (!changed) return;
    clearTimeout(s.debounce ?? undefined);
    s.debounce = setTimeout(() => {
      s.debounce = null;
      void this.refreshSome(this.tracked.filter((a) => a.target === target), "ws");
      if (this.stream && (this.stream.refused(s.token) || this.stream.refused(s.token2022))) void this.drainWallet(target, "ws");
    }, LAMPORTS_DEBOUNCE_MS);
  }

  /**
   * A token account of `target` changed (or was read): on a balance move, confirm through its own signatures.
   * Returns the confirmation in progress, if one was started.
   */
  private onTokenAccount(target: string, address: string, data: Buffer | null, source: TxSource): Promise<void> | null {
    const amount = data && data.length >= 72 ? tokenAccountAmount(data) : 0n;
    const prev = this.amounts.get(address);
    this.amounts.set(address, amount);
    if (prev === amount) return null;
    // First read of a polled account only establishes the baseline; a ws notification always means a change.
    if (prev === undefined && source !== "ws") return null;
    return this.confirmTokenAccount(target, address, source);
  }

  private async confirmTokenAccount(target: string, address: string, source: TxSource): Promise<void> {
    const key = `ata:${address}`;
    for (const wait of ATA_SIG_RETRIES_MS) {
      if (wait) await sleep(wait);
      if (this.stopped) return;
      try {
        const handled = await this.requestDrain(target, key, () => this.drain(key, address, source, "horizon"));
        if (handled > 0 || this.walks.has(key)) return;
      } catch (err) {
        if (!this.dropUnknownCursor(key, err)) log("token_account_confirm_failed", { address, error: errMsg(err) });
      }
    }
  }

  // ------------------------------------------------------------------ fetch + handle

  private async acquire(): Promise<void> {
    if (this.active < this.cfg.fetchConcurrency) {
      this.active++;
      return;
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    this.waiting.push(resolve);
    await promise;
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.active--;
  }

  /** Runs `fn` once per signature at a time: a second caller waits for the first instead of skipping. */
  private handleOnce(signature: string, fn: () => Promise<void>): Promise<void> {
    const running = this.inFlight.get(signature);
    if (running) return running;
    const p = fn().finally(() => this.inFlight.delete(signature));
    this.inFlight.set(signature, p);
    return p;
  }

  /**
   * Fetches, hands to the keeper, marks seen. Resolves once handled (or given up after `MAX_ATTEMPTS` misses);
   * throws on a transient failure so the drain stops before the cursor passes this signature.
   */
  private handleSignature(signature: string, source: TxSource): Promise<void> {
    if (this.stopped || this.state.hasSeen(signature)) return Promise.resolve();
    return this.handleOnce(signature, async () => {
      if (this.state.hasSeen(signature)) return;
      try {
        await this.acquire();
        let tx: RawTx;
        try {
          tx = await this.fetchTransaction(signature);
        } finally {
          this.release();
        }
        this.fetched += 1;
        await this.onTx(tx, source, Date.now());
        this.state.markSeen(signature);
        this.failures.delete(signature);
        this.bySource[source] += 1;
      } catch (err) {
        if (err instanceof TransientFetchError) throw err;
        const count = (this.failures.get(signature) ?? 0) + 1;
        this.failures.set(signature, count);
        if (count < MAX_ATTEMPTS) throw err;
        this.state.markSeen(signature);
        this.failures.delete(signature);
        this.failed += 1;
        log("signature_given_up", { signature, attempts: count, error: errMsg(err) });
      }
    });
  }

  /**
   * A signature often arrives a few tens of ms before the node serves its transaction: poll tightly first. Throws
   * `TransientFetchError` when every attempt failed with an RPC error (says nothing about the transaction).
   */
  private async fetchTransaction(signature: string): Promise<RawTx> {
    let lastErr: unknown = null;
    let answered = false;
    for (const wait of FETCH_WAITS_MS) {
      if (wait) await sleep(wait);
      try {
        const tx = await this.rpc.getTransaction(signature, this.cfg.commitment);
        answered = true;
        if (tx) return tx;
      } catch (err) {
        lastErr = err;
      }
    }
    if (!answered) throw new TransientFetchError(`getTransaction ${signature}: ${errMsg(lastErr)}`);
    throw new Error("transaction not available");
  }
}
