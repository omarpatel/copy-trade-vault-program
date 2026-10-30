import type { DirectorySort, DirectorySource, FeedItem, Health } from "@copy-trade-vault/sdk/api";
import type { FastifyInstance } from "fastify";
import { RANGES, type RangeKey } from "./aggregate";
import { NotFoundError, parsePubkey, ValidationError } from "./sanitize";
import { CANDLE_INTERVALS, type Views } from "./views";

export interface RouteDeps {
  views: Views;
  health: () => Promise<Health>;
}

const SORTS: Record<string, "pnl" | "tvl" | "new" | "fees"> = { pnl: "pnl", tvl: "tvl", new: "new", fees: "fees" };
const DIRECTORY_SORTS: Record<DirectorySort, true> = { score: true, pnl30d: true, pnl7d: true, pnl1d: true, winrate: true, followers: true, copiers: true, rank: true };
const DIRECTORY_SOURCE_IDS: Record<DirectorySource, true> = { kolscan: true, pump: true, gmgn: true, kolexplorer: true, fomo: true, curated: true, localnet: true };
const KINDS: Record<string, "single" | "index"> = { single: "single", index: "index" };
const FEED_TYPES: Record<FeedItem["type"], true> = { copy: true, burn: true, launch: true, fees: true, profit: true };

type Query = Record<string, string | undefined>;

/** Own-key table lookup: inherited names (`valueOf`, `__proto__`, …) and non-strings are never valid. */
function own<T>(table: Record<string, T>, key: unknown): key is string {
  return typeof key === "string" && Object.hasOwn(table, key);
}

function limitOf(q: Query, fallback = 50, max = 200): number {
  if (q.limit === undefined || q.limit === "") return fallback;
  const n = Number(q.limit);
  if (!Number.isInteger(n) || n < 1 || n > max) throw new ValidationError(`limit must be an integer in 1..${max}`);
  return n;
}

function pubkeyParam(raw: string | undefined, label: string): string {
  const pk = parsePubkey(raw);
  if (!pk) throw new ValidationError(`${label} must be a base58 public key`);
  return pk;
}

function rangeOf(q: Query, fallback: RangeKey): RangeKey {
  const r = q.range ?? fallback;
  if (!own(RANGES, r)) throw new ValidationError(`range must be one of ${Object.keys(RANGES).join(", ")}`);
  return r as RangeKey;
}

/** The read-only JSON API (SPEC §5); uploads, ingest and `/ws` are registered by the server. */
export function registerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { views } = deps;
  const copierOf = (raw: string | undefined) => {
    const mint = pubkeyParam(raw, "mint");
    if (!views.summary(mint)) throw new NotFoundError(`copier ${mint} is not indexed`);
    return mint;
  };

  app.get("/api/health", async (_req, reply) => {
    const h = await deps.health();
    return reply.code(h.ok ? 200 : 503).send(h);
  });

  app.get("/api/stats", async () => views.stats());

  app.get<{ Querystring: Query }>("/api/copiers", async (req) => {
    const sortRaw = req.query.sort ?? "pnl";
    if (!own(SORTS, sortRaw)) throw new ValidationError("sort must be pnl, tvl, new or fees");
    const sort = SORTS[sortRaw]!;
    const kindRaw = req.query.kind;
    if (kindRaw !== undefined && !own(KINDS, kindRaw)) throw new ValidationError("kind must be single or index");
    const kind = kindRaw !== undefined ? KINDS[kindRaw]! : null;
    const q = req.query.q?.trim() ? req.query.q.trim().slice(0, 64) : null;
    return views.list({ sort, kind: kind ?? null, q });
  });

  app.get<{ Params: { mint: string } }>("/api/copiers/:mint", async (req) => {
    const detail = views.detail(copierOf(req.params.mint));
    if (!detail) throw new NotFoundError("copier not indexed");
    return detail;
  });

  app.get<{ Params: { mint: string } }>("/api/copiers/:mint/positions", async (req) => views.positions(copierOf(req.params.mint)) ?? []);

  app.get<{ Params: { mint: string }; Querystring: Query }>("/api/copiers/:mint/copies", async (req) =>
    views.copies(copierOf(req.params.mint), limitOf(req.query)),
  );

  app.get<{ Params: { mint: string }; Querystring: Query }>("/api/copiers/:mint/trades", async (req) =>
    views.trades(copierOf(req.params.mint), limitOf(req.query)),
  );

  app.get<{ Params: { mint: string }; Querystring: Query }>("/api/copiers/:mint/equity", async (req) => {
    const range = rangeOf(req.query, "7d");
    return views.equity(copierOf(req.params.mint), range);
  });

  app.get<{ Params: { mint: string }; Querystring: Query }>("/api/copiers/:mint/candles", async (req) => {
    const interval = CANDLE_INTERVALS.find((i) => String(i) === (req.query.interval ?? "60"));
    if (!interval) throw new ValidationError(`interval must be one of ${CANDLE_INTERVALS.join(", ")} (seconds)`);
    const range = rangeOf(req.query, "24h");
    return views.candles(copierOf(req.params.mint), interval, range);
  });

  app.get<{ Querystring: Query }>("/api/copies", async (req) => views.copies(null, limitOf(req.query)));

  app.get<{ Querystring: Query }>("/api/traders", async (req) => {
    const q = req.query;
    const sort = (q.sort ?? "score") as DirectorySort;
    if (!own(DIRECTORY_SORTS, sort)) throw new ValidationError(`sort must be one of ${Object.keys(DIRECTORY_SORTS).join(", ")}`);
    const sources = (q.source ?? "").split(",").filter(Boolean) as DirectorySource[];
    const badSource = sources.find((s) => !own(DIRECTORY_SOURCE_IDS, s));
    if (badSource) throw new ValidationError(`source must be a comma list of ${Object.keys(DIRECTORY_SOURCE_IDS).join(", ")}`);
    const tags = (q.tag ?? "").split(",").filter(Boolean).slice(0, 8);
    if (tags.some((t) => !/^-?[a-z0-9-]{1,32}$/.test(t))) throw new ValidationError("tag must be a comma list of tags (prefix - to exclude)");
    const offset = q.offset === undefined || q.offset === "" ? 0 : Number(q.offset);
    if (!Number.isInteger(offset) || offset < 0 || offset > 100_000) throw new ValidationError("offset must be an integer in 0..100000");
    return views.directoryList({ q: q.q?.trim().slice(0, 64) || null, sources, tags, sort, offset, limit: limitOf(q, 50, 200) });
  });

  app.get<{ Params: { address: string } }>("/api/traders/:address", async (req) => views.traderProfile(pubkeyParam(req.params.address, "address")));

  app.get<{ Querystring: Query }>("/api/burns", async (req) => {
    const kindRaw = req.query.kind;
    if (kindRaw && kindRaw !== "coin" && kindRaw !== "platform") throw new ValidationError("kind must be coin or platform");
    const copier = req.query.mint ? pubkeyParam(req.query.mint, "mint") : undefined;
    return views.burns({ copier, kind: kindRaw as "coin" | "platform" | undefined, limit: limitOf(req.query) });
  });

  app.get<{ Querystring: Query }>("/api/feed", async (req) => {
    const mint = req.query.mint ? pubkeyParam(req.query.mint, "mint") : null;
    const types = new Set<FeedItem["type"]>();
    for (const t of (req.query.types ?? Object.keys(FEED_TYPES).join(",")).split(",")) {
      const type = t.trim();
      if (!type) continue;
      if (!own(FEED_TYPES, type)) throw new ValidationError(`types must be a comma list of ${Object.keys(FEED_TYPES).join(", ")}`);
      types.add(type as FeedItem["type"]);
    }
    return views.feed({ mint, types, limit: limitOf(req.query) });
  });

  app.get("/api/platform-token", async () => views.platformToken());

  app.get("/api/governance", async () => views.governance());
}
