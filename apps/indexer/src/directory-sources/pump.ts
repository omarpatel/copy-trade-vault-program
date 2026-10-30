import type { TraderStats } from "@copy-trade-vault/sdk/api";
import { cleanImageUrl, isRecord, parsePubkey } from "../sanitize";
import { emptyWallet, type DirectorySourceModule, type SourceWallet } from "./types";
import { count, label, num, politeJson, ratio, xHandle } from "./util";

/**
 * pump.fun's public frontend API (`frontend-api-v3.pump.fun`, no auth; per-route limits in `x-ratelimit-*`, 30–60/min):
 *
 * - `GET /pnl-leaderboard?period=daily|weekly|monthly&sort=combined|realized|unrealized&limit=100` — the in-app PnL
 *   board (hard cap 100 rows/call; 9 calls ≈ 375 unique traders, every row a pump profile with username/avatar/X).
 * - `GET /payouts/leaderboard?page=0..2&pageSize=200` — top 500 callout-reward earners (KOL/caller accounts).
 * - `GET /mayhem/top-traders?window=7d` — 50 wallets with trade count + win rate (mostly bots → HFT tags).
 * - `GET /users?sort=followers&order=DESC&limit=100&offset=N` — profiles by followers (101 rows/page).
 * - `POST /users/batch {addresses: [≤100]}` — profiles of wallets other sources found (followers, avatar, X).
 */

const API = "https://frontend-api-v3.pump.fun";
const HEADERS = { origin: "https://pump.fun", referer: "https://pump.fun/" };
/** ≥ 1 s between calls keeps every route under its 60/min (and the 30/min ones under 30 with retries). */
const GAP_MS = 2_100;
const PERIODS = [
  ["daily", "pnl1dUsd"],
  ["weekly", "pnl7dUsd"],
  ["monthly", "pnl30dUsd"],
] as const satisfies readonly (readonly [string, keyof TraderStats])[];
const SORTS = ["combined", "realized", "unrealized"] as const;
/** Follower-sorted profiles to list (101 per page). */
const SOCIAL_PAGES = 10;
const BATCH = 100;

type PnlPeriod = (typeof PERIODS)[number][0];

function baseWallet(address: string): SourceWallet {
  const w = emptyWallet("pump", address);
  w.url = `https://pump.fun/profile/${address}`;
  return w;
}

export interface PumpPnlRow {
  rank: number;
  address: string;
  pnlUsd: number;
  username: string | null;
  avatar: string | null;
  handle: string | null;
  positions: number | null;
}

export function parsePnlBoard(raw: unknown): PumpPnlRow[] {
  const entries = isRecord(raw) && Array.isArray(raw.entries) ? raw.entries : [];
  const out: PumpPnlRow[] = [];
  for (const e of entries) {
    if (!isRecord(e)) continue;
    const address = parsePubkey(e.walletAddress);
    const rank = count(e.rank);
    const pnlUsd = num(e.pnlUsd);
    if (!address || !rank || pnlUsd === null) continue;
    out.push({
      rank,
      address,
      pnlUsd,
      username: label(e.username),
      avatar: cleanImageUrl(e.profileImage),
      handle: xHandle(e.xUsername),
      positions: count(e.positionsCount),
    });
  }
  return out;
}

/** Callout-payout earners. `twitterUrl` is `x.com/i/user/<id>` (no handle), so only name/avatar are kept. */
export function parsePayouts(raw: unknown): SourceWallet[] {
  const entries = isRecord(raw) && Array.isArray(raw.entries) ? raw.entries : [];
  const out: SourceWallet[] = [];
  for (const e of entries) {
    if (!isRecord(e)) continue;
    const address = parsePubkey(e.walletAddress);
    if (!address) continue;
    const w = baseWallet(address);
    w.name = label(e.username);
    w.avatarUrl = cleanImageUrl(e.profileImageUrl);
    w.tags = ["caller"];
    const paid = num(e.totalPaidUsdc);
    const payouts = count(e.payoutCount);
    if (paid !== null) w.notes = `pump.fun callout rewards: $${Math.round(paid).toLocaleString("en-US")}${payouts ? ` over ${payouts} payouts` : ""}`;
    out.push(w);
  }
  return out;
}

export function parseMayhem(raw: unknown): SourceWallet[] {
  const items = isRecord(raw) && Array.isArray(raw.items) ? raw.items : [];
  const out: SourceWallet[] = [];
  for (const e of items) {
    if (!isRecord(e)) continue;
    const address = parsePubkey(e.address);
    if (!address) continue;
    const w = baseWallet(address);
    w.tags = ["mayhem"];
    w.stats.pnl7dUsd = num(e.realisedPnlUsd);
    w.stats.winRate7d = ratio(e.winRate);
    w.stats.trades7d = count(e.tradeCount);
    out.push(w);
  }
  return out;
}

/** `/users` list and `/users/batch` rows (same profile shape). Non-pump-users and banned profiles are dropped. */
export function parseProfiles(raw: unknown): SourceWallet[] {
  const rows = Array.isArray(raw) ? raw : [];
  const out: SourceWallet[] = [];
  for (const u of rows) {
    if (!isRecord(u) || u.is_pump_user === false || u.is_banned === true) continue;
    const address = parsePubkey(u.canonical_svm_wallet) ?? parsePubkey(u.address);
    if (!address) continue;
    const w = baseWallet(address);
    w.name = label(u.username);
    w.handle = xHandle(u.x_username);
    w.avatarUrl = cleanImageUrl(u.profile_image);
    w.followers = count(u.followers);
    out.push(w);
  }
  return out;
}

export interface PumpBoard {
  period: PnlPeriod;
  sort: (typeof SORTS)[number];
  rows: PumpPnlRow[];
}

/** Folds PnL-board rows into wallets: PnL per window; rank = position on the monthly `combined` board only (the realized/unrealized boards rank by a different number). */
export function pnlWallets(boards: PumpBoard[]): SourceWallet[] {
  const byAddr = new Map<string, SourceWallet>();
  for (const { period, sort, rows } of boards) {
    const key = PERIODS.find(([p]) => p === period)![1];
    for (const r of rows) {
      let w = byAddr.get(r.address);
      if (!w) {
        w = baseWallet(r.address);
        byAddr.set(r.address, w);
      }
      w.name ??= r.username;
      w.handle ??= r.handle;
      w.avatarUrl ??= r.avatar;
      w.stats[key] = r.pnlUsd;
      if (period === "monthly" && sort === "combined") w.rank = r.rank;
    }
  }
  return [...byAddr.values()];
}

/** Later rows only fill what earlier rows left null (board data beats profile lists). */
function mergeInto(into: Map<string, SourceWallet>, rows: SourceWallet[]): void {
  for (const r of rows) {
    const w = into.get(r.address);
    if (!w) {
      into.set(r.address, r);
      continue;
    }
    w.name ??= r.name;
    w.handle ??= r.handle;
    w.avatarUrl ??= r.avatarUrl;
    w.followers ??= r.followers;
    w.notes ??= r.notes;
    for (const k of Object.keys(r.stats) as (keyof TraderStats)[]) w.stats[k] ??= r.stats[k];
    for (const t of r.tags) if (!w.tags.includes(t)) w.tags.push(t);
  }
}

export const pump: DirectorySourceModule = {
  id: "pump",
  intervalMs: 24 * 3600_000,
  enabled: () => true,
  async fetch(log, ctx) {
    const fetchedAt = Math.floor(Date.now() / 1000);
    const get = (path: string) => politeJson(`${API}${path}`, { headers: HEADERS, minGapMs: GAP_MS });
    const boards: PumpBoard[] = [];
    for (const [period] of PERIODS) {
      for (const sort of SORTS) boards.push({ period, sort, rows: parsePnlBoard(await get(`/pnl-leaderboard?period=${period}&sort=${sort}&limit=100&positionsLimit=0`)) });
    }
    const all = new Map<string, SourceWallet>();
    mergeInto(all, pnlWallets(boards));
    for (let page = 0; page < 3; page++) {
      const rows = parsePayouts(await get(`/payouts/leaderboard?page=${page}&pageSize=200`));
      mergeInto(all, rows);
      if (rows.length < 200) break;
    }
    mergeInto(all, parseMayhem(await get(`/mayhem/top-traders?window=7d`)));
    for (let page = 0; page < SOCIAL_PAGES; page++) {
      const rows = parseProfiles(await get(`/users?sort=followers&order=DESC&limit=100&offset=${page * 100}`));
      mergeInto(all, rows);
      if (rows.length === 0) break;
    }
    // Pump profiles (followers, avatar, X) of wallets other sources list but pump's boards didn't.
    const missing = ctx.known.map((k) => k.address).filter((a) => !all.has(a));
    const profiles: SourceWallet[] = [];
    for (let i = 0; i < missing.length; i += BATCH) {
      const body = JSON.stringify({ addresses: missing.slice(i, i + BATCH) });
      const res = await politeJson(`${API}/users/batch`, { method: "POST", body, headers: { ...HEADERS, "content-type": "application/json" }, minGapMs: GAP_MS });
      for (const w of parseProfiles(res)) profiles.push({ ...w, profileOnly: true });
    }
    const wallets = [...all.values(), ...profiles];
    log.info({ boards: boards.length, wallets: all.size, profiles: profiles.length }, "pump fetched");
    return { source: "pump", fetchedAt, wallets };
  },
};
