import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DirectorySort, DirectorySource } from "@copy-trade-vault/sdk/api";
import { AvatarCache } from "./avatars";
import type { Store } from "./db";
import { mergeDirectory, type MergedWallet } from "./directory-merge";
import { DIRECTORY_SOURCES } from "./directory-sources";
import { emptyWallet, type DirectorySourceModule, type FetchLog, type RemoteSource, type SourceResult, type SourceWallet } from "./directory-sources/types";
import kols from "./kols.json" with { type: "json" };
import { isRecord, parsePubkey } from "./sanitize";

export const SNAPSHOT_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "directory-snapshot.json");

/** Committed seed (`pnpm --filter @copy-trade-vault/indexer directory:refresh`): what each remote source returned last. */
export interface DirectorySnapshot {
  generatedAt: number;
  sources: Partial<Record<RemoteSource, { fetchedAt: number; wallets: SourceWallet[] }>>;
}

interface KolJson {
  name: string;
  handle: string | null;
  address: string;
  tags: string[];
  notes: string | null;
}

/** `kols.json`: hand-verified research rows, kept as the `curated` source. */
function curatedRows(): SourceWallet[] {
  return (kols as KolJson[]).map((k) => {
    const address = parsePubkey(k.address);
    if (!address) throw new Error(`kols.json: invalid address for ${k.name}`);
    return { ...emptyWallet("curated", address), name: k.name, handle: k.handle, tags: k.tags, notes: k.notes };
  });
}

/** Localnet seed KOLs (`.localnet/seed.json`: `{ kols: [{ address, name, handle, avatar? }] }`). */
function localnetRows(file: string, log: FetchLog | null): SourceWallet[] {
  try {
    const seed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    const list = isRecord(seed) && Array.isArray(seed.kols) ? seed.kols : [];
    const out: SourceWallet[] = [];
    for (const raw of list) {
      if (!isRecord(raw)) continue;
      const address = parsePubkey(raw.address);
      if (!address || typeof raw.name !== "string") continue;
      out.push({
        ...emptyWallet("localnet", address),
        name: raw.name.slice(0, 64),
        handle: typeof raw.handle === "string" ? raw.handle.replace(/^@/, "").slice(0, 64) : null,
        avatarUrl: typeof raw.avatar === "string" && /^https?:\/\//.test(raw.avatar) ? raw.avatar : null,
        notes: "Localnet test wallet",
      });
    }
    return out;
  } catch (err) {
    log?.warn({ file, err: String(err) }, "localnet seed KOLs not loaded");
    return [];
  }
}

export function readSnapshot(file: string): DirectorySnapshot | null {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return isRecord(raw) && isRecord(raw.sources) ? (raw as unknown as DirectorySnapshot) : null;
  } catch {
    return null;
  }
}

/** One wallet per line: diffable, and still a single JSON document. */
export function writeSnapshot(file: string, snap: DirectorySnapshot): void {
  const parts: string[] = [];
  for (const [source, s] of Object.entries(snap.sources)) {
    if (!s) continue;
    const wallets = s.wallets.map((w) => `      ${JSON.stringify(w)}`).join(",\n");
    parts.push(`    ${JSON.stringify(source)}: {\n      "fetchedAt": ${s.fetchedAt},\n      "wallets": [\n${wallets.replace(/^ {6}/gm, "        ")}\n      ]\n    }`);
  }
  fs.writeFileSync(file, `{\n  "generatedAt": ${snap.generatedAt},\n  "sources": {\n${parts.join(",\n")}\n  }\n}\n`);
}

export interface DirectoryQuery {
  q: string | null;
  sources: DirectorySource[];
  tags: string[];
  sort: DirectorySort;
  offset: number;
  limit: number;
}

export interface DirectoryResult {
  items: MergedWallet[];
  total: number;
  facets: { sources: Partial<Record<DirectorySource, number>>; tags: Record<string, number> };
}

export interface DirectoryOptions {
  store?: Store | null;
  localnetFile?: string | null;
  snapshotFile?: string | null;
  filesDir?: string;
  publicUrl?: string;
  log?: FetchLog | null;
  now?: () => number;
}

/**
 * The wallet directory: every source's rows (latest crawl in SQLite, else the committed snapshot) plus `kols.json` and
 * localnet seeds, merged per address (see `directory-merge.ts`). Reads are in-memory; refreshes run in the background
 * and swap the merged index atomically, so the API never waits on a crawl.
 */
export class Directory {
  private readonly store: Store | null;
  private readonly log: FetchLog | null;
  private readonly now: () => number;
  private readonly fixed: SourceWallet[];
  private readonly remote = new Map<RemoteSource, { fetchedAt: number; wallets: SourceWallet[] }>();
  private merged: MergedWallet[] = [];
  private byAddress = new Map<string, MergedWallet>();
  private byPerson = new Map<string, MergedWallet[]>();
  readonly avatars: AvatarCache;
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(opts: DirectoryOptions = {}) {
    this.store = opts.store ?? null;
    this.log = opts.log ?? null;
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000));
    this.fixed = [...curatedRows(), ...(opts.localnetFile ? localnetRows(opts.localnetFile, this.log) : [])];
    this.avatars = new AvatarCache(this.store, opts.filesDir ?? "", opts.publicUrl ?? "", this.log, this.now);
    const snap = opts.snapshotFile === null ? null : readSnapshot(opts.snapshotFile ?? SNAPSHOT_FILE);
    const stored = new Map<RemoteSource, SourceWallet[]>();
    for (const data of this.store?.directoryRows() ?? []) {
      const w = JSON.parse(data) as SourceWallet;
      const list = stored.get(w.source as RemoteSource);
      if (list) list.push(w);
      else stored.set(w.source as RemoteSource, [w]);
    }
    const runs = new Map((this.store?.directoryRuns() ?? []).map((r) => [r.source, r]));
    for (const m of DIRECTORY_SOURCES) {
      const rows = stored.get(m.id);
      const okAt = runs.get(m.id)?.last_ok_at ?? null;
      const fromSnap = snap?.sources[m.id];
      // The newer of the last crawl and the committed snapshot wins (a fresh deploy ships a fresher snapshot).
      if (rows && okAt !== null && (!fromSnap || okAt >= fromSnap.fetchedAt)) this.remote.set(m.id, { fetchedAt: okAt, wallets: rows });
      else if (fromSnap) this.remote.set(m.id, { fetchedAt: fromSnap.fetchedAt, wallets: fromSnap.wallets });
    }
    this.rebuild();
  }

  private rebuild(): void {
    const rows = [...this.fixed, ...[...this.remote.values()].flatMap((r) => r.wallets)];
    const merged = mergeDirectory(rows, this.now());
    const byAddress = new Map(merged.map((w) => [w.address, w]));
    const byPerson = new Map<string, MergedWallet[]>();
    for (const w of merged) {
      const list = byPerson.get(w.personId);
      if (list) list.push(w);
      else byPerson.set(w.personId, [w]);
    }
    this.merged = merged;
    this.byAddress = byAddress;
    this.byPerson = byPerson;
  }

  get(address: string): MergedWallet | undefined {
    return this.byAddress.get(address);
  }

  all(): MergedWallet[] {
    return this.merged;
  }

  /** Every directory wallet of a person (`personId`), best-ranked first. */
  person(personId: string): MergedWallet[] {
    return this.byPerson.get(personId) ?? [];
  }

  personCount(): number {
    return this.byPerson.size;
  }

  /** Last successful fetch per remote source (crawl or snapshot). */
  refreshedAt(): Partial<Record<DirectorySource, number>> {
    const out: Partial<Record<DirectorySource, number>> = {};
    for (const [source, r] of this.remote) out[source] = r.fetchedAt;
    return out;
  }

  /** Persists a source's fresh rows and swaps the merged index. */
  apply(result: SourceResult): void {
    this.store?.replaceDirectorySource(
      result.source,
      result.wallets.map((w) => ({ address: w.address, data: JSON.stringify(w) })),
    );
    this.store?.recordDirectoryRun(result.source, result.fetchedAt, result.fetchedAt, result.wallets.length, null);
    this.remote.set(result.source, { fetchedAt: result.fetchedAt, wallets: result.wallets });
    this.rebuild();
  }

  /** Runs one source now (errors are recorded and rethrown; previous data stays). */
  async refresh(m: DirectorySourceModule): Promise<SourceResult> {
    const tryAt = this.now();
    try {
      const known = this.merged.filter((w) => !w.sources.includes(m.id)).map((w) => ({ address: w.address, handle: w.handle }));
      const result = await m.fetch(this.log ?? { info() {}, warn() {} }, { known, previous: this.remote.get(m.id)?.wallets ?? [] });
      if (result.wallets.length === 0) throw new Error(`${m.id}: 0 wallets (refusing to replace the previous list)`);
      this.apply(result);
      return result;
    } catch (err) {
      this.store?.recordDirectoryRun(m.id, tryAt, null, 0, String(err).slice(0, 500));
      throw err;
    }
  }

  /**
   * Background schedule: each enabled source refreshes when its interval has elapsed since its last success (crawl or
   * snapshot); failures retry after 30 min. Sources run one at a time; avatars sync after every swap.
   */
  start(): void {
    void this.avatars.sync(this.merged);
    const tick = async () => {
      if (this.stopped) return;
      const runs = new Map((this.store?.directoryRuns() ?? []).map((r) => [r.source, r]));
      for (const m of DIRECTORY_SOURCES) {
        if (this.stopped || !m.enabled()) continue;
        const okAt = this.remote.get(m.id)?.fetchedAt ?? 0;
        const run = runs.get(m.id);
        const retryAt = run?.error && run.last_try_at > okAt ? run.last_try_at + 1800 : 0;
        if (this.now() < Math.max(okAt + m.intervalMs / 1000, retryAt)) continue;
        try {
          const r = await this.refresh(m);
          this.log?.info({ source: m.id, wallets: r.wallets.length, total: this.merged.length }, "directory source refreshed");
          void this.avatars.sync(this.merged);
        } catch (err) {
          this.log?.warn({ source: m.id, err: String(err) }, "directory source refresh failed");
        }
      }
      if (!this.stopped) this.timer = setTimeout(() => void tick(), 5 * 60_000);
    };
    this.timer = setTimeout(() => void tick(), 10_000);
  }

  /** Current remote rows in snapshot form (the refresh script commits this). */
  snapshot(): DirectorySnapshot {
    const sources: DirectorySnapshot["sources"] = {};
    for (const m of DIRECTORY_SOURCES) {
      const r = this.remote.get(m.id);
      if (r) sources[m.id] = r;
    }
    return { generatedAt: this.now(), sources };
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  /** Filter → facet → sort → page. `copiersOf` supplies the copy-vault-side sort key (copiers per target). */
  query(opts: DirectoryQuery, copiersOf: (address: string) => number): DirectoryResult {
    const needle = opts.q?.trim().replace(/^@/, "").toLowerCase() ?? "";
    let list = this.merged;
    const relevance = new Map<string, number>();
    if (needle) {
      list = list.filter((w) => {
        const name = w.name.toLowerCase();
        const handle = w.handle?.toLowerCase() ?? "";
        const display = w.displayName?.toLowerCase() ?? "";
        const addr = w.address.toLowerCase();
        const r =
          handle === needle || name === needle || addr === needle ? 3 : handle.startsWith(needle) || name.startsWith(needle) || addr.startsWith(needle) ? 2 : name.includes(needle) || handle.includes(needle) || display.includes(needle) ? 1 : 0;
        if (r) relevance.set(w.address, r);
        return r > 0;
      });
    }
    const facets = { sources: {} as Partial<Record<DirectorySource, number>>, tags: {} as Record<string, number> };
    for (const w of list) {
      for (const s of w.sources) facets.sources[s] = (facets.sources[s] ?? 0) + 1;
      for (const t of w.tags) facets.tags[t] = (facets.tags[t] ?? 0) + 1;
    }
    if (opts.sources.length) list = list.filter((w) => opts.sources.some((s) => w.sources.includes(s)));
    if (opts.tags.length) {
      // `-tag` excludes (e.g. `-hft`), `tag` requires.
      const want = opts.tags.filter((t) => !t.startsWith("-"));
      const not = opts.tags.filter((t) => t.startsWith("-")).map((t) => t.slice(1));
      list = list.filter((w) => want.every((t) => w.tags.includes(t)) && !not.some((t) => w.tags.includes(t)));
    }
    const key = SORT_KEYS[opts.sort];
    const nullsLast = (v: number | null) => (v === null ? -Infinity : v);
    const sorted = [...list].sort(
      (a, b) =>
        (relevance.get(b.address) ?? 0) - (relevance.get(a.address) ?? 0) ||
        nullsLast(key(b, copiersOf)) - nullsLast(key(a, copiersOf)) ||
        nullsLast(b.score) - nullsLast(a.score) ||
        b.sources.length - a.sources.length ||
        a.name.localeCompare(b.name),
    );
    return { items: sorted.slice(opts.offset, opts.offset + opts.limit), total: sorted.length, facets };
  }
}

/** Sort keys, larger first (`rank` is negated so #1 leads). */
const SORT_KEYS: Record<DirectorySort, (w: MergedWallet, copiersOf: (a: string) => number) => number | null> = {
  score: (w) => w.score,
  pnl30d: (w) => w.stats.pnl30dUsd,
  pnl7d: (w) => w.stats.pnl7dUsd,
  pnl1d: (w) => w.stats.pnl1dUsd,
  winrate: (w) => w.stats.winRate30d ?? w.stats.winRate7d,
  followers: (w) => w.followers,
  copiers: (w, copiersOf) => copiersOf(w.address),
  rank: (w) => (w.rank ? -w.rank.rank : null),
};
