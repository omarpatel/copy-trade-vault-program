import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { DirectoryAvatarRow, Store } from "./db";
import type { MergedWallet } from "./directory-merge";
import { politeBytes } from "./directory-sources/util";

/**
 * Profile pictures of directory wallets, fetched from the sources' image hosts and cached on the files volume as
 * content-addressed WebP (`files/avatars/<sha>-128.webp` and `-256.webp`, served with immutable cache headers), so
 * pages never hotlink third-party images. A wallet's candidates are its sources' avatar URLs (best first) and, for an
 * X handle with none, unavatar.io's X resolver (anonymous quota: 25/day per IP, so it's rationed).
 */

export const AVATAR_SIZES = [128, 256] as const;
export type AvatarSize = (typeof AVATAR_SIZES)[number];

/** Failed sources are retried after this long, at most `MAX_ATTEMPTS` attempts in total per URL. */
const RETRY_FAILED_SECS = 3 * 86_400;
const MAX_ATTEMPTS = 3;
/** Downloaded images above this are refused (decoded bytes). */
const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
/** Cached images are re-fetched this often (X/pump avatars change behind stable URLs). */
const REFRESH_OK_SECS = 14 * 86_400;
const UNAVATAR_PER_DAY = 20;
const CONCURRENCY = 4;
/** Hosts behind Cloudflare zones that block Node's TLS fingerprint. */
const CURL_HOSTS: Record<string, true> = { "gmgn.ai": true };

export const unavatarUrl = (handle: string) => `https://unavatar.io/x/${encodeURIComponent(handle)}?fallback=false`;

interface Logger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

export class AvatarCache {
  private readonly rows = new Map<string, DirectoryAvatarRow>();
  private running: Promise<void> | null = null;
  private pending: MergedWallet[] | null = null;

  constructor(
    private readonly store: Store | null,
    private readonly filesDir: string,
    private readonly publicUrl: string,
    private readonly log: Logger | null,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {
    for (const r of store?.directoryAvatars() ?? []) this.rows.set(r.src, r);
  }

  /** Candidate image URLs of a wallet, best first. */
  static candidates(w: Pick<MergedWallet, "avatarSources" | "handle">): string[] {
    return w.handle ? [...w.avatarSources, unavatarUrl(w.handle)] : w.avatarSources;
  }

  /** Cached URL of the wallet's best available image at `size`, or null (UI falls back to a monogram). */
  url(w: Pick<MergedWallet, "avatarSources" | "handle">, size: AvatarSize): string | null {
    for (const src of AvatarCache.candidates(w)) {
      const r = this.rows.get(src);
      if (r?.status === "ok" && r.file) return `${this.publicUrl}/files/avatars/${r.file}-${size}.webp`;
    }
    return null;
  }

  /** Fetches missing/stale avatars in the background; a call during a run queues one follow-up run. */
  sync(wallets: MergedWallet[]): Promise<void> {
    if (this.running) {
      this.pending = wallets;
      return this.running;
    }
    this.running = this.run(wallets)
      .catch((err: unknown) => this.log?.warn({ err: String(err) }, "avatar sync failed"))
      .finally(() => {
        this.running = null;
        const next = this.pending;
        this.pending = null;
        if (next) void this.sync(next);
      });
    return this.running;
  }

  private due(src: string): boolean {
    const r = this.rows.get(src);
    if (!r) return true;
    const age = this.now() - r.fetched_at;
    return r.status === "ok" ? age > REFRESH_OK_SECS : r.attempts < MAX_ATTEMPTS && age > RETRY_FAILED_SECS;
  }

  /** The source to fetch next for a wallet, or null when it's settled (cached and fresh, or nothing left to try). */
  private nextFor(w: MergedWallet): string | null {
    for (const src of AvatarCache.candidates(w)) {
      const r = this.rows.get(src);
      if (r?.status === "ok") return this.due(src) ? src : null;
      if (this.due(src)) return src;
    }
    return null;
  }

  private async run(wallets: MergedWallet[]): Promise<void> {
    const dayAgo = this.now() - 86_400;
    let unavatarBudget = UNAVATAR_PER_DAY - [...this.rows.values()].filter((r) => r.src.startsWith("https://unavatar.io/") && r.fetched_at > dayAgo).length;
    // Most-listed wallets first: they're the ones on screen.
    const queue = [...wallets].sort((a, b) => b.sources.length - a.sources.length || (a.rank?.rank ?? 1e9) - (b.rank?.rank ?? 1e9));
    let fetched = 0;
    let failed = 0;
    const work = async () => {
      for (let w = queue.shift(); w; w = queue.shift()) {
        // Walk the wallet's candidates until one caches (each failure marks its source and moves on).
        for (let src = this.nextFor(w); src; src = this.nextFor(w)) {
          if (src.startsWith("https://unavatar.io/")) {
            if (unavatarBudget <= 0) break;
            unavatarBudget--;
          }
          if (await this.fetchOne(src)) {
            fetched++;
            break;
          }
          failed++;
        }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, work));
    if (fetched || failed) this.log?.info({ fetched, failed, cached: [...this.rows.values()].filter((r) => r.status === "ok").length }, "avatars synced");
  }

  /** Downloads, validates and resizes one image; records the outcome. */
  private async fetchOne(src: string): Promise<boolean> {
    const prev = this.rows.get(src);
    const now = this.now();
    // Count the attempt before downloading, so a crash mid-fetch (OOM, kill) is a failed attempt, not a boot loop.
    const attempts = prev?.status === "ok" ? 0 : (prev?.attempts ?? 0) + 1;
    if (prev?.status === "ok") this.record({ ...prev, fetched_at: now });
    else this.record({ src, file: null, status: "failed", attempts, fetched_at: now, error: "interrupted" });
    try {
      const raw = (await this.ownUpload(src)) ?? (await this.download(src));
      const file = createHash("sha256").update(raw).digest("hex").slice(0, 24);
      const dir = path.join(this.filesDir, "avatars");
      await fs.mkdir(dir, { recursive: true });
      for (const size of AVATAR_SIZES) {
        const out = path.join(dir, `${file}-${size}.webp`);
        // `limitInputPixels` and the timeout reject decompression bombs; the first frame of animations is kept.
        const webp = await sharp(raw, { limitInputPixels: 40_000_000, failOn: "error" })
          .timeout({ seconds: 10 })
          .rotate()
          .resize(size, size, { fit: "cover" })
          .webp({ quality: 82 })
          .toBuffer();
        await fs.writeFile(out, webp);
      }
      this.record({ src, file, status: "ok", attempts: 0, fetched_at: now, error: null });
      return true;
    } catch (err) {
      // A failed refresh of a cached image keeps serving the cached file (already re-stamped above).
      if (prev?.status !== "ok") this.record({ src, file: null, status: "failed", attempts, fetched_at: now, error: String(err).split("\n")[0]!.slice(0, 200) });
      return false;
    }
  }

  /**
   * Our own uploads (`${publicUrl}/files/img/<id>.<ext>`, e.g. localnet seed avatars) are read from disk: the SSRF
   * guard rightly refuses the indexer's own loopback/http URL. null for any other URL.
   */
  private async ownUpload(src: string): Promise<Buffer | null> {
    const prefix = `${this.publicUrl}/files/img/`;
    if (!src.startsWith(prefix)) return null;
    const id = src.slice(prefix.length);
    if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9]+$/.test(id)) throw new Error(`invalid local image id ${id}`);
    const raw = await fs.readFile(path.join(this.filesDir, "img", id));
    if (raw.length > MAX_AVATAR_BYTES) throw new Error(`local image ${id} exceeds ${MAX_AVATAR_BYTES} bytes`);
    return raw;
  }

  /** Untrusted third-party image: public https hosts only, bounded size (see net-guard). */
  private download(src: string): Promise<Buffer> {
    const host = new URL(src).hostname;
    return politeBytes(src, {
      minGapMs: 250,
      timeoutMs: 15_000,
      retries: 1,
      transport: CURL_HOSTS[host] ? "curl" : "fetch",
      headers: { accept: "image/*", "accept-encoding": "identity" },
      maxBytes: MAX_AVATAR_BYTES,
      publicOnly: true,
    });
  }

  private record(r: DirectoryAvatarRow): void {
    this.rows.set(r.src, r);
    this.store?.upsertDirectoryAvatar(r);
  }
}
