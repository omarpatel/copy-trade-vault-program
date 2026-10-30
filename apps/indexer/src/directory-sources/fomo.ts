import type { TraderStats } from "@copy-trade-vault/sdk/api";
import { cleanImageUrl, isRecord, parsePubkey } from "../sanitize";
import { emptyWallet, type DirectorySourceModule, type SourceWallet } from "./types";
import { count, label, num, politeJson } from "./util";

/**
 * FOMO (fomo.family) top traders. FOMO's own API (`prod-api.fomo.family/v2/leaderboard/{24h|7d|30d}`) needs a Privy
 * login token (email/SMS/OAuth only) and its terms ban automated access, so the directory reads FOMO's boards through
 * fomoapi.io, a keyed third-party copier: `GET https://api.fomoapi.io/v2/leaderboard/{24h|7d|30d|all}?limit=150`
 * (`authorization: Bearer <key>`, 250 credits/call; free key = 250k credits/month). Response: `{traders: [{rank,
 * handle, userId, displayName, pnlUsd, volumeUsd, trades, followers, wallets: {solana, evm}, verified}]}`.
 *
 * Enabled only when `FOMOAPI_KEY` is set.
 */

const API = "https://api.fomoapi.io/v2";
const WINDOWS = [
  ["24h", "pnl1dUsd"],
  ["7d", "pnl7dUsd"],
  ["30d", "pnl30dUsd"],
] as const satisfies readonly (readonly [string, keyof TraderStats])[];

/** Solana wallet(s) of a FOMO trader row: `wallets.solana` (string or list) or a flat `solana`. */
function solanaWallets(t: Record<string, unknown>): string[] {
  const raw = isRecord(t.wallets) ? t.wallets.solana : t.solana;
  const list = Array.isArray(raw) ? raw : [raw];
  return list.flatMap((a) => {
    const pk = parsePubkey(a);
    return pk ? [pk] : [];
  });
}

/** One leaderboard window → wallets (every Solana wallet of a trader gets a row). */
export function parseFomoBoard(raw: unknown, window: (typeof WINDOWS)[number][0]): SourceWallet[] {
  const traders = isRecord(raw) && Array.isArray(raw.traders) ? raw.traders : [];
  const key = WINDOWS.find(([w]) => w === window)![1];
  const out: SourceWallet[] = [];
  for (const t of traders) {
    if (!isRecord(t)) continue;
    const handle = typeof t.handle === "string" && /^[\w.]{1,32}$/.test(t.handle) ? t.handle : null;
    for (const address of solanaWallets(t)) {
      const w = emptyWallet("fomo", address);
      w.name = label(t.displayName) ?? handle;
      w.avatarUrl = cleanImageUrl(t.avatar ?? t.profilePicture ?? t.image);
      w.followers = count(t.followers);
      w.url = handle ? `https://fomo.family/u/${handle}` : null;
      w.rank = window === "30d" ? count(t.rank) : null;
      w.stats[key] = num(t.pnlUsd);
      if (window === "7d") w.stats.trades7d = count(t.trades);
      if (window === "30d") w.stats.trades30d = count(t.trades);
      w.notes = handle ? `FOMO @${handle}` : null;
      out.push(w);
    }
  }
  return out;
}

export const fomo: DirectorySourceModule = {
  id: "fomo",
  intervalMs: 24 * 3600_000,
  enabled: () => Boolean(process.env.FOMOAPI_KEY),
  async fetch(log) {
    const fetchedAt = Math.floor(Date.now() / 1000);
    const headers = { authorization: `Bearer ${process.env.FOMOAPI_KEY}` };
    const all = new Map<string, SourceWallet>();
    for (const [window] of WINDOWS) {
      for (const w of parseFomoBoard(await politeJson(`${API}/leaderboard/${window}?limit=150`, { headers, minGapMs: 3_500 }), window)) {
        const prev = all.get(w.address);
        if (!prev) {
          all.set(w.address, w);
          continue;
        }
        for (const k of Object.keys(w.stats) as (keyof TraderStats)[]) prev.stats[k] ??= w.stats[k];
        prev.rank ??= w.rank;
        prev.followers ??= w.followers;
        prev.avatarUrl ??= w.avatarUrl;
      }
    }
    log.info({ wallets: all.size }, "fomo fetched");
    return { source: "fomo", fetchedAt, wallets: [...all.values()] };
  },
};
