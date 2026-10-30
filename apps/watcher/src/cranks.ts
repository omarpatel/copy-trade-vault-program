import { PublicKey, type TransactionInstruction } from "@solana/web3.js";
import {
  ammCreatorVaultAuthority,
  impactCapLamports,
  ata,
  burnPoolPda,
  buildBurnPlatformIx,
  buildBuybackBurnIx,
  buildDistributeFeesIxs,
  buildFundPlatformBurnIx,
  buildKeeperHeartbeatIx,
  buildSyncIx,
  copierShareholders,
  parseCopierEvents,
  sharingConfigPda,
  vaultPda,
  venueBuyQuote,
  withSlippage,
  wsolAta,
  type ConfigAccount,
  type ResolvedVenue,
} from "@copy-trade-vault/sdk";
import type { Executor } from "./executor";
import { SendError, SimulationError } from "./executor";
import type { Keeper } from "./keeper";
import { errMsg, log } from "./log";
import type { RawRpc } from "./rpc";

/**
 * Periodic per-copier maintenance (SPEC §4 Cranks), every `CRANK_MS`:
 * - `distribute`: pump's permissionless creator-fee crank (`sweep_creator_fee` [+ pool sweep + transfer after
 *   graduation] → `distribute_creator_fees_v2` → copier `sync`), sent only when a simulation shows the vault gaining
 *   ≥ `DISTRIBUTE_MIN_LAMPORTS`; a bare `sync` when lamports arrived some other way;
 * - `fund_platform_burn`: moves a pending 25% the platform token share to the burn pool;
 * - `buyback_burn`: when the buyback pool ≥ 0.05 SOL (and ≥ 60 s since the last), sized to the impact cap;
 * - `burn_platform` (once per round): when the burn pool holds ≥ 0.05 SOL and `config.platform_mint` is set;
 * - `exit`: positions whose `allowedSell` is positive without a fresh target trade — max-hold exits and sells the
 *   detector missed (state-based convergence).
 * A failing crank backs off exponentially per (copier, kind) up to an hour.
 */

export type CrankKind = "distribute" | "sync" | "fund_platform_burn" | "buyback_burn" | "burn_platform" | "exit";

export interface CrankAttempt {
  kind: CrankKind;
  copier: string | null;
  at: number;
  signature: string | null;
  error: string | null;
  /** Lamports moved/spent, from the landed event or the simulation. */
  amount: string | null;
  detail: string | null;
}

const MAX_ATTEMPTS_KEPT = 50;
const MAX_BACKOFF_MS = 3_600_000;
const BUYBACK_MIN_INTERVAL_SECS = 60n;
/**
 * `burn_platform` spends the burn pool PDA's own lamports, which also pay one-time rents on the venue: the pool's
 * Token-2022 ATA for the platform token mint and pump's user-volume accumulator on the curve (≈3.9M lamports, measured
 * shortfall 3.03M), plus the transient wSOL ATA on PumpSwap. Without this headroom a curve burn of the whole pool
 * fails in simulation with System `insufficient lamports` (0x1).
 */
export const BURN_HEADROOM_LAMPORTS = 10_000_000n;

/** Lamports `burn_platform` may spend from a burn pool holding `poolLamports` (rent-exempt minimum `rent`). */
export function burnPlatformBudget(poolLamports: bigint, rent: bigint): bigint {
  const budget = poolLamports - rent - BURN_HEADROOM_LAMPORTS;
  return budget > 0n ? budget : 0n;
}
const PLATFORM_BURN_MIN_INTERVAL_SECS = 60n;
/** Liveness proof cadence (the program's grace is ≥ 600 s; a minute leaves room for outages). */
const HEARTBEAT_MS = 60_000;
/** Crank kinds signed by the keeper as a copy-vault trade/burn: each refreshes `config.keeper_heartbeat_ts`. */
const KEEPER_SIGNED: Partial<Record<CrankKind, true>> = { buyback_burn: true, burn_platform: true, exit: true };

export interface HeartbeatStatus {
  /** Wall-clock ms of the last heartbeat attempt, its signature and error (null = landed). */
  lastAt: number | null;
  signature: string | null;
  error: string | null;
}

export class Cranks {
  private timer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private running = false;
  private beating = false;
  private readonly backoff = new Map<string, { fails: number; nextAt: number }>();
  readonly attempts: CrankAttempt[] = [];
  readonly heartbeatStatus: HeartbeatStatus = { lastAt: null, signature: null, error: null };
  lastRoundAt: number | null = null;

  constructor(
    private readonly keeper: Keeper,
    private readonly executor: Executor,
    private readonly rpc: RawRpc,
    private readonly intervalMs: number,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.round(), this.intervalMs);
    this.heartbeatTimer = setInterval(() => void this.heartbeat(), HEARTBEAT_MS);
    void this.round();
    void this.heartbeat();
  }

  stop(): void {
    clearInterval(this.timer ?? undefined);
    clearInterval(this.heartbeatTimer ?? undefined);
  }

  /**
   * `keeper_heartbeat` (SPEC: liveness): without a keeper-signed instruction for `keeper_grace_secs`, anyone may exit
   * positions whose target holds nothing. Sent every `HEARTBEAT_MS` unless a keeper-signed trade or burn (which
   * refreshes the on-chain timestamp too) landed within that interval.
   */
  async heartbeat(): Promise<void> {
    if (this.beating || this.keeper.mode !== "live" || Date.now() - this.keeper.lastKeeperIxAt < HEARTBEAT_MS) return;
    this.beating = true;
    const keeper = this.keeper.keeper!;
    this.heartbeatStatus.lastAt = Date.now();
    try {
      const sent = await this.executor.send(keeper, buildKeeperHeartbeatIx({ keeper: keeper.publicKey }));
      this.keeper.lastKeeperIxAt = Date.now();
      this.heartbeatStatus.signature = sent.signature;
      this.heartbeatStatus.error = null;
    } catch (err) {
      this.heartbeatStatus.error = err instanceof SimulationError ? `simulation: ${err.detail}` : errMsg(err);
      log("heartbeat_failed", { error: this.heartbeatStatus.error });
    } finally {
      this.beating = false;
    }
  }

  async round(): Promise<void> {
    if (this.running || this.keeper.mode !== "live") return;
    const config = this.keeper.registry.config;
    if (!config) return;
    this.running = true;
    try {
      for (const mint of this.keeper.registry.copiers.keys()) {
        await this.keeper.withCopier(mint, () => this.copierRound(mint, config));
      }
      await this.burnPlatform(config);
      this.lastRoundAt = Date.now();
    } catch (err) {
      log("crank_round_failed", { error: errMsg(err) });
    } finally {
      this.running = false;
    }
  }

  private due(key: string): boolean {
    const b = this.backoff.get(key);
    return !b || Date.now() >= b.nextAt;
  }

  private record(a: Omit<CrankAttempt, "at">, key: string): void {
    const attempt = { ...a, at: Date.now() };
    this.attempts.unshift(attempt);
    this.attempts.length = Math.min(this.attempts.length, MAX_ATTEMPTS_KEPT);
    if (a.error) {
      const fails = (this.backoff.get(key)?.fails ?? 0) + 1;
      this.backoff.set(key, { fails, nextAt: Date.now() + Math.min(this.intervalMs * 2 ** fails, MAX_BACKOFF_MS) });
    } else {
      this.backoff.delete(key);
    }
    log("crank", attempt);
  }

  /** Sends one crank; its outcome (and failure back-off) is recorded under `opts.key` (default `<copier>:<kind>`). */
  private async send(
    kind: CrankKind,
    copier: string | null,
    ixs: TransactionInstruction[],
    opts: { memo?: string; amount?: bigint; detail?: string; key?: string } = {},
  ): Promise<void> {
    const key = opts.key ?? `${copier ?? "global"}:${kind}`;
    try {
      const sent = await this.executor.send(this.keeper.keeper!, ixs, { memo: opts.memo });
      if (KEEPER_SIGNED[kind]) this.keeper.lastKeeperIxAt = Date.now();
      const events = parseCopierEvents(sent.logs);
      const ev = events.find((e) => e.name === "FeesSynced" || e.name === "BuybackBurned" || e.name === "PlatformBurned" || e.name === "CopierSell");
      const amount =
        ev?.name === "FeesSynced" ? ev.data.lamports : ev?.name === "BuybackBurned" || ev?.name === "PlatformBurned" ? ev.data.solIn : ev?.name === "CopierSell" ? ev.data.solOut : opts.amount;
      this.record({ kind, copier, signature: sent.signature, error: null, amount: amount?.toString() ?? null, detail: opts.detail ?? null }, key);
    } catch (err) {
      const error = err instanceof SimulationError ? `simulation: ${err.detail}` : err instanceof SendError ? err.message : errMsg(err);
      this.record({ kind, copier, signature: err instanceof SendError ? err.signature : null, error, amount: null, detail: opts.detail ?? null }, key);
    }
  }

  private async copierRound(mint: string, config: ConfigAccount): Promise<void> {
    const keeper = this.keeper.keeper!;
    const mintKey = new PublicKey(mint);
    const read = await this.keeper.readCopier(mintKey, null);
    if (!read) return;
    const { copier } = read;
    const own = await this.keeper.venue(mintKey);

    // 1. creator fees → vault (+ sync)
    if (this.due(`${mint}:distribute`)) {
      const vault = vaultPda(mintKey);
      const ixs = buildDistributeFeesIxs({
        payer: keeper.publicKey,
        mint: mintKey,
        graduated: await this.poolFeesPending(mintKey, own),
        shareholders: copierShareholders(copier),
      });
      try {
        const sim = await this.executor.simulate(keeper.publicKey, ixs, [vault]);
        const gain = BigInt(sim.lamports[0] ?? 0) - read.vaultLamports;
        const unbooked = read.vaultLamports + read.vaultWsol - copier.accountedLamports;
        if (gain >= this.keeper.cfg.distributeMinLamports) {
          await this.send("distribute", mint, ixs, { amount: gain, detail: `vault +${gain} lamports` });
        } else if (unbooked >= this.keeper.cfg.distributeMinLamports) {
          await this.send("sync", mint, buildSyncIx({ mint: mintKey }), { amount: unbooked });
        }
      } catch (err) {
        const error = err instanceof SimulationError ? `simulation: ${err.detail}` : errMsg(err);
        this.record({ kind: "distribute", copier: mint, signature: null, error, amount: null, detail: null }, `${mint}:distribute`);
      }
    }

    // 2. pending the platform token share → burn pool
    if (copier.platformPending > 0n && this.due(`${mint}:fund_platform_burn`)) {
      await this.send("fund_platform_burn", mint, buildFundPlatformBurnIx({ mint: mintKey }), { amount: copier.platformPending });
    }

    // 3. own-coin buyback & burn
    const nowTs = BigInt(Math.floor(Date.now() / 1000));
    if (
      copier.buybackPool >= this.keeper.cfg.buybackMinLamports &&
      nowTs - copier.lastBuybackTs >= BUYBACK_MIN_INTERVAL_SECS &&
      own.kind !== "unsupported" &&
      this.due(`${mint}:buyback_burn`)
    ) {
      const solIn = this.sizeBurn(copier.buybackPool, own, config);
      if (solIn >= config.params.minTradeLamports) {
        const minTokensOut = withSlippage(venueBuyQuote(own.reserves, solIn, own.feeBps).tokensOut, config.params.slippageBps);
        await this.send("buyback_burn", mint, buildBuybackBurnIx({ keeper: keeper.publicKey, mint: mintKey, solIn, minTokensOut, venue: own, descriptors: config.descriptors }), {
          amount: solIn,
        });
      }
    }

    // 4. positions the target-trade path did not (or could not yet) exit
    const entry = this.keeper.registry.copiers.get(mint);
    for (const position of entry?.positions.values() ?? []) {
      const targetIdx = copier.targets.findIndex((t) => t.equals(position.target));
      const key = `${mint}:exit:${position.tokenMint.toBase58()}`;
      if (targetIdx < 0 || !this.due(key)) continue;
      const venue = await this.keeper.venue(position.tokenMint);
      if (venue.kind === "unsupported") continue;
      // Re-read: the registry copy can be up to one refresh old and a sell may have landed since.
      const fresh = await this.keeper.readCopier(mintKey, position.tokenMint);
      if (!fresh?.position || fresh.position.tokens <= 0n) continue;
      const prepared = await this.keeper.prepareSell(mintKey, targetIdx, fresh.position, venue, config);
      if (prepared.action === "skip") continue;
      const answered = prepared.forced ? null : await this.latestTargetSignature(position.target, position.tokenMint, venue);
      // Back-off per position: the key the loop above checks.
      await this.send("exit", mint, prepared.ixs, {
        key,
        memo: answered ? `copier:${answered}` : undefined,
        detail: `${prepared.forced ? "max-hold" : "catch-up"} sell of ${prepared.tokensIn} ${position.tokenMint.toBase58()}`,
      });
    }
  }

  /** The target's newest signature on its token account: the trade a catch-up sell answers (for the memo). */
  private async latestTargetSignature(target: PublicKey, tokenMint: PublicKey, venue: Extract<ResolvedVenue, { kind: "curve" | "pool" }>): Promise<string | null> {
    try {
      const [latest] = await this.rpc.getSignaturesForAddress(ata(target, tokenMint, venue.accounts.tokenProgram).toBase58(), { limit: 1 });
      return latest?.signature ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Whether the distribute crank must first move the pool's creator fees to pump (AMM `sweep_creator_fee` +
   * `transfer_creator_fees_to_pump_v2`): only after graduation, and only when the pool holds creator fees or the
   * AMM creator vault's wSOL ATA already exists — right after migration that ATA is missing and the transfer fails
   * with AccountNotInitialized (verified by ProgramAgent in litesvm against the mainnet programs).
   */
  private async poolFeesPending(mint: PublicKey, own: ResolvedVenue): Promise<boolean> {
    if (own.kind !== "pool") return false;
    if (own.pool.creatorFees > 0n) return true;
    const vaultAta = wsolAta(ammCreatorVaultAuthority(sharingConfigPda(mint)));
    return (await this.keeper.connection.getAccountInfo(vaultAta, this.keeper.cfg.commitment)) !== null;
  }

  /** Spend at most the pool, and at most `max_impact_bps` of the venue's real SOL in one go. */
  private sizeBurn(available: bigint, venue: Extract<ResolvedVenue, { kind: "curve" | "pool" }>, config: ConfigAccount): bigint {
    const impact = impactCapLamports(venue.reserves, config.params.maxImpactBps);
    return available < impact ? available : impact;
  }

  private async burnPlatform(config: ConfigAccount): Promise<void> {
    if (config.platformMint.equals(PublicKey.default) || !this.due("global:burn_platform")) return;
    // The program allows one burn_platform per 60 s (`config.last_platform_burn_ts`).
    if (BigInt(Math.floor(Date.now() / 1000)) - config.lastPlatformBurnTs < PLATFORM_BURN_MIN_INTERVAL_SECS) return;
    const keeper = this.keeper.keeper!;
    const [info, rent] = await Promise.all([
      this.keeper.connection.getAccountInfo(burnPoolPda(), this.keeper.cfg.commitment),
      this.keeper.rent(),
    ]);
    const venue = await this.keeper.venue(config.platformMint);
    if (venue.kind === "unsupported") return;
    const available = burnPlatformBudget(BigInt(info?.lamports ?? 0), rent);
    if (available < this.keeper.cfg.buybackMinLamports) return;
    const solIn = this.sizeBurn(available, venue, config);
    if (solIn < config.params.minTradeLamports) return;
    const minTokensOut = withSlippage(venueBuyQuote(venue.reserves, solIn, venue.feeBps).tokensOut, config.params.slippageBps);
    await this.send(
      "burn_platform",
      null,
      buildBurnPlatformIx({ keeper: keeper.publicKey, platformMint: config.platformMint, solIn, minTokensOut, venue, descriptors: config.descriptors }),
      { amount: solIn },
    );
  }
}
