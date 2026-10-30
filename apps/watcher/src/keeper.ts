import { PublicKey, type Connection, type Keypair, type TransactionInstruction } from "@solana/web3.js";
import {
  ata,
  buildCopierBuyIx,
  buildCopierSellIx,
  decodeCopier,
  decodePosition,
  decodeSharingConfig,
  fetchPumpState,
  copierEquity,
  copierPda,
  COPIER_PROGRAM_ID,
  parseCopierEvents,
  positionPda,
  resolveVenue,
  sharingConfigPda,
  tokenAccountAmount,
  tokenValueLamports,
  vaultPda,
  venueBuyQuote,
  venueSellQuote,
  withSlippage,
  wsolAta,
  type ConfigAccount,
  type CopierAccount,
  type PositionAccount,
  type PumpState,
  type ResolvedVenue,
} from "@copy-trade-vault/sdk";
import type { SkipReason, TargetTradeIngest } from "@copy-trade-vault/sdk/api";
import { classifyTx, involvedWallets, type ClassifiedTrade } from "./classifier";
import { loadConfig, loadKeypair, type KeeperConfig } from "./config";
import type { Detector, TxSource } from "./detector";
import { Executor, SendError, SimulationError } from "./executor";
import { errMsg, log } from "./log";
import { decideBuy, decideSell, type PolicyKnobs, type VenueView } from "./policy";
import { loadRegistry, trackedAccounts, type RegistrySnapshot } from "./registry";
import type { Reporter } from "./reporter";
import type { RawTx } from "./rpc";
import type { State } from "./state";

/**
 * The copy loop: classified target trades → per-copier decision (policy) → `copier_buy` / `copier_sell` (executor)
 * → decision recorded (SQLite) and reported to the indexer. Decisions for one copier run strictly one at a time
 * (the vault's equity, positions and the program's snapshots change with every trade); different copiers run in
 * parallel. Every decision re-reads the chain state it depends on, so a stale registry can never size a trade.
 */

const PUMP_STATE_TTL_MS = 60_000;
const AIRDROP_VENUE_TTL_MS = 60_000;

export type KeeperMode = "live" | "paused" | "dry-run" | "observe";

/** Program errors (by IDL name) that mean "a cap says no", reported as skips rather than failures. */
const PROGRAM_SKIPS: Record<string, SkipReason> = {
  SpendWindowExceeded: "spend_window",
  ExceedsImpact: "impact_cap",
};

export interface CopierStateRead {
  copier: CopierAccount;
  vaultLamports: bigint;
  vaultWsol: bigint;
  position: PositionAccount | null;
  freeSol: bigint;
  equity: bigint;
}

interface Counters {
  observed: number;
  copied: number;
  skipped: number;
  failed: number;
  airdropsIgnored: number;
}

export class Keeper {
  registry: RegistrySnapshot = { config: null, copiers: new Map(), followers: new Map() };
  keeper: Keypair | null = null;
  lastRefreshAt: number | null = null;
  lastRefreshError: string | null = null;
  /** Copier program account + Config presence, re-read every refresh (null before the first): pre-launch = observe. */
  program: { deployed: boolean; configInitialized: boolean } | null = null;
  readonly counters: Counters = { observed: 0, copied: 0, skipped: 0, failed: 0, airdropsIgnored: 0 };
  private readonly locks = new Map<string, Promise<unknown>>();
  private pumpState: { value: PumpState; at: number } | null = null;
  private rentExempt: bigint | null = null;
  private readonly tokenPrograms = new Map<string, PublicKey>();
  private readonly airdropVenues = new Map<string, { venue: ResolvedVenue; at: number }>();
  private detector: Detector | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private keeperWarned = false;
  /** Wall-clock ms of the last landed keeper-signed trade or burn (each refreshes the on-chain heartbeat). */
  lastKeeperIxAt = 0;
  private lastLoggedMode: KeeperMode | null = null;

  constructor(
    readonly cfg: KeeperConfig,
    readonly connection: Connection,
    readonly executor: Executor,
    private readonly state: State,
    private readonly reporter: Reporter,
  ) {}

  get knobs(): PolicyKnobs {
    return {
      maxSignalAgeSecs: this.cfg.maxSignalAgeSecs,
      convictionK: this.cfg.convictionK,
      convictionFloorBps: this.cfg.convictionFloorBps,
      deadQuoteLamports: this.cfg.deadQuoteLamports,
      reentryCooldownSecs: this.cfg.reentryCooldownSecs,
    };
  }

  /**
   * live: keeper key = config.keeper; paused: the admin ran `pause_keeper` (config.keeper unset); dry-run: DRY_RUN;
   * observe: no key yet, or not the configured keeper.
   */
  get mode(): KeeperMode {
    if (this.cfg.dryRun) return "dry-run";
    const config = this.registry.config;
    if (config?.keeper.equals(PublicKey.default)) return "paused";
    if (!this.keeper || !config || !config.keeper.equals(this.keeper.publicKey)) return "observe";
    return "live";
  }

  attach(detector: Detector): void {
    this.detector = detector;
  }

  async start(): Promise<void> {
    await this.refresh();
    this.refreshTimer = setInterval(() => void this.refresh(), this.cfg.copierRefreshMs);
  }

  stop(): void {
    clearInterval(this.refreshTimer ?? undefined);
  }

  /** Per-copier serialization: `fn` runs after every earlier task of `mint` settled. */
  withCopier<T>(mint: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(mint) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const settled = next.catch(() => undefined);
    this.locks.set(mint, settled);
    void settled.then(() => {
      if (this.locks.get(mint) === settled) this.locks.delete(mint);
    });
    return next;
  }

  /**
   * The RPC now serves another cluster (localnet wiped and re-seeded): drop every cluster-bound cache, let the
   * detector re-prime its targets, and reload the lookup table (localnet setup writes a new one).
   */
  private async onClusterChanged(genesis: string): Promise<void> {
    log("cluster_changed", { genesis, action: "cleared signatures, cursors, decisions, pending reports" });
    this.registry = { config: null, copiers: new Map(), followers: new Map() };
    this.pumpState = null;
    this.rentExempt = null;
    this.tokenPrograms.clear();
    this.airdropVenues.clear();
    this.detector?.resetCluster();
    let alt = this.cfg.alt;
    try {
      alt = loadConfig().alt;
    } catch (err) {
      log("config_reload_failed", { error: errMsg(err) });
    }
    await this.executor.loadTable(alt);
  }

  /** Re-reads the configured ALT (env / localnet config.json) and loads it; logs once when it becomes available. */
  private async retryLookupTable(): Promise<void> {
    let alt = this.cfg.alt;
    try {
      alt = loadConfig().alt;
    } catch {
      // keep the startup value; a broken config file was already reported at startup / cluster change
    }
    if (!alt) return;
    await this.executor.loadTable(alt);
    if (this.executor.lookupTable) log("lookup_table_loaded", { alt: this.executor.lookupTable });
  }

  /** Reloads Config, copiers, positions; re-targets the detector; re-reads the keeper key until it exists. */
  async refresh(): Promise<void> {
    if (!this.keeper) {
      const { key } = this.cfg;
      try {
        this.keeper = key.kind === "env" ? key.keypair : loadKeypair(key.path);
        if (this.keeper) log("keeper_key_loaded", { keeper: this.keeper.publicKey.toBase58(), source: key.kind === "env" ? "KEEPER_SECRET_KEY" : key.path });
        else if (!this.keeperWarned) {
          this.keeperWarned = true;
          log("keeper_key_missing", { path: key.kind === "file" ? key.path : null, mode: "observe (decisions recorded, nothing sent)" });
        }
      } catch (err) {
        log("keeper_key_invalid", { error: errMsg(err) });
      }
    }
    try {
      const genesis = await this.connection.getGenesisHash();
      if (this.state.bindCluster(genesis)) await this.onClusterChanged(genesis);
      // No table yet but one is configured (setup ran after the keeper started, or it wasn't on chain yet when the
      // cluster changed): retry, or every v0 send that needs it (copy sells) fails with "set COPIER_ALT".
      if (!this.executor.lookupTable) await this.retryLookupTable();
      const prevTargets = this.registry.followers.size;
      const prevCopiers = this.registry.copiers.size;
      const [snapshot, programInfo] = await Promise.all([
        loadRegistry(this.connection, this.cfg.commitment),
        this.connection.getAccountInfo(COPIER_PROGRAM_ID, this.cfg.commitment),
      ]);
      const program = { deployed: programInfo?.executable === true, configInitialized: snapshot.config !== null };
      if (this.program?.deployed !== program.deployed || this.program.configInitialized !== program.configInitialized) {
        const stage = !program.deployed ? "not deployed" : !program.configInitialized ? "config not initialized" : "live";
        log("program_state", { programId: COPIER_PROGRAM_ID.toBase58(), stage, ...program, recheckMs: this.cfg.copierRefreshMs });
      }
      this.program = program;
      await this.resolveTokenPrograms(snapshot);
      this.registry = snapshot;
      this.lastRefreshAt = Date.now();
      this.lastRefreshError = null;
      const targets = [...snapshot.followers.keys()];
      this.detector?.setTargets(targets);
      this.detector?.setTracked(trackedAccounts(snapshot, (mint) => this.tokenPrograms.get(mint)));
      if (snapshot.copiers.size !== prevCopiers || targets.length !== prevTargets || this.lastLoggedMode !== this.mode) {
        this.lastLoggedMode = this.mode;
        let positions = 0;
        for (const m of snapshot.copiers.values()) positions += m.positions.size;
        log("targets_loaded", {
          copiers: snapshot.copiers.size,
          targets: targets.length,
          positions,
          config: snapshot.config ? "found" : "missing (Config not initialized on this cluster)",
          configKeeper: snapshot.config?.keeper.toBase58() ?? null,
          mode: this.mode,
        });
      }
    } catch (err) {
      this.lastRefreshError = errMsg(err);
      log("refresh_failed", { error: this.lastRefreshError });
    }
  }

  /** Mint → token program (owner of the mint account), cached forever (a mint never changes owner). */
  private async resolveTokenPrograms(snapshot: RegistrySnapshot): Promise<void> {
    const missing = new Set<string>();
    for (const m of snapshot.copiers.values()) for (const mint of m.positions.keys()) if (!this.tokenPrograms.has(mint)) missing.add(mint);
    const list = [...missing];
    for (let i = 0; i < list.length; i += 100) {
      const chunk = list.slice(i, i + 100);
      const infos = await this.connection.getMultipleAccountsInfo(chunk.map((m) => new PublicKey(m)), this.cfg.commitment);
      infos.forEach((info, j) => info && this.tokenPrograms.set(chunk[j]!, info.owner));
    }
  }

  async pump(): Promise<PumpState> {
    if (!this.pumpState || Date.now() - this.pumpState.at > PUMP_STATE_TTL_MS) {
      this.pumpState = { value: await fetchPumpState(this.connection, this.cfg.commitment), at: Date.now() };
    }
    return this.pumpState.value;
  }

  async venue(tokenMint: PublicKey): Promise<ResolvedVenue> {
    const venue = await resolveVenue(this.connection, tokenMint, { pumpState: await this.pump(), commitment: this.cfg.commitment });
    if (venue.kind !== "unsupported") this.tokenPrograms.set(tokenMint.toBase58(), venue.accounts.tokenProgram);
    return venue;
  }

  async rent(): Promise<bigint> {
    this.rentExempt ??= BigInt(await this.connection.getMinimumBalanceForRentExemption(0, this.cfg.commitment));
    return this.rentExempt;
  }

  /** Fresh copier + vault + position state for one decision (one round trip). */
  async readCopier(mint: PublicKey, tokenMint: PublicKey | null): Promise<CopierStateRead | null> {
    const vault = vaultPda(mint);
    const keys = [copierPda(mint), vault, wsolAta(vault), ...(tokenMint ? [positionPda(mint, tokenMint)] : [])];
    const [infos, rentExempt] = await Promise.all([this.connection.getMultipleAccountsInfo(keys, this.cfg.commitment), this.rent()]);
    const [copierInfo, vaultInfo, wsolInfo, positionInfo] = infos;
    if (!copierInfo) return null;
    const copier = decodeCopier(copierInfo.data);
    const vaultLamports = BigInt(vaultInfo?.lamports ?? 0);
    const vaultWsol = wsolInfo ? tokenAccountAmount(wsolInfo.data) : 0n;
    const { freeSol, equity } = copierEquity({ copier, vaultLamports, vaultWsol, rentExempt });
    return { copier, vaultLamports, vaultWsol, position: positionInfo ? decodePosition(positionInfo.data) : null, freeSol, equity };
  }

  /** The target's balance in its canonical token account (what the program compares against its snapshots). */
  async targetBalance(target: PublicKey, tokenMint: PublicKey, tokenProgram: PublicKey): Promise<bigint> {
    const info = await this.connection.getAccountInfo(ata(target, tokenMint, tokenProgram), this.cfg.commitment);
    return info && info.data.length >= 72 ? tokenAccountAmount(info.data) : 0n;
  }

  /** Wallets that created `venue`'s coin or earn its creator fees (fee-sharing shareholders when shared). */
  async creatorWallets(tokenMint: PublicKey, venue: Extract<ResolvedVenue, { kind: "curve" | "pool" }>): Promise<string[]> {
    const creator = venue.kind === "curve" ? venue.curve.creator : venue.pool.coinCreator;
    const wallets = [creator.toBase58()];
    if (creator.equals(sharingConfigPda(tokenMint))) {
      const info = await this.connection.getAccountInfo(creator, this.cfg.commitment);
      if (info) for (const s of decodeSharingConfig(info.data).shareholders) wallets.push(s.address.toBase58());
    }
    return wallets;
  }

  // ------------------------------------------------------------------ detection → decisions

  /** Detector callback: every tracked target the transaction involves, every leg, every copier following it. */
  onTx = async (tx: RawTx, source: TxSource, detectedAt: number): Promise<void> => {
    const involved = involvedWallets(tx);
    const work: Promise<void>[] = [];
    for (const [target, followers] of this.registry.followers) {
      if (!involved.has(target)) continue;
      for (const leg of classifyTx(tx, target)) {
        this.counters.observed += 1;
        if (leg.side === "airdrop" && !(await this.airdropWorthReporting(leg))) {
          this.counters.airdropsIgnored += 1;
          continue;
        }
        log("target_trade", {
          source,
          target,
          side: leg.side,
          tokenMint: leg.tokenMint,
          tokenDelta: leg.tokenDelta,
          solDelta: leg.solDelta,
          signature: leg.signature,
          lagMs: leg.blockTime ? detectedAt - leg.blockTime * 1000 : null,
        });
        for (const f of followers) work.push(this.withCopier(f.mint, () => this.decide(f.mint, f.targetIdx, leg, detectedAt)));
      }
    }
    await Promise.all(work);
  };

  /**
   * Dust airdrops are constant on KOL wallets; only those that would have looked like a real signal (a supported
   * venue and Δtokens × spot ≥ min signal) are bait worth showing as a skipped "blind spot".
   */
  private async airdropWorthReporting(leg: ClassifiedTrade): Promise<boolean> {
    const config = this.registry.config;
    if (!config) return false;
    let cached = this.airdropVenues.get(leg.tokenMint);
    if (!cached || Date.now() - cached.at > AIRDROP_VENUE_TTL_MS) {
      try {
        cached = { venue: await this.venue(new PublicKey(leg.tokenMint)), at: Date.now() };
      } catch {
        return false;
      }
      this.airdropVenues.set(leg.tokenMint, cached);
    }
    if (cached.venue.kind === "unsupported") return false;
    return tokenValueLamports(leg.tokenDelta, cached.venue.reserves) >= config.params.minSignalLamports;
  }

  private async decide(mint: string, targetIdx: number, leg: ClassifiedTrade, detectedAt: number): Promise<void> {
    const base = this.ingestBase(mint, leg, detectedAt);
    let outcome: Outcome;
    try {
      outcome =
        leg.side === "buy"
          ? await this.buy(mint, targetIdx, leg)
          : leg.side === "sell" || leg.side === "transfer_out"
            ? await this.sell(mint, targetIdx, leg)
            : { status: "skipped", reason: leg.side === "airdrop" ? "not_signer" : "not_a_trade", detail: `target ${leg.side}` };
    } catch (err) {
      outcome = { status: "failed", reason: "send_failed", detail: errMsg(err) };
    }
    this.finish(base, outcome);
  }

  private ingestBase(mint: string, leg: ClassifiedTrade, detectedAt: number): TargetTradeIngest {
    return {
      copier: mint,
      target: leg.target,
      signature: leg.signature,
      slot: leg.slot,
      blockTime: leg.blockTime,
      side: leg.side,
      tokenMint: leg.tokenMint,
      tokenDelta: leg.tokenDelta.toString(),
      solDelta: leg.solDelta.toString(),
      targetSolBefore: leg.solBefore.toString(),
      priceLamportsPerToken: leg.priceLamportsPerToken,
      venue: null,
      status: "skipped",
      reason: null,
      error: null,
      vaultSignature: null,
      vaultSolIn: null,
      vaultTokensIn: null,
      detectedAt,
      decidedAt: detectedAt,
    };
  }

  private finish(base: TargetTradeIngest, o: Outcome): void {
    const trade: TargetTradeIngest = {
      ...base,
      venue: o.venue ?? null,
      status: o.status,
      reason: o.status === "copied" ? null : o.reason,
      error: o.status === "failed" ? o.detail : null,
      vaultSignature: o.vaultSignature ?? null,
      vaultSolIn: o.solIn?.toString() ?? null,
      vaultTokensIn: o.tokensIn?.toString() ?? null,
      decidedAt: Date.now(),
    };
    this.counters[o.status === "copied" ? "copied" : o.status] += 1;
    this.state.recordDecision({
      copier: trade.copier,
      target: trade.target,
      signature: trade.signature,
      side: trade.side,
      tokenMint: trade.tokenMint,
      status: trade.status,
      reason: trade.reason,
      error: trade.error,
      vaultSignature: trade.vaultSignature,
      solIn: trade.vaultSolIn,
      tokensIn: trade.vaultTokensIn,
      detectedAt: trade.detectedAt,
      decidedAt: trade.decidedAt,
    });
    this.reporter.report([trade]);
    log("decision", {
      copier: trade.copier,
      signature: trade.signature,
      side: trade.side,
      tokenMint: trade.tokenMint,
      status: trade.status,
      reason: trade.reason,
      detail: o.detail,
      vaultSignature: trade.vaultSignature,
      solIn: trade.vaultSolIn,
      tokensIn: trade.vaultTokensIn,
      decideMs: trade.decidedAt - trade.detectedAt,
    });
  }

  /** Why nothing may be sent right now (dry run, missing/foreign keeper key), or null. */
  private sendBlocker(): { reason: SkipReason; detail: string } | null {
    if (this.cfg.dryRun) return { reason: "paused", detail: "DRY_RUN: decision only" };
    const config = this.registry.config;
    if (config?.keeper.equals(PublicKey.default)) return { reason: "paused", detail: "the admin paused the keeper (pause_keeper)" };
    if (!this.keeper) {
      const { key } = this.cfg;
      return { reason: "keeper_not_authorized", detail: `no keeper keypair ${key.kind === "file" ? `at ${key.path}` : "(KEEPER_SECRET_KEY)"}` };
    }
    if (!config || !config.keeper.equals(this.keeper.publicKey)) {
      return { reason: "keeper_not_authorized", detail: `config.keeper is ${config?.keeper.toBase58() ?? "unset"}, this key is ${this.keeper.publicKey.toBase58()}` };
    }
    return null;
  }

  private async buy(mint: string, targetIdx: number, leg: ClassifiedTrade): Promise<Outcome> {
    const config = this.registry.config;
    if (!config) return { status: "skipped", reason: "keeper_not_authorized", detail: "program config not found" };
    const mintKey = new PublicKey(mint);
    const tokenMint = new PublicKey(leg.tokenMint);
    const [read, venue] = await Promise.all([this.readCopier(mintKey, tokenMint), this.venue(tokenMint)]);
    if (!read) return { status: "skipped", reason: "keeper_not_authorized", detail: "copier account not found" };
    const view: VenueView =
      venue.kind === "unsupported"
        ? { kind: "unsupported", code: venue.code }
        : { kind: venue.kind, reserves: venue.reserves, creatorWallets: await this.creatorWallets(tokenMint, venue) };
    const decision = decideBuy({
      trade: leg,
      platformMint: mint,
      params: config.params,
      venue: view,
      equity: read.equity,
      freeSol: read.freeSol,
      position: read.position ? { cost: read.position.cost, lastTradeTs: read.position.lastTradeTs, target: read.position.target.toBase58() } : null,
      openPositions: read.copier.openPositions,
      window: read.copier,
      nowTs: Math.floor(Date.now() / 1000),
      knobs: this.knobs,
    });
    const venueKind = venue.kind;
    if (decision.action === "skip") return { status: "skipped", reason: decision.reason, detail: decision.detail, venue: venueKind };
    if (venue.kind === "unsupported") throw new Error("unreachable: buy on unsupported venue");
    const minTokensOut = withSlippage(venueBuyQuote(venue.reserves, decision.solIn, venue.feeBps).tokensOut, config.params.slippageBps);
    const detail = `signal ${decision.signalLamports}, conviction ${decision.convictionBps} bps, bound by ${decision.binding}`;
    const blocker = this.sendBlocker();
    if (blocker) return { status: "skipped", ...blocker, detail: `${blocker.detail}; would buy ${decision.solIn} lamports (${detail})`, venue: venueKind, solIn: decision.solIn };
    const ixs = buildCopierBuyIx({
      keeper: this.keeper!.publicKey,
      mint: mintKey,
      targetIdx,
      target: new PublicKey(leg.target),
      tokenMint,
      solIn: decision.solIn,
      minTokensOut,
      venue,
      descriptors: config.descriptors,
    });
    return this.execute(ixs, leg.signature, { venue: venue.kind, solIn: decision.solIn, detail });
  }

  private async sell(mint: string, targetIdx: number, leg: ClassifiedTrade): Promise<Outcome> {
    const config = this.registry.config;
    if (!config) return { status: "skipped", reason: "keeper_not_authorized", detail: "program config not found" };
    const mintKey = new PublicKey(mint);
    const tokenMint = new PublicKey(leg.tokenMint);
    const read = await this.readCopier(mintKey, tokenMint);
    if (!read) return { status: "skipped", reason: "keeper_not_authorized", detail: "copier account not found" };
    if (!read.position || read.position.tokens <= 0n) return { status: "skipped", reason: "no_position", detail: "the vault holds none of this token" };
    if (!read.position.target.equals(new PublicKey(leg.target))) {
      return { status: "skipped", reason: "held_by_other_target", detail: `the position follows ${read.position.target.toBase58()}` };
    }
    const venue = await this.venue(tokenMint);
    if (venue.kind === "unsupported") {
      const reason: SkipReason = venue.code === "migrating" ? "migrating" : "unsupported_venue";
      return { status: "skipped", reason, detail: `cannot sell now: ${venue.reason} (the crank retries)`, venue: "unsupported" };
    }
    const prepared = await this.prepareSell(mintKey, targetIdx, read.position, venue, config);
    if (prepared.action === "skip") return { status: "skipped", reason: prepared.reason, detail: prepared.detail, venue: venue.kind };
    const blocker = this.sendBlocker();
    if (blocker) return { status: "skipped", ...blocker, detail: `${blocker.detail}; would sell ${prepared.tokensIn} tokens`, venue: venue.kind, tokensIn: prepared.tokensIn };
    return this.execute(prepared.ixs, leg.signature, { venue: venue.kind, tokensIn: prepared.tokensIn, detail: prepared.forced ? "max-hold exit" : "proportional" });
  }

  /** The sell decision + instructions for a position on a live venue (also used by the max-hold / reconcile crank). */
  async prepareSell(
    mint: PublicKey,
    targetIdx: number,
    position: PositionAccount,
    venue: Extract<ResolvedVenue, { kind: "curve" | "pool" }>,
    config: ConfigAccount,
  ): Promise<PreparedSell | { action: "skip"; reason: SkipReason; detail: string }> {
    const targetNow = await this.targetBalance(position.target, position.tokenMint, venue.accounts.tokenProgram);
    const decision = decideSell({
      position,
      targetNow,
      nowTs: Math.floor(Date.now() / 1000),
      maxHoldSecs: config.params.maxHoldSecs,
      reserves: venue.reserves,
    });
    if (decision.action === "skip") return decision;
    let expected: bigint;
    try {
      expected = venueSellQuote(venue.reserves, decision.tokensIn, venue.feeBps).solOut;
    } catch (err) {
      return { action: "skip", reason: "token_dead", detail: errMsg(err) };
    }
    const ixs = buildCopierSellIx({
      authority: this.keeper?.publicKey ?? PublicKey.default,
      mint,
      targetIdx,
      target: position.target,
      tokenMint: position.tokenMint,
      tokensIn: decision.tokensIn,
      minSolOut: withSlippage(expected, config.params.slippageBps),
      venue,
      descriptors: config.descriptors,
    });
    return { action: "sell", tokensIn: decision.tokensIn, forced: decision.forced, ixs };
  }

  private async execute(
    ixs: TransactionInstruction[],
    targetSignature: string,
    meta: { venue: "curve" | "pool"; solIn?: bigint; tokensIn?: bigint; detail: string },
  ): Promise<Outcome> {
    try {
      const sent = await this.executor.send(this.keeper!, ixs, { memo: `copier:${targetSignature}` });
      this.lastKeeperIxAt = Date.now();
      const ev = parseCopierEvents(sent.logs).find((e) => e.name === "CopierBuy" || e.name === "CopierSell");
      const filled =
        ev?.name === "CopierBuy" ? `, got ${ev.data.tokensOut} tokens` : ev?.name === "CopierSell" ? `, got ${ev.data.solOut} lamports (pnl ${ev.data.pnl})` : "";
      return { status: "copied", reason: null, detail: `${meta.detail}${filled}; ${sent.computeUnits} CU @ ${sent.priorityMicroLamports} µl`, vaultSignature: sent.signature, venue: meta.venue, solIn: meta.solIn, tokensIn: meta.tokensIn };
    } catch (err) {
      if (err instanceof SimulationError) {
        // A cap the program enforces but the keeper's read missed (state moved in between): nothing was sent.
        const skip = err.code ? PROGRAM_SKIPS[err.code] : undefined;
        if (skip) return { status: "skipped", reason: skip, detail: err.detail, venue: meta.venue, solIn: meta.solIn, tokensIn: meta.tokensIn };
        return { status: "failed", reason: "simulation_failed", detail: err.detail, venue: meta.venue, solIn: meta.solIn, tokensIn: meta.tokensIn };
      }
      if (err instanceof SendError) {
        return { status: "failed", reason: "send_failed", detail: err.message, vaultSignature: err.signature ?? undefined, venue: meta.venue, solIn: meta.solIn, tokensIn: meta.tokensIn };
      }
      return { status: "failed", reason: "send_failed", detail: errMsg(err), venue: meta.venue, solIn: meta.solIn, tokensIn: meta.tokensIn };
    }
  }
}

export interface PreparedSell {
  action: "sell";
  tokensIn: bigint;
  /** The max-hold rule released more than the proportional rule would. */
  forced: boolean;
  ixs: TransactionInstruction[];
}

type Outcome = {
  detail: string;
  venue?: "curve" | "pool" | "unsupported";
  vaultSignature?: string;
  solIn?: bigint;
  tokensIn?: bigint;
} & ({ status: "copied"; reason: null } | { status: "skipped" | "failed"; reason: SkipReason });
