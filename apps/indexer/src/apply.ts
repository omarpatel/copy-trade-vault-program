import { vaultPda, type CopierEvent, type ProgramParams } from "@copy-trade-vault/sdk";
import type { ParamsSnapshot } from "@copy-trade-vault/sdk/api";
import { PublicKey } from "@solana/web3.js";
import type { Store } from "./db";
import { CONFIG_KEY, readConfig, type ProgramConfig } from "./views";

export const DEFAULT_PUBKEY = "11111111111111111111111111111111";

/** What one transaction's events changed, for the follow-up refreshes and WS pushes. */
export class Effects {
  /** Copiers whose account must be re-read. */
  readonly copiers = new Set<string>();
  /** copier → traded mints whose Position account must be re-read. */
  readonly positions = new Map<string, Set<string>>();
  readonly newCopiers: string[] = [];
  /** [signature, eventIndex] of newly inserted rows. */
  readonly trades: number[] = [];
  readonly burns: number[] = [];
  readonly syncs: number[] = [];
  readonly deposits: number[] = [];
  readonly splits: number[] = [];
  /** Admin change ids proposed / resolved / invalidated in this tx (their PendingChange account is re-read). */
  readonly changes: { id: number; event: "proposed" | "executed" | "cancelled" | "discarded" | "invalidated" }[] = [];
  /** `KeeperPaused` events (the removed keeper). */
  readonly pauses: string[] = [];
  config = false;
  /** Index targets changed: the stream must watch the copier's addresses again. */
  targetsChanged = false;

  touchPosition(copier: string, tokenMint: string): void {
    let set = this.positions.get(copier);
    if (!set) this.positions.set(copier, (set = new Set()));
    set.add(tokenMint);
  }
}

export interface TxContext {
  signature: string;
  slot: number;
  /** The vault tx's SPL memo `copier:<target sig>` (null: no memo). */
  memoTarget: string | null;
}

const str = (v: bigint | number) => v.toString();

/** Program params (bigint) → the API snapshot (lamports as strings, seconds as numbers). */
export function paramsSnapshot(p: ProgramParams): ParamsSnapshot {
  return {
    maxTradeBps: Number(p.maxTradeBps),
    maxPositionBps: Number(p.maxPositionBps),
    maxOpenPositions: Number(p.maxOpenPositions),
    minTradeLamports: str(p.minTradeLamports),
    minSignalLamports: str(p.minSignalLamports),
    signalMultipleBps: Number(p.signalMultipleBps),
    maxImpactBps: Number(p.maxImpactBps),
    slippageBps: Number(p.slippageBps),
    vaultFloorLamports: str(p.vaultFloorLamports),
    maxHoldSecs: Number(p.maxHoldSecs),
    keeperGraceSecs: Number(p.keeperGraceSecs),
    spendWindowSecs: Number(p.spendWindowSecs),
    maxWindowSpendBps: Number(p.maxWindowSpendBps),
  };
}

export const keyOrNull = (k: string): string | null => (k === DEFAULT_PUBKEY ? null : k);

/**
 * `ParamsUpdated` → the persisted program config. The event lacks the timelock / heartbeat / pending-admin ETA fields:
 * they carry over from the last Config account read.
 */
export function configFromEvent(d: Extract<CopierEvent, { name: "ParamsUpdated" }>["data"], prev: ProgramConfig | null): ProgramConfig {
  const pendingAdmin = keyOrNull(d.pendingAdmin);
  return {
    admin: d.admin,
    keeper: keyOrNull(d.keeper),
    platformMint: keyOrNull(d.platformMint),
    params: paramsSnapshot(d.params),
    platformBurned: prev?.platformBurned ?? "0",
    platformBurnSpent: prev?.platformBurnSpent ?? "0",
    timelockSecs: prev?.timelockSecs ?? null,
    pendingAdmin,
    pendingAdminEta: pendingAdmin === null ? null : (prev?.pendingAdminEta ?? null),
    keeperHeartbeatTs: prev?.keeperHeartbeatTs ?? null,
    latestChangeIds: prev?.latestChangeIds ?? null,
  };
}

/**
 * Writes one decoded program event (SPEC §2 names) to SQLite. Idempotent: every row is keyed by
 * (signature, event index), so replays from the poller after a live delivery change nothing.
 */
export function applyEvent(store: Store, ctx: TxContext, index: number, ev: CopierEvent, fx: Effects): void {
  const base = { signature: ctx.signature, event_index: index, slot: ctx.slot };
  switch (ev.name) {
    case "CopierRegistered": {
      const d = ev.data;
      store.insertCopier({
        mint: d.mint,
        kind: d.kind,
        launcher: d.launcher,
        vault: vaultPda(new PublicKey(d.mint)).toBase58(),
        targets: JSON.stringify(d.targets),
        trader_bps: d.traderBps,
        created_at: d.ts,
        sharing_config: d.sharingConfig,
        registered_sig: ctx.signature,
      });
      fx.newCopiers.push(d.mint);
      fx.copiers.add(d.mint);
      return;
    }
    case "FeesSynced": {
      const d = ev.data;
      if (store.insertFeeSync({ ...base, ts: d.ts, copier: d.mint, lamports: str(d.lamports), total: str(d.total) })) fx.syncs.push(index);
      fx.copiers.add(d.mint);
      return;
    }
    case "Deposited": {
      const d = ev.data;
      if (store.insertDeposit({ ...base, ts: d.ts, copier: d.mint, from_addr: d.from, lamports: str(d.lamports) })) fx.deposits.push(index);
      fx.copiers.add(d.mint);
      return;
    }
    case "TraderVerified": {
      const d = ev.data;
      const row = store.copier(d.mint);
      if (row) {
        const i = (JSON.parse(row.targets) as string[]).indexOf(d.target);
        if (i >= 0) store.setVerified(d.mint, d.verified ? row.verified | (1 << i) : row.verified & ~(1 << i));
      }
      fx.copiers.add(d.mint);
      return;
    }
    case "CopierBuy": {
      const d = ev.data;
      store.ensureToken(d.tokenMint);
      const inserted = store.insertTrade({
        ...base,
        ts: d.ts,
        copier: d.mint,
        side: "buy",
        target: d.target,
        token_mint: d.tokenMint,
        venue: d.venue,
        sol: str(d.solIn),
        tokens: str(d.tokensOut),
        cost_removed: null,
        pnl: null,
        realized_pnl: null,
        hwm: null,
        forced: 0,
        equity: str(d.equity),
        signal: str(d.signalLamports),
        target_balance: str(d.targetBalance),
        target_sig: ctx.memoTarget,
      });
      if (inserted) fx.trades.push(index);
      fx.copiers.add(d.mint);
      fx.touchPosition(d.mint, d.tokenMint);
      return;
    }
    case "CopierSell": {
      const d = ev.data;
      store.ensureToken(d.tokenMint);
      const inserted = store.insertTrade({
        ...base,
        ts: d.ts,
        copier: d.mint,
        side: "sell",
        target: d.target,
        token_mint: d.tokenMint,
        venue: d.venue,
        sol: str(d.solOut),
        tokens: str(d.tokensIn),
        cost_removed: str(d.costRemoved),
        pnl: str(d.pnl),
        realized_pnl: str(d.realizedPnl),
        hwm: str(d.hwm),
        forced: d.forced ? 1 : 0,
        equity: null,
        signal: null,
        target_balance: null,
        // Forced exits (max hold / permissionless after keeper grace) answer no target trade.
        target_sig: d.forced ? null : ctx.memoTarget,
      });
      if (inserted) fx.trades.push(index);
      fx.copiers.add(d.mint);
      fx.touchPosition(d.mint, d.tokenMint);
      return;
    }
    case "ProfitSplit": {
      const d = ev.data;
      const row = { ...base, ts: d.ts, copier: d.mint, excess: str(d.excess), to_buyback: str(d.toBuyback), to_platform: str(d.toPlatform) };
      if (store.insertProfitSplit(row)) fx.splits.push(index);
      fx.copiers.add(d.mint);
      return;
    }
    case "BuybackBurned": {
      const d = ev.data;
      const row = {
        ...base,
        ts: d.ts,
        kind: "coin" as const,
        copier: d.mint,
        mint: d.mint,
        sol_in: str(d.solIn),
        tokens: str(d.tokensBurned),
        total_burned: str(d.totalBurned),
      };
      if (store.insertBurn(row)) fx.burns.push(index);
      fx.copiers.add(d.mint);
      return;
    }
    case "PlatformBurned": {
      const d = ev.data;
      // `burn_platform` requires `config.platform_mint`, whose `ParamsUpdated` precedes it in chain order.
      const platformMint = readConfig(store)?.platformMint ?? null;
      const row = {
        ...base,
        ts: d.ts,
        kind: "platform" as const,
        copier: platformMint,
        mint: platformMint ?? DEFAULT_PUBKEY,
        sol_in: str(d.solIn),
        tokens: str(d.tokensBurned),
        total_burned: null,
      };
      if (store.insertBurn(row)) fx.burns.push(index);
      fx.config = true;
      return;
    }
    case "ParamsUpdated": {
      store.setState(CONFIG_KEY, JSON.stringify(configFromEvent(ev.data, readConfig(store))));
      fx.config = true;
      return;
    }
    case "IndexTargetsSet": {
      store.setTargets(ev.data.mint, ev.data.targets);
      fx.copiers.add(ev.data.mint);
      fx.targetsChanged = true;
      return;
    }
    case "ChangeProposed": {
      const d = ev.data;
      const id = Number(d.id);
      store.proposeChange({ id, kind: d.kind, proposed_at: d.ts, eta: d.eta, expires_at: d.expiresAt, propose_sig: ctx.signature });
      fx.changes.push({ id, event: "proposed" });
      fx.config = true;
      return;
    }
    case "ChangeExecuted":
    case "ChangeCancelled":
    case "ChangeDiscarded": {
      const d = ev.data;
      const id = Number(d.id);
      const status = ev.name === "ChangeExecuted" ? "executed" : ev.name === "ChangeCancelled" ? "cancelled" : "discarded";
      store.resolveChange({ id, kind: d.kind, status, resolved_at: d.ts, resolve_sig: ctx.signature });
      fx.changes.push({ id, event: status });
      fx.config = true;
      return;
    }
    case "ChangeInvalidated": {
      const d = ev.data;
      const id = Number(d.id);
      store.invalidateChange({ id, kind: d.kind, reason: d.reason, ts: d.ts });
      fx.changes.push({ id, event: "invalidated" });
      fx.config = true;
      return;
    }
    case "KeeperPaused": {
      if (store.insertKeeperPause(ctx.signature, index, ev.data.ts, ev.data.keeper)) fx.pauses.push(ev.data.keeper);
      fx.config = true;
      return;
    }
  }
}
