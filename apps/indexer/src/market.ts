import {
  bondingCurvePda,
  canonicalPoolPda,
  curveFeeBps,
  curveProgressBps,
  curveReserves,
  decodeBondingCurve,
  decodePool,
  fetchPumpState,
  marketCapLamports,
  poolFeeBps,
  poolReserves,
  spotPriceLamportsPerToken,
  tokenAccountAmount,
  tokenValueLamports,
  wsolAta,
  type FeeBps,
  type Pool,
  type PumpState,
  type VenueReserves,
} from "@copy-trade-vault/sdk";
import { PublicKey, type AccountInfo, type Connection } from "@solana/web3.js";
import type { FastifyBaseLogger } from "fastify";
import { exitValueLamports, foldCandle, vaultBook } from "./aggregate";
import type { CopierRow, Store } from "./db";
import { decodeMint } from "./metadata";

const BATCH = 100;
/** 15s samples kept this long. */
const SNAPSHOT_RETENTION_S = 8 * 86_400;
/** 1-minute candles kept this long; older ones are folded into hourly candles. */
export const MINUTE_CANDLE_RETENTION_S = 30 * 86_400;
export const COMPACTED_CANDLE_SECS = 3_600;
const PRUNE_EVERY_MS = 60 * 60_000;
/** pump Global + both FeeConfigs (fee tiers, creator fee switch) change rarely: re-read this often. */
const PUMP_STATE_TTL_MS = 10 * 60_000;

export interface VenueQuote {
  venue: "curve" | "pool";
  pool: string | null;
  reserves: VenueReserves;
  /** Spot price (display only: positions are marked at exit value). */
  price: number;
  mcap: bigint;
  supply: bigint | null;
  progressBps: number;
  /** The fees a sell pays on this venue right now (live FeeConfig tier); null until pump's fee state was read. */
  feeBps: FeeBps | null;
}

interface MintKeys {
  curve: PublicKey;
  pool: PublicKey;
}

/**
 * Prices every copier coin and every open position from its venue (bonding curve while live, canonical PumpSwap pool
 * after graduation) with batched `getMultipleAccountsInfo`, then books per copier: vault NAV (marks), coin market
 * columns, a 15s snapshot and the 1-minute candle. Runs every SNAPSHOT_MS and on demand after vault trades.
 */
export class Market {
  private readonly keys = new Map<string, MintKeys>();
  private readonly vaults = new Map<string, { vault: PublicKey; wsol: PublicKey }>();
  private lastPrune = 0;
  private running: Promise<string[]> | null = null;

  constructor(
    private readonly store: Store,
    private readonly connection: Connection,
    private readonly log: FastifyBaseLogger,
  ) {}

  /** Rent-exempt minimum of the zero-data vault (read once from the node). */
  private rent: bigint | null = null;
  /** Last good pump Global + FeeConfigs (fee tiers for exit values) and when it was read. */
  private pump: { state: PumpState; at: number } | null = null;
  /** A pump fee state read is failing: warn on the first failure and on recovery, not on every retry. */
  private pumpFailing = false;

  /**
   * pump's fee state, re-read every PUMP_STATE_TTL_MS. A failed refresh keeps the last good copy; never read means
   * null (positions then count at cost basis instead of being marked with guessed fees).
   */
  private async pumpState(): Promise<PumpState | null> {
    if (this.pump && Date.now() - this.pump.at < PUMP_STATE_TTL_MS) return this.pump.state;
    try {
      this.pump = { state: await fetchPumpState(this.connection), at: Date.now() };
      if (this.pumpFailing) this.log.info("pump fee state read recovered");
      this.pumpFailing = false;
    } catch (err) {
      if (!this.pumpFailing) {
        this.log.warn({ error: err instanceof Error ? err.message : String(err), cached: this.pump !== null }, "pump fee state read failed (retrying quietly)");
      }
      this.pumpFailing = true;
    }
    return this.pump?.state ?? null;
  }

  private mintKeys(mint: string): MintKeys {
    let k = this.keys.get(mint);
    if (!k) {
      const pk = new PublicKey(mint);
      k = { curve: bondingCurvePda(pk), pool: canonicalPoolPda(pk) };
      this.keys.set(mint, k);
    }
    return k;
  }

  private vaultKeys(row: CopierRow): { vault: PublicKey; wsol: PublicKey } {
    let v = this.vaults.get(row.mint);
    if (!v) {
      const vault = new PublicKey(row.vault);
      v = { vault, wsol: wsolAta(vault) };
      this.vaults.set(row.mint, v);
    }
    return v;
  }

  private async fetchMany(keys: PublicKey[]): Promise<(AccountInfo<Buffer> | null)[]> {
    const out: (AccountInfo<Buffer> | null)[] = [];
    for (let i = 0; i < keys.length; i += BATCH) {
      out.push(...(await this.connection.getMultipleAccountsInfo(keys.slice(i, i + BATCH), "confirmed")));
    }
    return out;
  }

  /** Venue quotes for `mints` (absent: no live curve and no canonical pool). Also records mint decimals/metadata. */
  async quotes(mints: string[]): Promise<Map<string, VenueQuote>> {
    const keys: PublicKey[] = [];
    for (const m of mints) {
      const k = this.mintKeys(m);
      keys.push(k.curve, k.pool, new PublicKey(m));
    }
    const [infos, pump] = await Promise.all([this.fetchMany(keys), this.pumpState()]);
    const poolVaults: PublicKey[] = [];
    const pending: { mint: string; pool: Pool; supply: bigint | null; at: number }[] = [];
    const out = new Map<string, VenueQuote>();
    mints.forEach((mint, i) => {
      const curveInfo = infos[i * 3];
      const poolInfo = infos[i * 3 + 1];
      const mintInfo = infos[i * 3 + 2];
      let supply: bigint | null = null;
      if (mintInfo) {
        try {
          const decoded = decodeMint(mintInfo.owner.toBase58(), mintInfo.data);
          supply = decoded.supply;
          const token = this.store.token(mint);
          if (token && token.program === null) this.store.setTokenMint(mint, decoded.program, decoded.decimals, decoded.meta);
        } catch (err) {
          this.log.debug({ mint, err: String(err) }, "mint account not decodable");
        }
      }
      const curve = curveInfo ? decodeBondingCurve(curveInfo.data) : null;
      if (curve && !curve.complete && curve.virtualTokenReserves > 0n) {
        const reserves = curveReserves(curve, supply ?? undefined);
        out.set(mint, {
          venue: "curve",
          pool: null,
          reserves,
          price: spotPriceLamportsPerToken(reserves),
          mcap: marketCapLamports(reserves),
          supply,
          progressBps: curveProgressBps(curve.realTokenReserves),
          feeBps: pump ? curveFeeBps(pump.curveFeeConfig, curve, reserves.supply, pump.global.creatorFeeConfigurable) : null,
        });
        return;
      }
      if (poolInfo) {
        const pool = decodePool(poolInfo.data);
        pending.push({ mint, pool, supply, at: poolVaults.length });
        poolVaults.push(pool.poolBaseTokenAccount, pool.poolQuoteTokenAccount);
      }
    });
    if (poolVaults.length > 0) {
      const vaultInfos = await this.fetchMany(poolVaults);
      for (const { mint, pool, supply, at } of pending) {
        const base = vaultInfos[at];
        const quote = vaultInfos[at + 1];
        if (!base || !quote) continue;
        const reserves = poolReserves(pool, tokenAccountAmount(base.data), tokenAccountAmount(quote.data), supply ?? undefined);
        if (reserves.baseReserve === 0n) continue;
        out.set(mint, {
          venue: "pool",
          pool: this.mintKeys(mint).pool.toBase58(),
          reserves,
          price: spotPriceLamportsPerToken(reserves),
          mcap: marketCapLamports(reserves),
          supply,
          progressBps: 10_000,
          feeBps: pump ? poolFeeBps(pump.ammFeeConfig, pool, reserves.baseReserve, reserves.quoteReserve, reserves.supply, pump.global.creatorFeeConfigurable) : null,
        });
      }
    }
    return out;
  }

  /** Samples `only` (default: every copier). Returns the copiers whose NAV or coin price changed. Coalesced. */
  tick(only?: string[]): Promise<string[]> {
    if (this.running && !only) return this.running;
    const run = this.sample(only).finally(() => {
      if (this.running === run) this.running = null;
    });
    if (!only) this.running = run;
    return run;
  }

  private async sample(only?: string[]): Promise<string[]> {
    const generation = this.store.generation;
    const all = this.store.copiers();
    const copiers = only ? all.filter((m) => only.includes(m.mint)) : all;
    if (copiers.length === 0) return [];
    const positions = this.store.allPositions().filter((p) => copiers.some((m) => m.mint === p.copier));
    const mints = [...new Set([...copiers.map((m) => m.mint), ...positions.map((p) => p.token_mint)])];
    const vaultKeys = copiers.flatMap((m) => {
      const v = this.vaultKeys(m);
      return [v.vault, v.wsol];
    });
    this.rent ??= BigInt(await this.connection.getMinimumBalanceForRentExemption(0));
    const rent = this.rent;
    const [quotes, vaultInfos] = await Promise.all([this.quotes(mints), this.fetchMany(vaultKeys)]);
    // A chain reset wiped the index while we were reading: these numbers belong to the old chain.
    if (generation !== this.store.generation) return [];

    const now = Math.floor(Date.now() / 1000);
    const changed: string[] = [];
    this.store.tx(() => {
      copiers.forEach((m, i) => {
        const vaultLamports = BigInt(vaultInfos[i * 2]?.lamports ?? 0);
        const wsolInfo = vaultInfos[i * 2 + 1];
        const wsol = wsolInfo ? tokenAccountAmount(wsolInfo.data) : 0n;
        const own = positions.filter((p) => p.copier === m.mint);
        const marked = own.map((p) => {
          const q = quotes.get(p.token_mint);
          const tokens = BigInt(p.tokens);
          // NAV marks every position at what selling it all would return (impact + fees); spot is display only.
          const value = q?.feeBps ? exitValueLamports(tokens, q.reserves, q.feeBps) : null;
          const spot = q ? tokenValueLamports(tokens, q.reserves) : null;
          this.store.setPositionMark(p.copier, p.token_mint, q?.venue ?? "unsupported", q?.price ?? null, value?.toString() ?? null, spot?.toString() ?? null);
          return { cost: BigInt(p.cost), value };
        });
        const book = vaultBook({
          vaultLamports,
          wsol,
          rent,
          buybackPool: BigInt(m.buyback_pool),
          platformPending: BigInt(m.platform_pending),
          openCost: BigInt(m.open_cost),
          positions: marked,
        });
        this.store.setBook(m.mint, {
          vault_lamports: vaultLamports.toString(),
          wsol: wsol.toString(),
          free: book.free.toString(),
          equity: book.equity.toString(),
          nav: book.nav.toString(),
          positions_value: book.positionsValue.toString(),
          unrealized: book.unrealized.toString(),
        });
        const q = quotes.get(m.mint);
        if (q) {
          this.store.setMarket(m.mint, {
            venue: q.venue,
            pool: q.pool,
            price: q.price,
            mcap: q.mcap.toString(),
            supply: q.supply?.toString() ?? m.supply,
            decimals: this.store.token(m.mint)?.decimals ?? m.decimals,
            curve_progress: q.progressBps,
            market_at: now,
          });
        }
        const nav = book.nav.toString();
        const price = q?.price ?? m.price;
        const mcap = q ? q.mcap.toString() : m.mcap;
        this.store.insertSnapshot({ mint: m.mint, ts: now, price, mcap, supply: q?.supply?.toString() ?? m.supply, nav });
        if (price !== null) {
          const t = now - (now % 60);
          const prev = this.store.candle(m.mint, t);
          const c = foldCandle(prev ? { t, o: prev.o, h: prev.h, l: prev.l, c: prev.c, mcap: prev.mcap } : null, t, price, mcap);
          this.store.upsertCandle({ mint: m.mint, ...c, nav });
        }
        if (nav !== m.nav || price !== m.price) changed.push(m.mint);
      });
    });
    if (Date.now() - this.lastPrune > PRUNE_EVERY_MS) {
      this.lastPrune = Date.now();
      this.store.pruneSnapshots(now - SNAPSHOT_RETENTION_S);
      while (this.store.compactCandles(now - MINUTE_CANDLE_RETENTION_S, COMPACTED_CANDLE_SECS) > 0);
    }
    return changed;
  }
}
