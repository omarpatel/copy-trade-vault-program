import { isRecord, parsePubkey } from "../sanitize";
import { emptyWallet, type DirectorySourceModule, type SourceWallet } from "./types";
import { label, num, politeFetch, xHandle } from "./util";

/**
 * kolexplorer.com — `GET /search.php?all=1` returns its whole roster in one call (UTF-8 BOM + `{rows: [{id, name,
 * slug, twitter, address, img, profit7d, profit30d, winrate7d}]}`; ~150 KOLs, profits in USD, win rate in percent).
 * robots.txt allows `/`.
 */

const ORIGIN = "https://kolexplorer.com";

export function parseKolexplorer(text: string): SourceWallet[] {
  const json: unknown = JSON.parse(text.replace(/^\uFEFF/, ""));
  const rows = isRecord(json) && Array.isArray(json.rows) ? json.rows : null;
  if (!rows) throw new Error("kolexplorer: no rows in search.php response");
  const out: SourceWallet[] = [];
  rows.forEach((r) => {
    if (!isRecord(r)) return;
    const address = parsePubkey(r.address);
    if (!address) return;
    const w = emptyWallet("kolexplorer", address);
    w.name = label(r.name);
    w.handle = xHandle(r.twitter);
    if (typeof r.img === "string" && /^[\w.-]+\.(?:jpe?g|png|webp|gif)$/i.test(r.img)) w.avatarUrl = `${ORIGIN}/img/${encodeURIComponent(r.img)}`;
    if (typeof r.slug === "string" && /^[\w-]+$/.test(r.slug)) w.url = `${ORIGIN}/kol/${r.slug}`;
    w.stats.pnl7dUsd = num(r.profit7d);
    w.stats.pnl30dUsd = num(r.profit30d);
    const wr = num(r.winrate7d);
    w.stats.winRate7d = wr !== null && wr >= 0 && wr <= 100 ? wr / 100 : null;
    out.push(w);
  });
  // Rank = 30d profit order.
  [...out].sort((a, b) => (b.stats.pnl30dUsd ?? -Infinity) - (a.stats.pnl30dUsd ?? -Infinity)).forEach((w, i) => (w.rank = i + 1));
  return out;
}

export const kolexplorer: DirectorySourceModule = {
  id: "kolexplorer",
  intervalMs: 24 * 3600_000,
  enabled: () => true,
  async fetch(log) {
    const fetchedAt = Math.floor(Date.now() / 1000);
    const wallets = parseKolexplorer(await politeFetch(`${ORIGIN}/search.php?all=1`, { headers: { accept: "application/json" } }));
    log.info({ wallets: wallets.length }, "kolexplorer fetched");
    return { source: "kolexplorer", fetchedAt, wallets };
  },
};
