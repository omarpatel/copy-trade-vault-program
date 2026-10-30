import { PublicKey } from "@solana/web3.js";

/** Input validation shared by the upload/ingest endpoints (strict) and metadata ingestion (lenient). */

export class ValidationError extends Error {}

export class NotFoundError extends Error {}

/** Error with an explicit HTTP status (the server's error handler sends `{ error: message }`). */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

// C0/C1 control characters except tab/newline (kept for descriptions), plus bidi overrides.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;
const HANDLE = /^@?[A-Za-z0-9_.]{1,64}$/;

/**
 * Trims, strips control characters and enforces a limit. Name/symbol limits are UTF-8 bytes (pump's on-chain
 * string limits); descriptions count characters.
 */
export function cleanText(
  raw: unknown,
  label: string,
  max: number,
  opts: { multiline?: boolean; bytes?: boolean } = {},
): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") throw new ValidationError(`${label} must be a string`);
  let s = raw.replace(CONTROL, "");
  s = opts.multiline ? s.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n") : s.replace(/[\t\n]+/g, " ");
  s = s.trim();
  if (s === "") return null;
  const len = opts.bytes ? Buffer.byteLength(s, "utf8") : [...s].length;
  if (len > max) throw new ValidationError(`${label} must be at most ${max} ${opts.bytes ? "bytes" : "characters"}`);
  return s;
}

function httpUrl(s: string): URL | null {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:" ? u : null;
  } catch {
    return null;
  }
}

/** Hosts an X / Telegram link may point at: the site renders it with that platform's icon and name. */
const SOCIAL_HOSTS: Record<string, RegExp> = {
  twitter: /^((www|mobile)\.)?(x|twitter)\.com$/i,
  telegram: /^(www\.)?(t\.me|telegram\.me)$/i,
};

/** Social link: an http(s) URL (on X / Telegram for those two labels) or a bare/@ handle, at most 200 characters. */
export function cleanSocial(raw: unknown, label: "twitter" | "telegram" | "website"): string | null {
  const s = cleanText(raw, label, 200);
  if (s === null) return null;
  if (label !== "website" && HANDLE.test(s)) return s;
  const u = httpUrl(s);
  if (!u) throw new ValidationError(`${label} must be an http(s) URL${label === "website" ? "" : " or a handle"}`);
  const host = SOCIAL_HOSTS[label];
  if (host && !host.test(u.hostname)) {
    throw new ValidationError(`${label} must be a handle or a link on ${label === "twitter" ? "x.com" : "t.me"}`);
  }
  return u.toString();
}

/** Image reference from third-party metadata: http(s), or ipfs:// rewritten to a public gateway. */
export function cleanImageUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (s.length === 0 || s.length > 500) return null;
  if (s.startsWith("ipfs://")) return `https://ipfs.io/ipfs/${s.slice("ipfs://".length).replace(/^ipfs\//, "")}`;
  return httpUrl(s)?.toString() ?? null;
}

/** Canonical base58 pubkey string, or null. */
export function parsePubkey(s: unknown): string | null {
  if (typeof s !== "string" || s.length < 32 || s.length > 44) return null;
  try {
    const pk = new PublicKey(s);
    return pk.toBase58() === s ? s : null;
  } catch {
    return null;
  }
}

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;

/** A base58 transaction signature (64 bytes → 86–88 chars). */
export function isSignature(s: unknown): s is string {
  return typeof s === "string" && s.length >= 64 && s.length <= 88 && BASE58.test(s);
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
