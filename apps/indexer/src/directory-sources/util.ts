import { execFile } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fetch } from "undici";
import { assertPublicUrl, BodyTooLargeError, guardedDispatcher, readCapped, resolvePublic, UnfetchableUriError, unwrapGuardError } from "../net-guard";
import { cleanText } from "../sanitize";

/** A desktop browser UA: several sources reject non-browser clients outright. */
export const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";

const TIMEOUT_MS = 20_000;
const RETRIES = 3;

export class SourceHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Per-host pacing: at most one request every `minGapMs` to the same host, process-wide. */
const nextSlot = new Map<string, number>();
async function pace(host: string, minGapMs: number): Promise<void> {
  const now = Date.now();
  const at = Math.max(now, nextSlot.get(host) ?? 0);
  nextSlot.set(host, at + minGapMs);
  if (at > now) await sleep(at - now);
}

export interface PoliteInit {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  /** Minimum spacing between requests to this host (default 600 ms). */
  minGapMs?: number;
  timeoutMs?: number;
  /**
   * `curl`: run the system curl binary instead of Node's fetch. Some Cloudflare zones (GMGN) block Node's TLS
   * fingerprint outright but let curl through.
   */
  transport?: "fetch" | "curl";
  /** Retries after the first attempt (default 3). */
  retries?: number;
  /** Decoded response bytes above this abort the download (default 16 MiB). */
  maxBytes?: number;
  /**
   * Untrusted URL (third-party data): https only, every resolved address must be publicly routable, and redirects
   * are followed manually (≤ 3), each hop re-vetted.
   */
  publicOnly?: boolean;
}

export interface RawResponse {
  status: number;
  body: Buffer;
  retryAfter: number | null;
  /** Redirect target; only set when redirects aren't followed by the transport (`publicOnly`). */
  location: string | null;
}

/** Default response cap (directory pages are ≤ ~1 MB). */
const MAX_BODY = 16 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const guarded = guardedDispatcher(TIMEOUT_MS);

async function viaFetch(url: string, init: PoliteInit, headers: Record<string, string>): Promise<RawResponse> {
  let res;
  try {
    res = await fetch(url, {
      method: init.method ?? "GET",
      headers,
      body: init.body,
      signal: AbortSignal.timeout(init.timeoutMs ?? TIMEOUT_MS),
      redirect: init.publicOnly ? "manual" : "follow",
      dispatcher: init.publicOnly ? guarded : undefined,
    });
  } catch (err) {
    throw unwrapGuardError(err);
  }
  const location = init.publicOnly && res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
  const retryAfter = Number(res.headers.get("retry-after")) || null;
  if (location) {
    await res.body?.cancel();
    return { status: res.status, body: Buffer.alloc(0), retryAfter, location };
  }
  return { status: res.status, body: await readCapped(res, init.maxBytes ?? MAX_BODY), retryAfter, location: null };
}

async function viaCurl(url: string, init: PoliteInit, headers: Record<string, string>): Promise<RawResponse> {
  const maxBytes = init.maxBytes ?? MAX_BODY;
  const secs = Math.ceil((init.timeoutMs ?? TIMEOUT_MS) / 1000);
  const args = ["-sS", "--max-time", String(secs), "--max-filesize", String(maxBytes), "-w", "\n%{http_code} %{redirect_url}"];
  if (init.publicOnly) {
    // No auto-follow; connect only to the vetted address (pinned so curl can't re-resolve to something else).
    const u = new URL(url);
    const [addr] = await resolvePublic(u.hostname);
    args.push("--proto", "=https", "--max-redirs", "0", "--resolve", `${u.hostname}:${u.port || 443}:${addr!.family === 6 ? `[${addr!.address}]` : addr!.address}`);
  } else {
    args.push("-L", "--compressed");
  }
  if (init.method === "POST") args.push("-X", "POST");
  // HTTP/1.1 keeps header-name casing; send it the way browsers do (`User-Agent`, `Accept-Language`).
  for (const [k, v] of Object.entries(headers)) args.push("-H", `${k.replace(/(^|-)([a-z])/g, (_, d: string, c: string) => d + c.toUpperCase())}: ${v}`);
  if (init.body !== undefined) args.push("--data-raw", init.body);
  args.push("--", url);
  const { promise, resolve, reject } = Promise.withResolvers<RawResponse>();
  // stdout = body + the write-out trailer; maxBuffer bounds the decoded body even without a Content-Length.
  execFile("curl", args, { maxBuffer: maxBytes + 4096, encoding: "buffer", windowsHide: true }, (err, stdout) => {
    if (err) {
      // 63 = curl's --max-filesize exit code.
      const tooBig = err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || err.code === 63;
      return reject(tooBig ? new BodyTooLargeError(`${url}: body larger than ${maxBytes} bytes`) : new Error(`curl ${url}: ${err.message.split("\n")[0]}`));
    }
    const cut = stdout.lastIndexOf(0x0a);
    const [code, redirect] = stdout.subarray(cut + 1).toString("latin1").split(" ");
    const status = Number(code);
    const location = init.publicOnly && status >= 300 && status < 400 && redirect ? redirect : null;
    resolve({ status, body: stdout.subarray(0, cut), retryAfter: null, location });
  });
  return promise;
}

type Transport = (url: string, init: PoliteInit, headers: Record<string, string>) => Promise<RawResponse>;

/** One request; with `publicOnly`, vets the URL and follows redirects by hand, re-vetting each hop. `transport`: test seam. */
export async function request(
  url: string,
  init: PoliteInit,
  headers: Record<string, string>,
  transport: Transport = init.transport === "curl" ? viaCurl : viaFetch,
): Promise<RawResponse> {
  let u = new URL(url);
  for (let hop = 0; ; hop++) {
    if (init.publicOnly) assertPublicUrl(u, ["https:"]);
    const res = await transport(u.href, init, headers);
    if (!res.location) return res;
    if (hop >= MAX_REDIRECTS) throw new UnfetchableUriError(`${url}: more than ${MAX_REDIRECTS} redirects`);
    u = new URL(res.location, u);
  }
}

/**
 * GET/POST with a browser UA, a per-host pace, a timeout and retries with exponential backoff on network errors,
 * 429 and 5xx (honouring `Retry-After`). Other 4xx fail immediately: they mean we're blocked or the API changed.
 * Unfetchable URLs and oversized bodies fail immediately too.
 */
export async function politeBytes(url: string, init: PoliteInit = {}): Promise<Buffer> {
  const host = new URL(url).host;
  const headers = { "user-agent": BROWSER_UA, accept: "*/*", "accept-language": "en-US,en;q=0.9", ...init.headers };
  let lastErr: unknown;
  for (let attempt = 0; attempt <= (init.retries ?? RETRIES); attempt++) {
    await pace(host, init.minGapMs ?? 600);
    let res: RawResponse;
    try {
      res = await request(url, init, headers);
    } catch (err) {
      if (err instanceof SourceHttpError || err instanceof UnfetchableUriError || err instanceof BodyTooLargeError) throw err;
      lastErr = err;
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if (res.status >= 200 && res.status < 300) return res.body;
    const err = new SourceHttpError(res.status, `${init.method ?? "GET"} ${url} → HTTP ${res.status}: ${res.body.subarray(0, 120).toString("utf8")}`);
    if (res.status !== 429 && res.status < 500) throw err;
    lastErr = err;
    await sleep(res.retryAfter !== null && res.retryAfter > 0 ? Math.min(res.retryAfter, 60) * 1000 : 1000 * 2 ** attempt);
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function politeFetch(url: string, init: PoliteInit = {}): Promise<string> {
  return (await politeBytes(url, init)).toString("utf8");
}

export async function politeJson(url: string, init: PoliteInit = {}): Promise<unknown> {
  const text = await politeFetch(url, { ...init, headers: { accept: "application/json", ...init.headers } });
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${url}: response is not JSON (${text.slice(0, 80)})`);
  }
}

// ---------------- field parsing ----------------

/** A finite number from a number or numeric string, else null. */
export function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** A non-negative integer count, else null. */
export function count(v: unknown): number | null {
  const n = num(v);
  return n !== null && n >= 0 ? Math.round(n) : null;
}

/** A ratio in [0, 1]; values in (1, 100] are read as percentages. */
export function ratio(v: unknown): number | null {
  const n = num(v);
  if (n === null || n < 0) return null;
  if (n <= 1) return n;
  return n <= 100 ? n / 100 : null;
}

/** Unix seconds from seconds or milliseconds. */
export function unixSecs(v: unknown): number | null {
  const n = num(v);
  if (n === null || n <= 0) return null;
  return Math.floor(n > 1e12 ? n / 1000 : n);
}

const X_HANDLE = /^[A-Za-z0-9_]{1,15}$/;
const X_HOSTS = /^(?:www\.|mobile\.)?(?:x|twitter)\.com$/i;
/** First path segments of x.com URLs that aren't profiles. */
const X_RESERVED: Record<string, true> = { i: true, home: true, intent: true, search: true, share: true, hashtag: true };

/** X handle (no `@`) from a handle or an x.com / twitter.com profile URL, else null. */
export function xHandle(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let s = raw.trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s) || /^(?:www\.)?(?:x|twitter)\.com\//i.test(s)) {
    try {
      const u = new URL(/^https?:/i.test(s) ? s : `https://${s}`);
      if (!X_HOSTS.test(u.hostname)) return null;
      s = u.pathname.split("/").filter(Boolean)[0] ?? "";
    } catch {
      return null;
    }
  }
  s = s.replace(/^@/, "");
  if (X_RESERVED[s.toLowerCase()]) return null;
  return X_HANDLE.test(s) ? s : null;
}

/** Display text: control characters stripped, whitespace collapsed, cut to `max` characters; null when empty. */
export function label(raw: unknown, max = 64): string | null {
  if (typeof raw !== "string") return null;
  const s = cleanText(raw, "label", Number.MAX_SAFE_INTEGER);
  return s === null ? null : [...s].slice(0, max).join("").trim() || null;
}
