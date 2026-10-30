import fs from "node:fs/promises";
import path from "node:path";
import { PublicKey } from "@solana/web3.js";
import { fetch, type Response } from "undici";
import { assertPublicUrl, guardedDispatcher, readCapped, UnfetchableUriError, unwrapGuardError } from "./net-guard";
import { cleanImageUrl, cleanSocial, cleanText, isRecord, ValidationError } from "./sanitize";

export { UnfetchableUriError } from "./net-guard";

const MAX_BYTES = 256 * 1024;
const TIMEOUT_MS = 5_000;
const MAX_REDIRECTS = 3;

export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const MPL_METADATA_PROGRAM = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

/** Display fields of a metadata JSON (all sanitized; invalid optional fields dropped). */
export interface OffchainMeta {
  name: string | null;
  symbol: string | null;
  description: string | null;
  image: string | null;
  twitter: string | null;
  telegram: string | null;
  website: string | null;
}

/** What the mint account itself says: SPL / Token-2022 base fields plus the Token-2022 metadata extension. */
export interface MintInfo {
  program: string;
  supply: bigint;
  decimals: number;
  /** Token-2022 `TokenMetadata` extension (pump `create_v2` coins); null on SPL Token mints. */
  meta: { name: string; symbol: string; uri: string } | null;
}

const dispatcher = guardedDispatcher(TIMEOUT_MS);

/** A public http(s) JSON document (5s timeout, 256 KB cap, ≤ 3 re-vetted redirects); throws on any non-2xx. */
export async function fetchRemoteJson(uri: string): Promise<unknown> {
  let url: URL;
  try {
    url = new URL(uri.startsWith("ipfs://") ? `https://ipfs.io/ipfs/${uri.slice(7).replace(/^ipfs\//, "")}` : uri);
  } catch {
    throw new UnfetchableUriError("invalid metadata URI");
  }
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  for (let hop = 0; ; hop++) {
    assertPublicUrl(url);
    let res: Response;
    try {
      res = await fetch(url, { signal, dispatcher, redirect: "manual", headers: { accept: "application/json" } });
    } catch (err) {
      throw unwrapGuardError(err);
    }
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel();
      if (hop >= MAX_REDIRECTS) throw new Error("too many metadata redirects");
      url = new URL(location, url);
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`metadata fetch returned HTTP ${res.status}`);
    }
    return JSON.parse((await readCapped(res, MAX_BYTES)).toString("utf8"));
  }
}

/** Metaplex/pump-style JSON → sanitized display fields. Invalid optional fields are dropped, not fatal. */
export function parseMetadata(json: unknown): OffchainMeta {
  if (!isRecord(json)) throw new Error("metadata is not a JSON object");
  const lenient = <T>(fn: () => T): T | null => {
    try {
      return fn();
    } catch (err) {
      if (err instanceof ValidationError) return null;
      throw err;
    }
  };
  const ext = isRecord(json.extensions) ? json.extensions : {};
  const social = (key: "twitter" | "telegram" | "website") => lenient(() => cleanSocial(json[key] ?? ext[key], key));
  return {
    name: lenient(() => cleanText(json.name, "name", 32, { bytes: true })),
    symbol: lenient(() => cleanText(json.symbol, "symbol", 10, { bytes: true })),
    description: lenient(() => cleanText(json.description, "description", 1000, { multiline: true })),
    image: cleanImageUrl(json.image),
    twitter: social("twitter"),
    telegram: social("telegram"),
    website: social("website"),
  };
}

/**
 * Loads a coin's metadata JSON. URIs under our own `PUBLIC_URL/files/meta/` (local uploads) are read straight from
 * disk; anything else must be a public http(s)/ipfs URL.
 */
export async function loadMetadata(uri: string, publicUrl: string, filesDir: string): Promise<OffchainMeta> {
  const ownPrefix = `${publicUrl}/files/meta/`;
  if (uri.startsWith(ownPrefix)) {
    const id = uri.slice(ownPrefix.length);
    if (!/^[A-Za-z0-9_-]+\.json$/.test(id)) throw new UnfetchableUriError("invalid local metadata id");
    const raw = await fs.readFile(path.join(filesDir, "meta", id), "utf8").catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") throw new UnfetchableUriError(`local metadata ${id} not found`);
      throw err;
    });
    return parseMetadata(JSON.parse(raw));
  }
  return parseMetadata(await fetchRemoteJson(uri));
}

class BorshReader {
  constructor(
    private readonly b: Buffer,
    public at: number,
  ) {}
  string(): string {
    const len = this.b.readUInt32LE(this.at);
    this.at += 4;
    if (this.at + len > this.b.length) throw new Error("string runs past the account");
    const s = this.b.subarray(this.at, this.at + len).toString("utf8");
    this.at += len;
    return s.replace(/\0+$/, "").trim();
  }
}

/** Token-2022 extension type of `TokenMetadata` (spl-token-metadata-interface, stored in the mint's TLV area). */
const TOKEN_METADATA_EXTENSION = 19;
/** Base mint is 82 bytes; extensions start after the account-type byte at 165 (multisig-sized padding). */
const MINT_SIZE = 82;
const EXT_START = 166;

/** Decodes an SPL Token / Token-2022 mint (supply, decimals, Token-2022 metadata extension). */
export function decodeMint(owner: string, data: Buffer): MintInfo {
  if (data.length < MINT_SIZE) throw new Error("not a mint account");
  const supply = data.readBigUInt64LE(36);
  const decimals = data[44]!;
  let meta: MintInfo["meta"] = null;
  if (owner === TOKEN_2022_PROGRAM && data.length > EXT_START) {
    let at = EXT_START;
    while (at + 4 <= data.length) {
      const type = data.readUInt16LE(at);
      const len = data.readUInt16LE(at + 2);
      const start = at + 4;
      if (type === 0 || start + len > data.length) break;
      if (type === TOKEN_METADATA_EXTENSION) {
        // update_authority (32) + mint (32), then borsh name / symbol / uri.
        const r = new BorshReader(data, start + 64);
        meta = { name: r.string(), symbol: r.string(), uri: r.string() };
        break;
      }
      at = start + len;
    }
  }
  return { program: owner, supply, decimals, meta };
}

export function metaplexMetadataPda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), MPL_METADATA_PROGRAM.toBuffer(), mint.toBuffer()],
    MPL_METADATA_PROGRAM,
  )[0];
}

/** Metaplex token metadata account: key(1) update_authority(32) mint(32) name symbol uri (borsh, NUL-padded). */
export function decodeMetaplexMetadata(data: Buffer): { name: string; symbol: string; uri: string } {
  const r = new BorshReader(data, 65);
  return { name: r.string(), symbol: r.string(), uri: r.string() };
}
