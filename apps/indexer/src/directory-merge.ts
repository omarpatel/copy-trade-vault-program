import type { DirectorySource, FollowerPlatform, TraderStats } from "@copy-trade-vault/sdk/api";
import { EMPTY_STATS, type SourceWallet } from "./directory-sources/types";

/** Identity precedence: copy-vault's research notes, then pump.fun-owned kolscan, then the boards. */
const IDENTITY_ORDER: readonly DirectorySource[] = ["localnet", "curated", "kolscan", "gmgn", "pump", "kolexplorer", "fomo"];
/** Stats precedence: sources whose numbers cover the wallet's whole activity first. */
const STATS_ORDER: readonly DirectorySource[] = ["kolscan", "gmgn", "pump", "kolexplorer", "fomo", "curated", "localnet"];
/** Avatar precedence: kolscan's curated pfps, then X-backed sources, then pump.fun profile images. */
const AVATAR_ORDER: readonly DirectorySource[] = ["localnet", "kolscan", "gmgn", "kolexplorer", "fomo", "pump", "curated"];
const FOLLOWERS_ON: Partial<Record<DirectorySource, FollowerPlatform>> = { gmgn: "x", kolexplorer: "x", pump: "pump", fomo: "fomo" };

const DAY = 86_400;

/** A merged directory wallet (indexer-internal; views add copy-vault data and avatar URLs). */
export interface MergedWallet {
  address: string;
  name: string;
  handle: string | null;
  displayName: string | null;
  /** Upstream avatar candidates, best first (the avatar cache tries them in order). */
  avatarSources: string[];
  followers: number | null;
  followersOn: FollowerPlatform | null;
  /** Listing sources (profile-only enrichment excluded), in `IDENTITY_ORDER`. */
  sources: DirectorySource[];
  /** Every row describing the wallet, profile-only ones included. */
  rows: SourceWallet[];
  stats: TraderStats;
  tradesPerDay: number | null;
  score: number | null;
  scoreNotes: string[];
  rank: { source: DirectorySource; rank: number } | null;
  tags: string[];
  notes: string | null;
  personId: string;
  walletCount: number;
}

const byOrder = (order: readonly DirectorySource[]) => (a: SourceWallet, b: SourceWallet) => order.indexOf(a.source) - order.indexOf(b.source);

function firstOf<T>(rows: SourceWallet[], pick: (w: SourceWallet) => T | null | undefined): T | null {
  for (const r of rows) {
    const v = pick(r);
    if (v !== null && v !== undefined) return v;
  }
  return null;
}

/** Trades/day over the longest window with a count. */
export function tradesPerDay(s: TraderStats): number | null {
  if (s.trades30d !== null && s.trades30d > 0) return s.trades30d / 30;
  if (s.trades7d !== null) return s.trades7d / 7;
  if (s.trades30d !== null) return 0;
  return null;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const usd = (n: number) => `${n < 0 ? "−" : "+"}$${Math.abs(n) >= 1000 ? `${(Math.abs(n) / 1000).toFixed(Math.abs(n) >= 100_000 ? 0 : 1)}k` : Math.round(Math.abs(n))}`;

/** Win-rate prior: 20 pseudo-trades at 45% (Bayesian shrinkage, from Basket/sniper's smart-money scoring). */
const WR_PRIOR = { n: 20, p: 0.45 };

export interface CopyScore {
  score: number | null;
  notes: string[];
}

/**
 * Copyability 0–100 from what the sources let us observe. A copier vault copies after the fact and on-chain, so the
 * wallets worth copying hold for minutes to days, trade a handful of times a day, and make money steadily.
 *
 * score = 100 × quality × gate:
 * - fidelity f ∈ [0, 1], the worse of: trades/day (1.0 for 0.5–8/day, falling log-linearly to 0 at 100/day) and
 *   average hold (0 at ≤ 30 s, 1.0 at ≥ 4 h). gate = 0.25 + 0.75 f — an HFT wallet can't score well whatever it
 *   earns; unknown fidelity gates at 0.7 so measured wallets lead.
 * - quality, weighted mean of what's known: profit 40% (30d PnL, else 7d, log-scaled: ≤ $0 → 0, ≥ $200k → 1),
 *   consistency 20% (share of reported 1d/7d/30d windows in profit), win rate 25% (shrunk toward 45% by 20
 *   pseudo-trades, then 30% → 0 … 70% → 1), recency 15% (traded ≤ 2 d ago 1.0, ≤ 7 d 0.7, none in 7 d 0.2, unknown
 *   0.5).
 *
 * Null when there's neither fidelity nor any quality signal.
 */
export function copyScore(s: TraderStats, now: number): CopyScore {
  const notes: { weight: number; text: string }[] = [];
  const sorted = () => notes.sort((a, b) => b.weight - a.weight).map((n) => n.text);
  const tpd = tradesPerDay(s);
  const fidelity: number[] = [];
  if (tpd !== null) {
    fidelity.push(tpd > 8 ? clamp01(1 - Math.log10(tpd / 8) / Math.log10(100 / 8)) : tpd >= 0.5 ? 1 : 0.6 + 0.8 * tpd);
    const per = tpd >= 10 ? Math.round(tpd).toString() : tpd.toFixed(1);
    if (tpd > 50) notes.push({ weight: 10, text: `~${per} trades/day — high-frequency, hard to copy` });
    else if (tpd > 8) notes.push({ weight: 5, text: `~${per} trades/day — busy, copies lag` });
    else if (tpd > 0) notes.push({ weight: 4, text: `~${per} trades/day — copyable pace` });
  }
  if (s.avgHoldSecs !== null && s.avgHoldSecs > 0) {
    const h = s.avgHoldSecs;
    fidelity.push(clamp01(Math.log10(h / 30) / Math.log10((4 * 3600) / 30)));
    const text = h < 120 ? `${Math.round(h)}s` : h < 7200 ? `${Math.round(h / 60)}m` : h < 2 * DAY ? `${(h / 3600).toFixed(1)}h` : `${(h / DAY).toFixed(1)}d`;
    notes.push({ weight: h < 60 ? 9 : 3, text: `avg hold ${text}${h < 60 ? " — scalper" : ""}` });
  }
  const f = fidelity.length ? Math.min(...fidelity) : null;

  const parts: { w: number; v: number }[] = [];
  const pnl = s.pnl30dUsd ?? s.pnl7dUsd;
  if (pnl !== null) {
    parts.push({ w: 0.4, v: pnl <= 0 ? 0 : clamp01(Math.log10(1 + pnl / 1000) / Math.log10(201)) });
    notes.push({ weight: pnl > 0 ? 6 : 7, text: `${usd(pnl)} PnL (${s.pnl30dUsd !== null ? "30d" : "7d"})` });
  }
  const windows = [s.pnl1dUsd, s.pnl7dUsd, s.pnl30dUsd].filter((x): x is number => x !== null);
  if (windows.length >= 2) {
    const up = windows.filter((x) => x > 0).length;
    parts.push({ w: 0.2, v: up / windows.length });
    if (up === windows.length) notes.push({ weight: 2, text: `profitable on all ${windows.length} windows` });
  }
  const wr = s.winRate30d ?? s.winRate7d;
  if (wr !== null) {
    const n = (s.winRate30d !== null ? s.trades30d : s.trades7d) ?? 0;
    const shrunk = (wr * n + WR_PRIOR.p * WR_PRIOR.n) / (n + WR_PRIOR.n);
    parts.push({ w: 0.25, v: clamp01((shrunk - 0.3) / 0.4) });
    notes.push({ weight: 1, text: `${Math.round(wr * 100)}% win rate` });
  }
  if (!parts.length && f === null) return { score: null, notes: sorted() };
  if (parts.length) {
    const inactive = s.trades7d === 0;
    const age = s.lastActiveTs === null ? null : now - s.lastActiveTs;
    parts.push({ w: 0.15, v: age !== null && age <= 2 * DAY ? 1 : age !== null && age <= 7 * DAY ? 0.7 : inactive ? 0.2 : 0.5 });
    if (inactive) notes.push({ weight: 8, text: "no trades in the last 7 days" });
  }
  const quality = parts.length ? parts.reduce((a, p) => a + p.w * p.v, 0) / parts.reduce((a, p) => a + p.w, 0) : 0.5;
  const gate = f === null ? 0.7 : 0.25 + 0.75 * f;
  return { score: Math.round(100 * quality * gate), notes: sorted() };
}

function mergeStats(rows: SourceWallet[]): TraderStats {
  const out: TraderStats = { ...EMPTY_STATS };
  for (const k of Object.keys(out) as (keyof TraderStats)[]) {
    out[k] = k === "lastActiveTs" ? rows.reduce<number | null>((m, r) => (r.stats.lastActiveTs !== null && r.stats.lastActiveTs > (m ?? 0) ? r.stats.lastActiveTs : m), null) : firstOf(rows, (r) => r.stats[k]);
  }
  return out;
}

/** Groups every source's rows by address, merges identity/stats, scores, and links wallets of one person. */
export function mergeDirectory(all: SourceWallet[], now: number): MergedWallet[] {
  const byAddr = new Map<string, SourceWallet[]>();
  for (const r of all) {
    const list = byAddr.get(r.address);
    if (list) list.push(r);
    else byAddr.set(r.address, [r]);
  }
  const out: MergedWallet[] = [];
  for (const [address, rows] of byAddr) {
    const listed = rows.filter((r) => !r.profileOnly);
    if (!listed.length) continue;
    const identity = [...rows].sort(byOrder(IDENTITY_ORDER));
    const statsRows = [...listed].sort(byOrder(STATS_ORDER));
    const handle = firstOf(identity, (r) => r.handle);
    const name = firstOf(identity, (r) => r.name) ?? (handle ? `@${handle}` : `${address.slice(0, 4)}…${address.slice(-4)}`);
    let followers: number | null = null;
    let followersOn: FollowerPlatform | null = null;
    // X followers beat in-app ones; within a platform, the largest count wins. A count of 0 is a source's "never
    // fetched" placeholder (GMGN), not data: it must not hide a real count on another platform.
    for (const platform of ["x", "pump", "fomo"] as const) {
      for (const r of rows) if (FOLLOWERS_ON[r.source] === platform && r.followers && r.followers > (followers ?? -1)) followers = r.followers;
      if (followers !== null) {
        followersOn = platform;
        break;
      }
    }
    const stats = mergeStats(statsRows);
    const { score, notes: scoreNotes } = copyScore(stats, now);
    const tpd = tradesPerDay(stats);
    const tags = new Set(rows.flatMap((r) => r.tags));
    if (tpd !== null && tpd > 50) tags.add("hft");
    if (stats.avgHoldSecs !== null && stats.avgHoldSecs < 60) tags.add("hft");
    if (tpd !== null && tpd > 0 && tpd <= 3 && !tags.has("hft")) tags.add("low-frequency");
    if (stats.trades7d === 0) tags.add("inactive");
    let rank: MergedWallet["rank"] = null;
    for (const r of [...listed].sort(byOrder(IDENTITY_ORDER))) if (r.rank !== null && (rank === null || r.rank < rank.rank)) rank = { source: r.source, rank: r.rank };
    out.push({
      address,
      name,
      handle,
      displayName: firstOf(identity, (r) => (r.displayName && r.displayName !== name ? r.displayName : null)),
      avatarSources: [...new Set([...rows].sort(byOrder(AVATAR_ORDER)).flatMap((r) => (r.avatarUrl ? [r.avatarUrl] : [])))],
      followers,
      followersOn,
      sources: [...new Set(identity.filter((r) => !r.profileOnly).map((r) => r.source))],
      rows: identity,
      stats,
      tradesPerDay: tpd,
      score,
      scoreNotes,
      rank,
      tags: [...tags].sort(),
      notes: firstOf(identity, (r) => r.notes),
      personId: handle ? handle.toLowerCase() : address,
      walletCount: 1,
    });
  }
  const perPerson = new Map<string, number>();
  for (const w of out) perPerson.set(w.personId, (perPerson.get(w.personId) ?? 0) + 1);
  for (const w of out) {
    w.walletCount = perPerson.get(w.personId)!;
    if (w.walletCount > 1) w.tags = [...w.tags, "multi-wallet"].sort();
  }
  return out;
}
