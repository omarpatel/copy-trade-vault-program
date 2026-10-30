import {
  burnPoolPda,
  configPda,
  decodeConfig,
  decodeCopier,
  decodePendingChange,
  decodePosition,
  COPIER_ACCOUNT_DISC,
  COPIER_PROGRAM_ID,
  copierPda,
  NO_CHANGE_ID,
  parseCopierEvents,
  positionPda,
  vaultPda,
  type CopierAccount,
  type CopierEvent,
  type PendingChangeAccount,
  type PositionAccount,
} from "@copy-trade-vault/sdk";
import type { AdminChangePayload, Health, ProgramState, WsMessage } from "@copy-trade-vault/sdk/api";
import { PublicKey, type AccountInfo, type ConfirmedSignatureInfo, type Connection } from "@solana/web3.js";
import type { FastifyBaseLogger } from "fastify";
import type { Alert } from "./alert";
import { splitDistribution } from "./aggregate";
import { applyEvent, Effects, keyOrNull, paramsSnapshot } from "./apply";
import { copierMemoTarget, parseDistributeEvents } from "./chain-logs";
import type { CopierRow, CopierState, Store, TargetTradeRow, TradeRow } from "./db";
import type { Hub } from "./hub";
import { LogsStream } from "./logs-stream";
import type { Market } from "./market";
import {
  decodeMetaplexMetadata,
  decodeMint,
  loadMetadata,
  metaplexMetadataPda,
  TOKEN_PROGRAM,
  UnfetchableUriError,
} from "./metadata";
import { getRawTx, lamportDelta, walletDeltas, type RawTx } from "./rpc";
import { checkFeeRouting, routingKeys, type RawAccount, type RegisteredRouting } from "./fee-routing";
import { BURN_POOL_KEY, CONFIG_KEY, type ProgramConfig, type Views } from "./views";

export interface SyncOptions {
  rpcUrl: string;
  wsUrl: string;
  pollMs: number;
  refreshMs: number;
  feesPollMs: number;
  snapshotMs: number;
  chainCheckMs: number;
  /** Localhost validator: a cursor unknown to the node means a rewound/reset chain and the index is rebuilt. */
  localnet: boolean;
  publicUrl: string;
  filesDir: string;
  /** Operator alert sink (fee-routing flips, cursor unknown to the RPC node). */
  alert: Alert;
}

/**
 * What to do when the stored cursor's signature is unknown to the node. Below the node's first available block it was
 * pruned (rescan retained history). Inside retained history: a rewound/reset localnet ledger is rebuilt from scratch,
 * while on a real cluster nothing is ever wiped on this signal (rescan, deduped by signature, and alert).
 */
export function cursorMissAction(cursorSlot: number, firstAvailable: number, localnet: boolean): "rescan" | "reset" | "rescan-alert" {
  if (cursorSlot < firstAvailable) return "rescan";
  return localnet ? "reset" : "rescan-alert";
}

const SIG_PAGE = 1_000;
const HEALTH_RPC_TIMEOUT_MS = 3_000;
const META_TICK_MS = 5_000;
/** Metadata fetch retries: 5s·2^n backoff capped at 5 min, 200 attempts (fresh IPFS pins can take minutes). */
const META_MAX_ATTEMPTS = 200;
const META_BACKOFF_CAP_MS = 5 * 60_000;
const BATCH = 100;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const b58 = (k: PublicKey) => k.toBase58();

/** The meaningful payload field of a PendingChange account (per its kind). */
export function pendingPayload(p: PendingChangeAccount): AdminChangePayload {
  switch (p.kind) {
    case "keeper":
      return { kind: "keeper", keeper: b58(p.keeper) };
    case "params":
      return { kind: "params", params: paramsSnapshot(p.params) };
    case "descriptors":
      return { kind: "descriptors", descriptors: p.descriptors.length };
    case "indexTargets":
      return { kind: "indexTargets", copier: b58(p.copier), targets: p.targets.map(b58) };
  }
}

/** Decoded `Copier` account → the row's state columns. */
export function copierStateOf(m: CopierAccount): CopierState {
  return {
    kind: m.kind,
    launcher: b58(m.launcher),
    targets: JSON.stringify(m.targets.map(b58)),
    trader_bps: m.traderBps,
    verified: m.verified,
    created_at: Number(m.createdAt),
    sharing_config: b58(m.sharingConfig),
    accounted: m.accountedLamports.toString(),
    fees_in: m.feesIn.toString(),
    capital_in: m.capitalIn.toString(),
    open_cost: m.openCost.toString(),
    open_positions: m.openPositions,
    realized_pnl: m.realizedPnl.toString(),
    hwm: m.hwm.toString(),
    buyback_pool: m.buybackPool.toString(),
    platform_sent: m.platformSent.toString(),
    burned: m.burned.toString(),
    buyback_spent: m.buybackSpent.toString(),
    platform_pending: m.platformPending.toString(),
    window_start: Number(m.windowStart),
    window_spent: m.windowSpent.toString(),
    window_equity: m.windowEquity.toString(),
    trades: Number(m.trades),
    last_keeper_ts: Number(m.lastKeeperTs),
    graduated_pool: m.graduatedPool.equals(PublicKey.default) ? null : b58(m.graduatedPool),
  };
}

/**
 * Chain → SQLite sync:
 * - program signature backfill/poller (`getSignaturesForAddress` down to the persisted cursor, oldest→newest),
 * - live `logsSubscribe` over a reconnecting websocket (program + every copier's fee-sharing config),
 * - chain identity checks (genesis hash, program id, cursor still on chain) that wipe and re-index after a reset,
 * - account refreshes (copier, positions, config, burn pool) after every touching event plus a periodic full refresh,
 * - pump `distribute_creator_fees_v2` scans per sharing config (exact vault / target fee shares),
 * - the 15s market sampler and coin/token metadata.
 * All chain processing runs on one serial queue, so rows are written in chain order and replays are harmless.
 */
export class ChainSync {
  private queue: Promise<void> = Promise.resolve();
  private pollQueued = false;
  private feesQueued = false;
  private timers: NodeJS.Timeout[] = [];
  private readonly stream: LogsStream;
  private stopped = false;
  private verified = false;
  private verifiedAt = 0;
  private genesisHash: string | null;
  private backfilled = false;
  private announceReset = false;
  private outage: { since: number; error: string } | null = null;
  private readonly metaInflight = new Set<string>();
  /** Rent-exempt minimum of a zero-data account (burn pool), read once. */
  private zeroDataRent: number | null = null;
  /** Copier program account + Config PDA presence, re-read on every full refresh (null until the first one). */
  private program: ProgramState | null = null;
  private readonly programId = COPIER_PROGRAM_ID.toBase58();

  constructor(
    private readonly store: Store,
    private readonly connection: Connection,
    private readonly hub: Hub,
    private readonly views: Views,
    private readonly market: Market,
    private readonly log: FastifyBaseLogger,
    private readonly opts: SyncOptions,
  ) {
    this.genesisHash = store.getState("genesis");
    this.stream = new LogsStream(
      opts.wsUrl,
      {
        onLogs: (address, n) => {
          void this.enqueue(async () => {
            // Unverified: the DB may still belong to a previous chain; the pollers pick these up after the check.
            if (!this.verified) return;
            if (address === this.programId) {
              if (this.store.hasTx(n.signature)) return;
              if (n.err) this.store.markTx(n.signature, n.slot, null, true, 0);
              else await this.processTx(n.signature, n.slot, n.logs, null);
              return;
            }
            if (n.err) return;
            this.pollFees();
            // Any successful tx touching a sharing config (distribution, or a pump.fun admin CTO rewrite): re-verify it.
            const copier = this.store.copiers().find((m) => m.sharing_config === address);
            if (copier) await this.verifyFeeRouting([copier.mint]).catch((err: unknown) => this.log.warn({ error: errorText(err) }, "fee routing check failed"));
          });
        },
        onSubscribed: (address) => {
          // A program (re)subscription usually follows a validator restart: re-verify the chain and fill the gap now.
          if (address !== this.programId) return;
          this.verified = false;
          this.poll();
        },
      },
      log,
    );
    this.stream.watch(this.programId);
  }

  get lastIndexedSlot(): number {
    return Number(this.store.getState("last_slot") ?? 0);
  }

  start(): void {
    this.log.info({ ...this.store.counts(), cursor: this.store.getState("cursor"), lastIndexedSlot: this.lastIndexedSlot }, "resuming sync");
    for (const m of this.store.copiers()) this.stream.watch(m.sharing_config);
    this.stream.start();
    this.poll();
    this.timers.push(
      setInterval(() => this.poll(), this.opts.pollMs),
      setInterval(() => this.pollFees(), this.opts.feesPollMs),
      setInterval(() => void this.enqueue(() => this.refreshAll()), this.opts.refreshMs),
      setInterval(() => void this.sampleMarket(), this.opts.snapshotMs),
      setInterval(() => void this.metadataTick(), META_TICK_MS),
    );
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.stream.close();
    await this.queue;
  }

  async health(): Promise<Health> {
    const lastIndexedSlot = this.lastIndexedSlot;
    const base = {
      lastIndexedSlot,
      wsConnected: this.stream.isSubscribed(this.programId),
      genesisHash: this.genesisHash,
      program: { id: this.programId, deployed: this.program?.deployed ?? null, configInitialized: this.program?.configInitialized ?? null },
    };
    const { promise: timeout, reject } = Promise.withResolvers<never>();
    const timer = setTimeout(() => reject(new Error(`no answer within ${HEALTH_RPC_TIMEOUT_MS}ms`)), HEALTH_RPC_TIMEOUT_MS);
    try {
      const slot = await Promise.race([this.connection.getSlot("confirmed"), timeout]);
      const ok = this.verified && this.backfilled;
      const error = ok ? undefined : this.outage ? `sync failing: ${this.outage.error}` : "initial sync in progress";
      return { ok, slot, lagSlots: Math.max(0, slot - lastIndexedSlot), ...base, ...(error ? { error } : {}) };
    } catch (err) {
      return { ok: false, slot: null, lagSlots: null, ...base, error: `rpc unreachable: ${errorText(err)}` };
    } finally {
      clearTimeout(timer);
    }
  }

  private broadcast(msg: WsMessage): void {
    this.hub.broadcast(msg);
  }

  /** Serializes chain processing; a failing job is logged and never blocks later jobs. */
  private enqueue(job: () => Promise<void>): Promise<void> {
    const run = this.queue.then(async () => {
      if (this.stopped) return;
      try {
        await job();
      } catch (err) {
        this.log.error({ err }, "sync job failed");
      }
    });
    this.queue = run;
    return run;
  }

  private poll(): void {
    if (this.pollQueued) return;
    this.pollQueued = true;
    void this.enqueue(async () => {
      this.pollQueued = false;
      try {
        if (!this.verified || Date.now() - this.verifiedAt >= this.opts.chainCheckMs) await this.verifyChain();
        const through = await this.connection.getSlot("confirmed");
        if ((await this.syncSignatures()) && through > this.lastIndexedSlot) this.store.setState("last_slot", String(through));
        if (!this.backfilled && !this.stopped) {
          await this.fullRefresh();
          await this.syncFees();
          this.backfilled = true;
          this.views.invalidate();
          this.log.info({ ...this.store.counts(), lastIndexedSlot: this.lastIndexedSlot }, "backfill complete");
          void this.sampleMarket();
          if (this.announceReset) {
            this.announceReset = false;
            this.broadcast({ type: "reset", data: { genesisHash: this.genesisHash ?? "" } });
          }
        }
        this.recovered();
      } catch (err) {
        this.failed(err);
      }
    });
  }

  private pollFees(): void {
    if (this.feesQueued || !this.backfilled) return;
    this.feesQueued = true;
    void this.enqueue(async () => {
      this.feesQueued = false;
      if (!this.verified) return;
      try {
        await this.syncFees();
      } catch (err) {
        this.failed(err);
      }
    });
  }

  private async refreshAll(): Promise<void> {
    if (!this.verified || !this.backfilled) return;
    try {
      await this.fullRefresh();
    } catch (err) {
      this.failed(err);
    }
  }

  private failed(err: unknown): void {
    this.verified = false;
    const error = errorText(err);
    if (!this.outage) {
      this.outage = { since: Date.now(), error };
      this.log.warn({ error }, "sync failing; retrying every poll");
    } else if (this.outage.error !== error) {
      this.outage.error = error;
      this.log.debug({ error }, "sync still failing");
    }
  }

  private recovered(): void {
    if (!this.outage) return;
    this.log.info({ downMs: Date.now() - this.outage.since, lastIndexedSlot: this.lastIndexedSlot }, "sync recovered");
    this.outage = null;
  }

  // ---------------- chain identity ----------------

  /**
   * Wipes and re-indexes when the DB belongs to another chain: genesis hash or program id changed
   * (e.g. `solana-test-validator --reset`), or the stored cursor is unknown to the node although it is
   * inside the node's retained history.
   */
  private async verifyChain(): Promise<void> {
    const genesis = await this.connection.getGenesisHash();
    const prevGenesis = this.store.getState("genesis");
    const prevProgram = this.store.getState("program_id");
    if (prevGenesis && prevGenesis !== genesis) this.reset("genesis hash changed", { prevGenesis, genesis });
    else if (prevProgram && prevProgram !== this.programId) this.reset("program id changed", { prevProgram, programId: this.programId });
    else await this.reconcileCursor();
    this.store.setState("genesis", genesis);
    this.store.setState("program_id", this.programId);
    this.genesisHash = genesis;
    this.verified = true;
    this.verifiedAt = Date.now();
  }

  /**
   * The cursor must still exist on chain. Below the node's first available block it was merely pruned (short
   * localnet ledgers): drop it and rescan the retained history (deduped by signature). Inside retained history but
   * unknown: on localnet that is a different chain or a rewound ledger, so the index is rebuilt. On a real cluster a
   * single miss is far more likely an RPC node without that signature than a lost fork, and a wipe would destroy
   * keeper reports (skip reasons) that exist nowhere on chain: rescan without deleting anything and alert instead.
   */
  private async reconcileCursor(): Promise<void> {
    const cursor = this.store.getState("cursor");
    if (!cursor) return;
    const { value } = await this.connection.getSignatureStatuses([cursor], { searchTransactionHistory: true });
    if (value[0]) return;
    const cursorSlot = this.store.txSlot(cursor) ?? 0;
    const firstAvailable = await this.connection.getFirstAvailableBlock();
    const action = cursorMissAction(cursorSlot, firstAvailable, this.opts.localnet);
    if (action === "reset") {
      this.reset("cursor signature not found on chain", { cursor, cursorSlot, firstAvailable });
      return;
    }
    if (action === "rescan") {
      this.log.info({ cursorSlot, firstAvailable }, "cursor pruned from node history; rescanning retained history");
    } else {
      this.log.warn({ cursor, cursorSlot, firstAvailable }, "cursor signature unknown to the RPC node; rescanning without wiping");
      this.opts.alert(
        `copy-vault indexer: the RPC node does not know the last indexed transaction (slot ${cursorSlot}). Rescanning program history ` +
          `without deleting anything. If this repeats, check the RPC provider.`,
      );
    }
    this.store.deleteState("cursor");
  }

  private reset(reason: string, details: Record<string, unknown>): void {
    this.log.warn({ reason, ...details, dropped: this.store.counts() }, "chain reset detected; wiping index and re-indexing");
    for (const m of this.store.copiers()) this.stream.unwatch(m.sharing_config);
    this.store.wipe();
    this.views.invalidate();
    this.backfilled = false;
    this.announceReset = true;
  }

  // ---------------- program signatures ----------------

  private async signaturesFor(address: PublicKey, until: string | undefined): Promise<ConfirmedSignatureInfo[]> {
    const found: ConfirmedSignatureInfo[] = [];
    let before: string | undefined;
    for (;;) {
      const page = await this.connection.getSignaturesForAddress(address, { before, until, limit: SIG_PAGE }, "confirmed");
      found.push(...page);
      if (page.length < SIG_PAGE) return found;
      before = page[page.length - 1]!.signature;
    }
  }

  /** Indexes every program signature newer than the cursor; false if it stopped early (retry next poll). */
  private async syncSignatures(): Promise<boolean> {
    const cursor = this.store.getState("cursor") ?? undefined;
    let found: ConfirmedSignatureInfo[];
    try {
      found = await this.signaturesFor(COPIER_PROGRAM_ID, cursor);
    } catch (err) {
      // The node rejects an `until` it no longer knows (pruned or different chain).
      if (!cursor || !errorText(err).includes(cursor)) throw err;
      await this.reconcileCursor();
      found = await this.signaturesFor(COPIER_PROGRAM_ID, this.store.getState("cursor") ?? undefined);
    }
    let fetched = 0;
    for (const info of found.reverse()) {
      if (this.stopped) return false;
      if (!this.store.hasTx(info.signature)) {
        if (info.err) {
          this.store.markTx(info.signature, info.slot, info.blockTime ?? null, true, 0);
        } else {
          const tx = await getRawTx(this.opts.rpcUrl, info.signature);
          // Not visible yet: keep the cursor here and retry on the next poll.
          if (!tx) return false;
          fetched++;
          if (tx.err) this.store.markTx(info.signature, tx.slot, tx.blockTime, true, 0);
          else await this.processTx(info.signature, tx.slot, tx.logs, tx.blockTime);
        }
      }
      this.store.setState("cursor", info.signature);
    }
    if (fetched >= 20) this.log.info({ fetched, scanned: found.length }, "signature sync caught up");
    else if (fetched > 0) this.log.debug({ fetched, scanned: found.length }, "signature sync caught up");
    return true;
  }

  // ---------------- transaction processing ----------------

  private async processTx(signature: string, slot: number, logs: string[], blockTime: number | null): Promise<void> {
    if (this.store.hasTx(signature)) return;
    let events: CopierEvent[];
    try {
      events = parseCopierEvents(logs);
    } catch (err) {
      this.log.warn({ err, signature }, "failed to parse program logs");
      events = [];
    }
    // Live notifications carry no block time; the copy lag needs it.
    const time = blockTime ?? (await this.connection.getBlockTime(slot).catch(() => null));
    const ctx = { signature, slot, memoTarget: copierMemoTarget(logs) };
    const fx = new Effects();
    this.store.tx(() => {
      events.forEach((ev, i) => applyEvent(this.store, ctx, i, ev, fx));
      this.store.markTx(signature, slot, time, false, events.length);
      if (slot > this.lastIndexedSlot) this.store.setState("last_slot", String(slot));
    });
    this.views.invalidate();
    if (events.length === 0) return;
    await this.afterTx(signature, fx);
  }

  /**
   * Account refreshes, memo recovery, marks and WS pushes for one indexed transaction. The tx is already booked: a
   * failing step is logged and healed by the periodic full refresh, never blocking the others.
   */
  private async afterTx(signature: string, fx: Effects): Promise<void> {
    const attempt = async (step: string, fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (err) {
        this.log.warn({ signature, step, error: errorText(err) }, "post-tx refresh failed; the full refresh retries it");
      }
    };
    for (const mint of fx.newCopiers) {
      const row = this.store.copier(mint);
      if (row) this.stream.watch(row.sharing_config);
      await attempt("coin metadata", () => this.loadCoinMeta(mint));
    }
    if (fx.targetsChanged) for (const m of this.store.copiers()) this.stream.watch(m.sharing_config);
    if (fx.config) await attempt("config", () => this.refreshConfig());
    // A proposed change's payload lives in its PendingChange account (closed again on execute / cancel).
    if (fx.changes.length > 0) await attempt("pending changes", () => this.refreshPendingChanges());
    await attempt("copiers", () => this.refreshCopiers([...fx.copiers]));
    for (const [copier, mints] of fx.positions) await attempt("positions", () => this.refreshPositions(copier, [...mints]));
    const memoTrades = fx.trades.flatMap((i) => this.store.trade(signature, i) ?? []);
    for (const t of memoTrades) {
      if (t.target_sig && !this.store.hasTargetTrade(t.copier, t.target_sig, t.token_mint)) await attempt("target trade", () => this.recoverTargetTrade(t));
    }
    if (fx.copiers.size > 0) await attempt("marks", async () => void (await this.market.tick([...fx.copiers])));
    if (fx.copiers.size > 0) await attempt("fee routing", () => this.verifyFeeRouting([...fx.copiers]));
    this.views.invalidate();

    for (const t of memoTrades) {
      this.broadcast({ type: "trade", data: this.views.vaultTrade(t) });
      const copy = t.target_sig ? this.views.copy(t.copier, t.target_sig, t.token_mint) : null;
      if (copy) this.broadcast({ type: "copy", data: copy });
    }
    for (const i of fx.burns) {
      const b = this.store.burns({ limit: 50 }).find((r) => r.signature === signature && r.event_index === i);
      if (b) this.broadcast({ type: "burn", data: this.views.burnView(b) });
    }
    for (const i of fx.syncs) {
      const s = this.store.feeSyncs(null, 50).find((r) => r.signature === signature && r.event_index === i);
      if (s) this.broadcast({ type: "fees", data: this.views.syncEvent(s) });
    }
    for (const i of fx.deposits) {
      const d = this.store.deposits(null, 50).find((r) => r.signature === signature && r.event_index === i);
      if (d) this.broadcast({ type: "fees", data: this.views.depositEvent(d) });
    }
    for (const mint of fx.copiers) {
      const summary = this.views.summary(mint);
      if (!summary) continue;
      this.broadcast({ type: fx.newCopiers.includes(mint) ? "launch" : "copier", data: summary });
    }
    if (fx.changes.length > 0 || fx.pauses.length > 0) {
      this.alertGovernance(fx);
      this.broadcast({ type: "governance", data: this.views.governance() });
    }
    this.broadcast({ type: "stats", data: this.views.stats() });
  }

  // ---------------- accounts ----------------

  /** Re-reads `Copier` accounts (discovering rows whose `CopierRegistered` is outside the retained history). */
  private async refreshCopiers(mints: string[]): Promise<void> {
    for (let i = 0; i < mints.length; i += BATCH) {
      const chunk = mints.slice(i, i + BATCH);
      const res = await this.connection.getMultipleAccountsInfoAndContext(
        chunk.map((m) => copierPda(new PublicKey(m))),
        "confirmed",
      );
      chunk.forEach((mint, j) => {
        const info = res.value[j];
        if (info) this.applyCopierAccount(mint, decodeCopier(info.data), res.context.slot);
      });
    }
  }

  private applyCopierAccount(mint: string, account: CopierAccount, slot: number): void {
    const state = copierStateOf(account);
    if (!this.store.copier(mint)) {
      this.store.insertCopier({
        mint,
        kind: state.kind,
        launcher: state.launcher,
        vault: vaultPda(new PublicKey(mint)).toBase58(),
        targets: state.targets,
        trader_bps: state.trader_bps,
        created_at: state.created_at,
        sharing_config: state.sharing_config,
        registered_sig: null,
      });
      this.stream.watch(state.sharing_config);
      this.log.info({ mint }, "discovered copier from account");
      void this.enqueue(() => this.loadCoinMeta(mint));
    }
    this.store.setCopierState(mint, slot, state);
  }

  private async refreshPositions(copier: string, tokenMints: string[]): Promise<void> {
    const keys = tokenMints.map((t) => positionPda(new PublicKey(copier), new PublicKey(t)));
    const res = await this.connection.getMultipleAccountsInfoAndContext(keys, "confirmed");
    this.store.tx(() => {
      tokenMints.forEach((tokenMint, i) => {
        const info = res.value[i];
        if (info) this.applyPosition(decodePosition(info.data), res.context.slot);
        else this.store.deletePosition(copier, tokenMint, res.context.slot);
      });
    });
  }

  private applyPosition(p: PositionAccount, slot: number): void {
    this.store.upsertPosition({
      copier: b58(p.mint),
      token_mint: b58(p.tokenMint),
      target: b58(p.target),
      tokens: p.tokens.toString(),
      cost: p.cost.toString(),
      target_snapshot: p.targetSnapshot.toString(),
      target_peak: p.targetPeak.toString(),
      vault_peak: p.vaultPeak.toString(),
      opened_at: Number(p.openedAt),
      last_trade_ts: Number(p.lastTradeTs),
      state_slot: slot,
    });
    this.store.ensureToken(b58(p.tokenMint));
  }

  private async refreshConfig(): Promise<void> {
    const [cfgInfo, burnPool, programInfo] = await this.connection.getMultipleAccountsInfo(
      [configPda(), burnPoolPda(), COPIER_PROGRAM_ID],
      "confirmed",
    );
    this.setProgramState({ deployed: programInfo?.executable === true, configInitialized: cfgInfo !== null });
    if (cfgInfo) {
      const c = decodeConfig(cfgInfo.data);
      const cfg: ProgramConfig = {
        admin: b58(c.admin),
        keeper: keyOrNull(b58(c.keeper)),
        platformMint: keyOrNull(b58(c.platformMint)),
        params: paramsSnapshot(c.params),
        platformBurned: c.platformBurned.toString(),
        platformBurnSpent: c.platformBurnSpent.toString(),
        timelockSecs: Number(c.timelockSecs),
        pendingAdmin: keyOrNull(b58(c.pendingAdmin)),
        pendingAdminEta: keyOrNull(b58(c.pendingAdmin)) === null ? null : Number(c.pendingAdminEta),
        keeperHeartbeatTs: Number(c.keeperHeartbeatTs),
        latestChangeIds: c.latestChangeIds.map((id) => (id === NO_CHANGE_ID ? null : Number(id))),
      };
      this.store.setState(CONFIG_KEY, JSON.stringify(cfg));
    }
    // The pool is a zero-data system account: only lamports above its rent are waiting to buy + burn the platform token.
    this.zeroDataRent ??= await this.connection.getMinimumBalanceForRentExemption(0);
    this.store.setState(BURN_POOL_KEY, String(Math.max(0, (burnPool?.lamports ?? 0) - this.zeroDataRent)));
  }

  /** Pre-launch (program not deployed / config not initialized) is a normal state; transitions are logged once. */
  private setProgramState(next: ProgramState): void {
    const prev = this.program;
    this.program = next;
    if (prev?.deployed === next.deployed && prev.configInitialized === next.configInitialized) return;
    const state = !next.deployed ? "program not deployed" : !next.configInitialized ? "config not initialized" : "live";
    this.log.info({ programId: this.programId, ...next, refreshMs: this.opts.refreshMs }, `copier program: ${state}`);
  }

  /** Every Copier and Position account in two getProgramAccounts calls, the config, and memo recovery retries. */
  private async fullRefresh(): Promise<void> {
    const generation = this.store.generation;
    const [copiers, positions] = await Promise.all([
      this.connection.getProgramAccounts(COPIER_PROGRAM_ID, {
        commitment: "confirmed",
        withContext: true,
        filters: [{ memcmp: { offset: 0, bytes: Buffer.from(COPIER_ACCOUNT_DISC.copier).toString("base64"), encoding: "base64" } }],
      }),
      this.connection.getProgramAccounts(COPIER_PROGRAM_ID, {
        commitment: "confirmed",
        withContext: true,
        filters: [{ memcmp: { offset: 0, bytes: Buffer.from(COPIER_ACCOUNT_DISC.position).toString("base64"), encoding: "base64" } }],
      }),
    ]);
    if (generation !== this.store.generation) return;
    this.store.tx(() => {
      for (const { account } of copiers.value) {
        const m = decodeCopier(account.data);
        this.applyCopierAccount(b58(m.mint), m, copiers.context.slot);
      }
      const live = new Set<string>();
      for (const { account } of positions.value) {
        const p = decodePosition(account.data);
        live.add(`${b58(p.mint)}:${b58(p.tokenMint)}`);
        this.applyPosition(p, positions.context.slot);
      }
      for (const p of this.store.allPositions()) {
        if (!live.has(`${p.copier}:${p.token_mint}`)) this.store.deletePosition(p.copier, p.token_mint, positions.context.slot);
      }
    });
    await this.refreshConfig();
    await this.refreshPendingChanges();
    for (const t of this.store.tradesMissingTargets(20)) await this.recoverTargetTrade(t);
    await this.verifyFeeRouting(null).catch((err: unknown) => this.log.warn({ error: errorText(err) }, "fee routing check failed"));
    this.views.invalidate();
  }

  // ---------------- governance (timelocked admin changes, keeper pause) ----------------

  /** Every PendingChange account (getProgramAccounts by discriminator): payloads of the queued changes. */
  private async refreshPendingChanges(): Promise<void> {
    const generation = this.store.generation;
    const res = await this.connection.getProgramAccounts(COPIER_PROGRAM_ID, {
      commitment: "confirmed",
      filters: [{ memcmp: { offset: 0, bytes: Buffer.from(COPIER_ACCOUNT_DISC.pendingChange).toString("base64"), encoding: "base64" } }],
    });
    if (generation !== this.store.generation) return;
    this.store.tx(() => {
      for (const { account } of res) {
        const p = decodePendingChange(account.data);
        this.store.upsertPendingAccount({
          id: Number(p.id),
          kind: p.kind,
          proposer: b58(p.proposer),
          proposed_at: Number(p.proposedAt),
          eta: Number(p.eta),
          expires_at: Number(p.expiresAt),
          payload: JSON.stringify(pendingPayload(p)),
        });
      }
    });
    this.views.invalidate();
  }

  /** ALERT_WEBHOOK_URL on every proposed change (with its ETA and payload summary) and every keeper pause. */
  private alertGovernance(fx: Effects): void {
    for (const c of fx.changes) {
      if (c.event !== "proposed") continue;
      const change = this.views.adminChange(c.id);
      if (!change) continue;
      const what = change.summary.length > 0 ? `: ${change.summary.join("; ")}` : "";
      const window = `executable from ${new Date(change.eta * 1000).toISOString()}${change.expiresAt ? ` until ${new Date(change.expiresAt * 1000).toISOString()}` : ""}`;
      const msg = `copy-vault admin change #${change.id} proposed (${change.kind})${what}; ${window}.`;
      this.log.warn({ id: change.id, kind: change.kind, eta: change.eta, summary: change.summary }, "admin change proposed");
      this.opts.alert(msg);
    }
    for (const keeper of fx.pauses) {
      this.log.warn({ keeper }, "keeper paused by admin");
      this.opts.alert(`copy-vault keeper ${keeper} paused by the admin: no copies until a new keeper passes the timelock.`);
    }
  }

  // ---------------- fee routing (pump.fun admin CTO watch) ----------------

  /**
   * Re-runs `register_copier`'s fee-routing checks for `mints` (null: every copier) on one batched account read. A
   * flip to "changed" is logged at warn and pushed on `/ws`; a failed read keeps the previous verdict.
   */
  private async verifyFeeRouting(mints: string[] | null): Promise<void> {
    const rows = mints ? mints.flatMap((m) => this.store.copier(m) ?? []) : this.store.copiers();
    if (rows.length === 0) return;
    const generation = this.store.generation;
    const keys = rows.flatMap((r) => {
      const k = routingKeys(this.routingOf(r));
      return [k.sharingConfig, k.bondingCurve, k.pool];
    });
    const infos: (AccountInfo<Buffer> | null)[] = [];
    for (let i = 0; i < keys.length; i += 99) infos.push(...(await this.connection.getMultipleAccountsInfo(keys.slice(i, i + 99), "confirmed")));
    if (generation !== this.store.generation) return;
    const raw = (i: number): RawAccount | null => {
      const info = infos[i];
      return info ? { owner: info.owner.toBase58(), data: info.data } : null;
    };
    const now = Math.floor(Date.now() / 1000);
    const flipped: string[] = [];
    rows.forEach((r, i) => {
      const verdict = checkFeeRouting(this.routingOf(r), { sharingConfig: raw(i * 3), bondingCurve: raw(i * 3 + 1), pool: raw(i * 3 + 2) }, now);
      this.store.setFeeRouting(r.mint, verdict);
      if (verdict.status === r.fee_status && verdict.detail === r.fee_detail) return;
      flipped.push(r.mint);
      if (verdict.status === "changed") {
        this.log.warn({ mint: r.mint, sharingConfig: r.sharing_config, detail: verdict.detail, shareholders: verdict.shareholders }, "fee routing changed: pump.fun admin rewrote this copier's creator-fee split");
        const holders = verdict.shareholders.map((s) => `${s.address} ${s.bps / 100}%`).join(", ") || "none";
        this.opts.alert(
          `copy-vault fee routing CHANGED on ${r.symbol ? `$${r.symbol} ` : ""}${r.mint}: ${verdict.detail ?? "split differs from registration"}. ` +
            `Shareholders now: ${holders}. Sharing config ${r.sharing_config}. New creator fees no longer reach the vault as registered.`,
        );
      } else if (r.fee_status === "changed") {
        this.log.info({ mint: r.mint }, "fee routing back to the registered split");
        this.opts.alert(`copy-vault fee routing restored on ${r.symbol ? `$${r.symbol} ` : ""}${r.mint}: back to the registered split.`);
      }
    });
    if (flipped.length === 0) return;
    this.views.invalidate();
    for (const mint of flipped) {
      const s = this.views.summary(mint);
      if (s) this.broadcast({ type: "copier", data: s });
    }
  }

  private routingOf(r: CopierRow): RegisteredRouting {
    return { mint: r.mint, kind: r.kind, targets: JSON.parse(r.targets) as string[], traderBps: r.trader_bps, vault: r.vault, sharingConfig: r.sharing_config };
  }

  // ---------------- target trades from vault memos ----------------

  /**
   * Rebuilds the target trade a vault tx answers from the target tx itself (keeper report lost or not sent): the
   * target's token and SOL deltas, block time and slot. Keeper reports arriving later overwrite it.
   */
  private async recoverTargetTrade(t: TradeRow): Promise<void> {
    if (!t.target_sig) return;
    let tx: RawTx | null;
    try {
      tx = await getRawTx(this.opts.rpcUrl, t.target_sig);
    } catch (err) {
      this.log.debug({ sig: t.target_sig, error: errorText(err) }, "target tx fetch failed");
      return;
    }
    if (!tx) return;
    const d = walletDeltas(tx, t.target, t.token_mint);
    const tokenDelta = d?.tokenDelta ?? 0n;
    const solDelta = d?.solDelta ?? 0n;
    const absTok = tokenDelta < 0n ? -tokenDelta : tokenDelta;
    const absSol = solDelta < 0n ? -solDelta : solDelta;
    this.store.upsertTargetTrade({
      copier: t.copier,
      signature: t.target_sig,
      target: t.target,
      slot: tx.slot,
      block_time: tx.blockTime,
      side: t.side,
      token_mint: t.token_mint,
      token_delta: tokenDelta.toString(),
      sol_delta: solDelta.toString(),
      target_sol_before: (d?.solBefore ?? 0n).toString(),
      price: absTok > 0n ? Number(absSol) / Number(absTok) : null,
      venue: t.venue,
      status: "copied",
      reason: null,
      error: null,
      vault_sig: t.signature,
      vault_sol_in: t.side === "buy" ? t.sol : null,
      vault_tokens_in: t.side === "sell" ? t.tokens : null,
      detected_at: null,
      decided_at: null,
      source: "memo",
      received_at: Math.floor(Date.now() / 1000),
    });
  }

  /** Keeper reports (`POST /internal/target-trades`): stored, then pushed as copies. */
  ingestTargetTrades(rows: TargetTradeRow[]): void {
    this.store.tx(() => {
      for (const r of rows) {
        this.store.upsertTargetTrade(r);
        this.store.ensureToken(r.token_mint);
      }
    });
    this.views.invalidate();
    for (const r of rows) {
      const copy = this.views.copy(r.copier, r.signature, r.token_mint);
      if (copy) this.broadcast({ type: "copy", data: copy });
    }
  }

  // ---------------- creator fee distributions ----------------

  /**
   * Scans each copier's sharing config for pump `distribute_creator_fees_v2` txs since its cursor and books the
   * exact vault / target shares (`splitDistribution`: observed balance deltas, pro-rata fallback).
   */
  private async syncFees(): Promise<void> {
    for (const m of this.store.copiers()) {
      if (this.stopped) return;
      await this.syncCopierFees(m);
    }
  }

  private async syncCopierFees(m: CopierRow): Promise<void> {
    const key = `fees_cursor:${m.mint}`;
    const cursor = this.store.getState(key) ?? undefined;
    let found: ConfirmedSignatureInfo[];
    try {
      found = await this.signaturesFor(new PublicKey(m.sharing_config), cursor);
    } catch (err) {
      if (!cursor || !errorText(err).includes(cursor)) throw err;
      this.store.deleteState(key);
      found = await this.signaturesFor(new PublicKey(m.sharing_config), undefined);
    }
    const targets = JSON.parse(m.targets) as string[];
    for (const info of found.reverse()) {
      if (!info.err) {
        const tx = await getRawTx(this.opts.rpcUrl, info.signature);
        if (!tx) return;
        if (!tx.err) this.bookDistributions(m, targets, info.signature, tx);
      }
      this.store.setState(key, info.signature);
    }
  }

  private bookDistributions(m: CopierRow, targets: string[], signature: string, tx: RawTx): void {
    const events = parseDistributeEvents(tx.logs).filter((e) => e.sharingConfig === m.sharing_config);
    events.forEach((ev, i) => {
      // One distribute per tx in practice; several would share the tx balance deltas, so only a single one may use them.
      const split = splitDistribution(ev, (a) => (events.length === 1 ? lamportDelta(tx, a) : null), m.vault, targets);
      if (split.distributed === 0n) return;
      const sig = i === 0 ? signature : `${signature}:${i}`;
      const inserted = this.store.insertDistribution(
        {
          signature: sig,
          copier: m.mint,
          slot: tx.slot,
          ts: tx.blockTime ?? ev.timestamp,
          distributed: split.distributed.toString(),
          to_vault: split.toVault.toString(),
          to_targets: split.toTargets.toString(),
          shares: JSON.stringify(split.shares.map((s) => ({ ...s, lamports: s.lamports.toString() }))),
        },
        split.shares.filter((s) => s.role === "target").map((s) => ({ target: s.address, lamports: s.lamports.toString() })),
      );
      if (!inserted) return;
      this.views.invalidate();
      const row = this.store.distributions(m.mint, 5).find((d) => d.signature === sig);
      if (row) this.broadcast({ type: "fees", data: this.views.distributionEvent(row) });
    });
  }

  // ---------------- market + metadata ----------------

  private async sampleMarket(): Promise<void> {
    if (!this.backfilled) return;
    try {
      const changed = await this.market.tick();
      this.views.invalidate();
      for (const mint of changed) {
        const s = this.views.summary(mint);
        if (s) this.broadcast({ type: "copier", data: s });
      }
      this.broadcast({ type: "stats", data: this.views.stats() });
    } catch (err) {
      // During a known RPC outage every 15 s sample fails; the outage itself is logged once (start + recovery).
      if (this.outage) this.log.debug({ error: errorText(err) }, "market sample failed (RPC outage)");
      else this.log.warn({ error: errorText(err) }, "market sample failed");
    }
  }

  /** Reads the coin's name/symbol/uri from its Token-2022 metadata extension, then fetches the JSON (retried with backoff). */
  private async loadCoinMeta(mint: string): Promise<void> {
    const row = this.store.copier(mint);
    const key = `c:${mint}`;
    if (!row || row.uri || row.meta_status !== "pending" || this.metaInflight.has(key)) return;
    this.metaInflight.add(key);
    try {
      const info = await this.connection.getAccountInfo(new PublicKey(mint), "confirmed");
      if (!info) throw new Error("mint account not found");
      const decoded = decodeMint(info.owner.toBase58(), info.data);
      this.store.ensureToken(mint);
      this.store.setTokenMint(mint, decoded.program, decoded.decimals, decoded.meta);
      if (!decoded.meta) {
        this.store.setCopierMetaStatus(mint, "none", 0, 0);
        return;
      }
      this.store.setCopierUri(mint, decoded.meta.name, decoded.meta.symbol, decoded.meta.uri);
      this.views.invalidate();
    } catch (err) {
      const attempt = row.meta_attempts + 1;
      this.log.warn({ mint, attempt, error: errorText(err) }, "coin mint read failed");
      this.store.setCopierMetaStatus(mint, "pending", attempt, this.backoff(attempt));
      return;
    } finally {
      this.metaInflight.delete(key);
    }
    await this.fetchCopierMeta(mint);
  }

  private async metadataTick(): Promise<void> {
    if (!this.backfilled) return;
    const now = Date.now();
    for (const row of this.store.copiersMetaDue(now)) void (row.uri ? this.fetchCopierMeta(row.mint) : this.loadCoinMeta(row.mint));
    for (const t of this.store.tokensDue(now)) void this.fetchTokenMeta(t.mint);
  }

  private backoff(attempt: number): number {
    return Date.now() + Math.min(META_BACKOFF_CAP_MS, 5_000 * 2 ** attempt);
  }

  private async fetchCopierMeta(mint: string): Promise<void> {
    const key = `m:${mint}`;
    const row = this.store.copier(mint);
    if (!row || !row.uri || row.meta_status !== "pending" || this.metaInflight.has(key)) return;
    this.metaInflight.add(key);
    try {
      const meta = await loadMetadata(row.uri, this.opts.publicUrl, this.opts.filesDir);
      this.store.setCopierMeta(mint, meta);
      this.views.invalidate();
      const s = this.views.summary(mint);
      if (s) this.broadcast({ type: "copier", data: s });
    } catch (err) {
      const attempt = row.meta_attempts + 1;
      if (err instanceof UnfetchableUriError || attempt >= META_MAX_ATTEMPTS) {
        this.log.warn({ mint, uri: row.uri, reason: errorText(err) }, "coin metadata not fetchable; using on-chain name");
        this.store.setCopierMetaStatus(mint, "none", attempt, 0);
      } else {
        this.log.debug({ mint, uri: row.uri, attempt, err: errorText(err) }, "coin metadata fetch failed");
        this.store.setCopierMetaStatus(mint, "pending", attempt, this.backoff(attempt));
      }
    } finally {
      this.metaInflight.delete(key);
    }
  }

  /** Traded coins: mint account (decimals, Token-2022 metadata) or Metaplex metadata, then the JSON image. */
  private async fetchTokenMeta(mint: string): Promise<void> {
    const key = `t:${mint}`;
    if (this.metaInflight.has(key)) return;
    this.metaInflight.add(key);
    let token = this.store.token(mint);
    try {
      if (!token) return;
      if (token.program === null || (token.uri === null && token.program === TOKEN_PROGRAM)) {
        const pk = new PublicKey(mint);
        const [mintInfo, mplInfo] = await this.connection.getMultipleAccountsInfo([pk, metaplexMetadataPda(pk)], "confirmed");
        if (!mintInfo) {
          this.store.setTokenMetaStatus(mint, "pending", token.meta_attempts + 1, this.backoff(token.meta_attempts + 1));
          return;
        }
        const decoded = decodeMint(mintInfo.owner.toBase58(), mintInfo.data);
        const meta = decoded.meta ?? (mplInfo ? decodeMetaplexMetadata(mplInfo.data) : null);
        this.store.setTokenMint(mint, decoded.program, decoded.decimals, meta);
        token = this.store.token(mint)!;
      }
      if (!token.uri) {
        this.store.setTokenMetaStatus(mint, "none", token.meta_attempts, 0);
        return;
      }
      const meta = await loadMetadata(token.uri, this.opts.publicUrl, this.opts.filesDir);
      this.store.setTokenMeta(mint, meta.image, meta.name, meta.symbol);
    } catch (err) {
      const attempt = (token?.meta_attempts ?? 0) + 1;
      const final = err instanceof UnfetchableUriError || attempt >= META_MAX_ATTEMPTS;
      this.store.setTokenMetaStatus(mint, final ? "none" : "pending", attempt, final ? 0 : this.backoff(attempt));
    } finally {
      this.metaInflight.delete(key);
    }
  }
}
