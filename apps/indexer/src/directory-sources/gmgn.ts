import { cleanImageUrl, isRecord, parsePubkey } from "../sanitize";
import { emptyWallet, type DirectorySourceModule, type SourceWallet } from "./types";
import { count, label, num, politeJson, ratio, unixSecs, xHandle } from "./util";

/**
 * GMGN's wallet rankings (gmgn.ai's own web API; undocumented, no auth, Cloudflare bot management):
 *
 * - `GET /defi/quotation/v1/rank/sol/wallets/{1d|7d|30d}?tag=…&orderby=…&direction=desc|asc` — ≤ 100 rows per call,
 *   no pagination; more wallets come from the union over periods × tags × orderings (~45 calls ≈ 1–1.2k wallets).
 *   Rows carry X identity (`twitter_username`, `twitter_name`, `avatar`), realized profit (USD), win rate, swap counts,
 *   average holding period and last activity.
 * - `GET /defi/quotation/v1/smartmoney/sol/walletNew/{address}?period=7d` — one wallet; gives X followers
 *   (`twitter_fans_num`). Used for a rotating subset per run (carried forward between runs).
 *
 * Cloudflare blocks Node's TLS fingerprint (403 + an IP challenge for a few minutes), so requests go through the
 * system `curl`, ≥ 3.5 s apart.
 */

const API = "https://gmgn.ai/defi/quotation/v1";
const GAP_MS = 3_500;
const HEADERS = { referer: "https://gmgn.ai/", accept: "application/json" };
const PERIODS = ["1d", "7d", "30d"] as const;
const TAGS = ["renowned", "smart_degen", "pump_smart", "launchpad_smart", "top_followed", "fresh_wallet", "top_renamed"] as const;
/** Wallets enriched with X followers per run (≈ 3.5 s each). */
const ENRICH_PER_RUN = Number(process.env.DIRECTORY_GMGN_ENRICH ?? 150);

type Period = (typeof PERIODS)[number];

/** GMGN row tags worth surfacing, mapped to directory tags. */
const TAG_MAP: Record<string, string> = {
  kol: "kol",
  renowned: "kol",
  smart_degen: "smart-money",
  pump_smart: "smart-money",
  launchpad_smart: "smart-money",
  snipe_bot: "bot",
  sandwich_bot: "bot",
  fresh_wallet: "fresh-wallet",
};

export function gmgnQueries(): { path: string; rankBoard: boolean }[] {
  const out: { path: string; rankBoard: boolean }[] = [];
  for (const p of PERIODS) for (const tag of TAGS) out.push({ path: `/rank/sol/wallets/${p}?tag=${tag}&orderby=pnl_${p}&direction=desc`, rankBoard: p === "30d" && tag === "renowned" });
  // Orderings that surface different wallets: steadier win rates, the most-followed, the lowest-frequency.
  for (const p of ["7d", "30d"] as const) {
    for (const tag of ["renowned", "smart_degen", "pump_smart"] as const) {
      out.push({ path: `/rank/sol/wallets/${p}?tag=${tag}&orderby=winrate_${p}&direction=desc`, rankBoard: false });
      out.push({ path: `/rank/sol/wallets/${p}?tag=${tag}&orderby=txs_${p}&direction=asc`, rankBoard: false });
    }
    out.push({ path: `/rank/sol/wallets/${p}?tag=renowned&orderby=follow_count&direction=desc`, rankBoard: false });
  }
  return out;
}

/** One rank response → wallets (row order = board rank). */
export function parseGmgnRank(raw: unknown): SourceWallet[] {
  const data = isRecord(raw) && isRecord(raw.data) ? raw.data : null;
  const rows = data && Array.isArray(data.rank) ? data.rank : [];
  const out: SourceWallet[] = [];
  for (const r of rows) {
    if (!isRecord(r)) continue;
    const address = parsePubkey(r.address) ?? parsePubkey(r.wallet_address);
    if (!address) continue;
    const w = emptyWallet("gmgn", address);
    w.url = `https://gmgn.ai/sol/address/${address}`;
    w.handle = xHandle(r.twitter_username);
    w.displayName = label(r.twitter_name);
    w.name = label(r.name) ?? label(r.nickname) ?? w.displayName;
    w.avatarUrl = cleanImageUrl(r.avatar);
    const s = w.stats;
    s.pnl1dUsd = num(r.realized_profit_1d);
    s.pnl7dUsd = num(r.realized_profit_7d);
    s.pnl30dUsd = num(r.realized_profit_30d);
    s.winRate7d = ratio(r.winrate_7d);
    s.winRate30d = ratio(r.winrate_30d);
    s.trades7d = count(r.txs_7d) ?? (count(r.buy_7d) !== null && count(r.sell_7d) !== null ? count(r.buy_7d)! + count(r.sell_7d)! : null);
    s.trades30d = count(r.txs_30d) ?? (count(r.buy_30d) !== null && count(r.sell_30d) !== null ? count(r.buy_30d)! + count(r.sell_30d)! : null);
    const hold = num(r.avg_holding_period_30d) ?? num(r.avg_holding_period_7d);
    s.avgHoldSecs = hold !== null && hold > 0 ? Math.round(hold) : null;
    s.lastActiveTs = unixSecs(r.last_active);
    const tags = Array.isArray(r.tags) ? r.tags : [];
    w.tags = [...new Set(tags.flatMap((t) => (typeof t === "string" && TAG_MAP[t] ? [TAG_MAP[t]] : [])))];
    out.push(w);
  }
  return out;
}

export interface GmgnWalletDetail {
  followers: number | null;
  handle: string | null;
  displayName: string | null;
  avatar: string | null;
}

/** `walletNew` detail → X followers / identity, or null. */
export function parseGmgnWallet(raw: unknown): GmgnWalletDetail | null {
  const d = isRecord(raw) && isRecord(raw.data) ? raw.data : null;
  if (!d) return null;
  // GMGN reports 0 for wallets whose X stats it never fetched (real accounts it lists have followers): unknown, not 0.
  const followers = count(d.twitter_fans_num);
  return { followers: followers === 0 ? null : followers, handle: xHandle(d.twitter_username), displayName: label(d.twitter_name), avatar: cleanImageUrl(d.avatar) };
}

/** Field-wise merge of the same wallet seen on several boards: first non-null wins, tags union. */
function fold(into: SourceWallet, r: SourceWallet): void {
  into.name ??= r.name;
  into.handle ??= r.handle;
  into.displayName ??= r.displayName;
  into.avatarUrl ??= r.avatarUrl;
  for (const k of Object.keys(r.stats) as (keyof SourceWallet["stats"])[]) into.stats[k] ??= r.stats[k];
  for (const t of r.tags) if (!into.tags.includes(t)) into.tags.push(t);
}

export const gmgn: DirectorySourceModule = {
  id: "gmgn",
  intervalMs: 24 * 3600_000,
  enabled: () => process.env.DIRECTORY_GMGN !== "off",
  async fetch(log, ctx) {
    const fetchedAt = Math.floor(Date.now() / 1000);
    const get = (path: string) => politeJson(`${API}${path}`, { headers: HEADERS, minGapMs: GAP_MS, transport: "curl" });
    const all = new Map<string, SourceWallet>();
    let failures = 0;
    const queries = gmgnQueries();
    for (const q of queries) {
      let rows: SourceWallet[];
      try {
        rows = parseGmgnRank(await get(q.path));
      } catch (err) {
        // One blocked board shouldn't sink the run; a fully blocked run throws below.
        failures++;
        log.warn({ path: q.path, err: String(err) }, "gmgn board failed");
        if (failures >= 3 && all.size === 0) throw err;
        continue;
      }
      rows.forEach((r, i) => {
        if (q.rankBoard) r.rank = i + 1;
        const w = all.get(r.address);
        if (!w) all.set(r.address, r);
        else {
          fold(w, r);
          w.rank ??= r.rank;
        }
      });
    }
    if (all.size === 0) throw new Error("gmgn: every board failed");
    // Cloudflare's IP challenge can start mid-run and fail every remaining board: a mostly-blocked run would replace
    // the full list with a fraction of it (and stamp it fresh for 24 h). Keep the previous list instead.
    if (failures > queries.length / 3) {
      throw new Error(`gmgn: ${failures} of ${queries.length} boards failed (refusing to replace the previous list with ${all.size} wallets)`);
    }

    // X followers: carry the last run's forward, then refresh a rotating subset (unknown first).
    const previous = new Map(ctx.previous.map((w) => [w.address, w]));
    const profiles = new Map<string, SourceWallet>();
    for (const p of ctx.previous) {
      if (p.followers === null) continue;
      const w = all.get(p.address);
      if (w) w.followers = p.followers;
      else if (p.profileOnly) profiles.set(p.address, p);
    }
    const knownHandle = ctx.known.filter((k) => k.handle);
    const candidates = [...new Set([...knownHandle.map((k) => k.address), ...[...all.values()].filter((w) => w.handle).map((w) => w.address)])];
    // Unknown follower counts first, each group rotated by day: wallets whose lookup keeps failing (nothing is stored
    // for them) can't pin the same ENRICH_PER_RUN slots forever, so every candidate is tried across runs.
    const unknown: string[] = [];
    const known: string[] = [];
    for (const a of candidates) ((previous.get(a)?.followers ?? null) === null ? unknown : known).push(a);
    const day = Math.floor(fetchedAt / 86_400);
    const rotate = (xs: string[]) => (xs.length ? [...xs.slice((day * ENRICH_PER_RUN) % xs.length), ...xs.slice(0, (day * ENRICH_PER_RUN) % xs.length)] : xs);
    let enriched = 0;
    for (const address of [...rotate(unknown), ...rotate(known)].slice(0, ENRICH_PER_RUN)) {
      let detail: GmgnWalletDetail | null;
      try {
        detail = parseGmgnWallet(await get(`/smartmoney/sol/walletNew/${address}?period=7d`));
      } catch (err) {
        log.warn({ address, err: String(err) }, "gmgn wallet detail failed");
        continue;
      }
      if (!detail) continue;
      enriched++;
      const listed = all.get(address);
      if (listed) {
        listed.followers = detail.followers ?? listed.followers;
        listed.handle ??= detail.handle;
        listed.displayName ??= detail.displayName;
        listed.avatarUrl ??= detail.avatar;
      } else if (detail.handle || detail.followers !== null) {
        const p = emptyWallet("gmgn", address);
        Object.assign(p, { handle: detail.handle, displayName: detail.displayName, avatarUrl: detail.avatar, followers: detail.followers, profileOnly: true });
        p.url = `https://gmgn.ai/sol/address/${address}`;
        profiles.set(address, p);
      }
    }
    const wallets = [...all.values(), ...profiles.values()];
    log.info({ boards: queries.length, failures, wallets: all.size, enriched, profiles: profiles.size }, "gmgn fetched");
    return { source: "gmgn", fetchedAt, wallets };
  },
};
