import { cleanImageUrl, isRecord, parsePubkey } from "../sanitize";
import { emptyWallet, type DirectorySourceModule, type SourceWallet } from "./types";
import { count, label, num, politeFetch, xHandle } from "./util";

/**
 * kolscan.io (pump.fun-owned KOL tracker).
 *
 * - `GET /leaderboard` server-renders a Next.js flight payload holding the whole KOL directory (`initialData`:
 *   `wallet_address`, `name`, `pfp`, `twitter`, `telegram` — ~570 wallets), the SOL price (`priceData.SOL`) and page 0
 *   of the daily/weekly/monthly leaderboards (`initLeaderboard`, 50 rows each: `profit` in SOL, `wins`, `losses`).
 * - `POST /api/leaderboard {timeframe: 1|7|30, page: 1.., pageSize: 50}` returns the following pages. Cloudflare
 *   rejects it (HTTP 400 "Forbidden") unless the request looks like the site's own fetch: same-origin `Origin` /
 *   `Referer` / `sec-fetch-*` headers and a `user-session` cookie (a client-generated UUID, as the site's JS does).
 */

const ORIGIN = "https://kolscan.io";
const PAGE_SIZE = 50;
const MAX_PAGES = 40;
export const KOLSCAN_TIMEFRAMES = [1, 7, 30] as const;
type Timeframe = (typeof KOLSCAN_TIMEFRAMES)[number];

export interface KolscanKol {
  address: string;
  name: string | null;
  handle: string | null;
  pfp: string | null;
}

export interface KolscanRow {
  address: string;
  name: string | null;
  handle: string | null;
  profitSol: number;
  wins: number;
  losses: number;
  timeframe: Timeframe;
}

export interface KolscanPage {
  solUsd: number | null;
  kols: KolscanKol[];
  rows: KolscanRow[];
}

/** Concatenated `self.__next_f.push([1, "…"])` strings of a Next.js app-router page. */
export function nextFlight(html: string): string {
  let out = "";
  for (const m of html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)) out += JSON.parse(m[1]!) as string;
  return out;
}

/** The JSON value following `"key":` in a flight payload (first occurrence), or undefined. */
export function flightValue(flight: string, key: string): unknown {
  const at = flight.indexOf(`"${key}":`);
  if (at < 0) return undefined;
  const start = at + key.length + 3;
  // Scan one balanced JSON value (object/array/scalar), respecting strings.
  let depth = 0;
  let inStr = false;
  for (let i = start; i < flight.length; i++) {
    const c = flight[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      if (depth === 0) return JSON.parse(flight.slice(start, i)) as unknown;
      depth--;
      if (depth === 0) return JSON.parse(flight.slice(start, i + 1)) as unknown;
    } else if (c === "," && depth === 0) return JSON.parse(flight.slice(start, i)) as unknown;
  }
  return undefined;
}

export function parseKolscanRows(raw: unknown): KolscanRow[] {
  if (!Array.isArray(raw)) return [];
  const out: KolscanRow[] = [];
  for (const r of raw) {
    if (!isRecord(r)) continue;
    const address = parsePubkey(r.wallet_address);
    const timeframe = KOLSCAN_TIMEFRAMES.find((t) => t === r.timeframe);
    const profitSol = num(r.profit);
    if (!address || !timeframe || profitSol === null) continue;
    out.push({ address, name: label(r.name), handle: xHandle(r.twitter), profitSol, wins: count(r.wins) ?? 0, losses: count(r.losses) ?? 0, timeframe });
  }
  return out;
}

/** Parses the `/leaderboard` HTML. Throws when the directory is missing (layout change → fail loudly, keep old data). */
export function parseKolscanPage(html: string): KolscanPage {
  const flight = nextFlight(html);
  const initial = flightValue(flight, "initialData");
  if (!Array.isArray(initial) || initial.length === 0) throw new Error("kolscan: initialData directory not found in /leaderboard");
  const kols: KolscanKol[] = [];
  for (const k of initial) {
    if (!isRecord(k)) continue;
    const address = parsePubkey(k.wallet_address);
    if (!address) continue;
    kols.push({ address, name: label(k.name), handle: xHandle(k.twitter), pfp: cleanImageUrl(k.pfp) });
  }
  const price = flightValue(flight, "priceData");
  const solUsd = isRecord(price) ? num(price.SOL) : null;
  return { solUsd: solUsd !== null && solUsd > 0 ? solUsd : null, kols, rows: parseKolscanRows(flightValue(flight, "initLeaderboard")) };
}

/** Joins the directory with leaderboard rows into normalized wallets (USD PnL at the page's SOL price). */
export function kolscanWallets(page: KolscanPage, fetchedAt: number): SourceWallet[] {
  const byAddr = new Map<string, SourceWallet>();
  const walletOf = (address: string): SourceWallet => {
    let w = byAddr.get(address);
    if (!w) {
      w = emptyWallet("kolscan", address);
      w.url = `${ORIGIN}/account/${address}`;
      byAddr.set(address, w);
    }
    return w;
  };
  for (const k of page.kols) {
    const w = walletOf(k.address);
    w.name = k.name;
    w.handle = k.handle;
    w.avatarUrl = k.pfp;
  }
  // Dedupe rows per (timeframe, address): pages can overlap if the board shifts mid-crawl; keep the first.
  const seen = new Set<string>();
  const rankable: Record<Timeframe, KolscanRow[]> = { 1: [], 7: [], 30: [] };
  for (const r of page.rows) {
    const key = `${r.timeframe}:${r.address}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rankable[r.timeframe].push(r);
    const w = walletOf(r.address);
    w.name ??= r.name;
    w.handle ??= r.handle;
    const usd = page.solUsd === null ? null : r.profitSol * page.solUsd;
    const n = r.wins + r.losses;
    const winRate = n > 0 ? r.wins / n : null;
    if (r.timeframe === 1) {
      w.stats.pnl1dUsd = usd;
      if (n > 0) w.stats.lastActiveTs = fetchedAt;
    } else if (r.timeframe === 7) {
      w.stats.pnl7dUsd = usd;
      w.stats.trades7d = n;
      w.stats.winRate7d = winRate;
    } else {
      w.stats.pnl30dUsd = usd;
      w.stats.trades30d = n;
      w.stats.winRate30d = winRate;
    }
  }
  // Rank = position on the monthly board by profit (kolscan's default ordering), among wallets that traded.
  const monthly = rankable[30].filter((r) => r.wins + r.losses > 0).sort((a, b) => b.profitSol - a.profitSol);
  monthly.forEach((r, i) => (walletOf(r.address).rank = i + 1));
  return [...byAddr.values()];
}

const API_HEADERS = (session: string) => ({
  "content-type": "application/json",
  origin: ORIGIN,
  referer: `${ORIGIN}/leaderboard`,
  cookie: `user-session=${session}`,
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "same-origin",
});

export const kolscan: DirectorySourceModule = {
  id: "kolscan",
  intervalMs: 6 * 3600_000,
  enabled: () => true,
  async fetch(log) {
    const fetchedAt = Math.floor(Date.now() / 1000);
    const page = parseKolscanPage(await politeFetch(`${ORIGIN}/leaderboard`, { headers: { accept: "text/html" } }));
    const session = crypto.randomUUID();
    for (const timeframe of KOLSCAN_TIMEFRAMES) {
      for (let p = 1; p <= MAX_PAGES; p++) {
        const body = await politeFetch(`${ORIGIN}/api/leaderboard`, {
          method: "POST",
          headers: API_HEADERS(session),
          body: JSON.stringify({ timeframe, page: p, pageSize: PAGE_SIZE }),
          minGapMs: 500,
        });
        const json: unknown = JSON.parse(body);
        const rows = parseKolscanRows(isRecord(json) ? json.data : null);
        page.rows.push(...rows);
        if (rows.length < PAGE_SIZE) break;
      }
    }
    const wallets = kolscanWallets(page, fetchedAt);
    log.info({ kols: page.kols.length, rows: page.rows.length, wallets: wallets.length }, "kolscan fetched");
    return { source: "kolscan", fetchedAt, wallets };
  },
};
