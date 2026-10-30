import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { UploadResponse } from "@copy-trade-vault/sdk/api";
// Loads @fastify/multipart's FastifyRequest augmentation (isMultipart/parts) for consumers outside server.ts.
import type {} from "@fastify/multipart";
import type { FastifyInstance } from "fastify";
import type { UploadStorage } from "./config";
import { cleanSocial, cleanText, HttpError, ValidationError } from "./sanitize";

export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
/** pump `create_v2` caps the uri at 200 bytes. */
const MAX_URI_LEN = 200;
const UPSTREAM_TIMEOUT_MS = 30_000;
const PINATA_UPLOAD_URL = "https://uploads.pinata.cloud/v3/files";
const PUMP_IPFS_URL = "https://pump.fun/api/ipfs";

type ImageKind = { ext: "png" | "jpg" | "gif" | "webp"; mime: string };

/** Identifies the image type from its magic bytes (never from the client-declared mime). */
export function sniffImage(buf: Buffer): ImageKind | null {
  const ascii = (start: number, end: number) => buf.subarray(start, end).toString("latin1");
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { ext: "png", mime: "image/png" };
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: "jpg", mime: "image/jpeg" };
  if (buf.length >= 6 && (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a")) return { ext: "gif", mime: "image/gif" };
  if (buf.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return { ext: "webp", mime: "image/webp" };
  return null;
}

export interface CoinFields {
  name: string;
  symbol: string;
  description: string | null;
  twitter: string | null;
  telegram: string | null;
  website: string | null;
}

export function validateFields(raw: Record<string, string>): CoinFields {
  const name = cleanText(raw.name, "name", 32, { bytes: true });
  if (!name) throw new ValidationError("name is required");
  const symbol = cleanText(raw.symbol, "symbol", 10, { bytes: true });
  if (!symbol) throw new ValidationError("symbol is required");
  return {
    name,
    symbol,
    description: cleanText(raw.description, "description", 1000, { multiline: true }),
    twitter: cleanSocial(raw.twitter, "twitter"),
    telegram: cleanSocial(raw.telegram, "telegram"),
    website: cleanSocial(raw.website, "website"),
  };
}

/** pump.fun's metadata JSON shape (create-coin skill, METADATA.md). */
export function coinMetadata(f: CoinFields, image: string): Record<string, unknown> {
  return {
    name: f.name,
    symbol: f.symbol,
    description: f.description ?? "",
    image,
    showName: true,
    createdOn: "https://pump.fun",
    ...(f.twitter ? { twitter: f.twitter } : {}),
    ...(f.telegram ? { telegram: f.telegram } : {}),
    ...(f.website ? { website: f.website } : {}),
  };
}

async function upstreamJson(res: Response, what: string): Promise<unknown> {
  const text = await res.text();
  if (!res.ok) throw new HttpError(502, `${what} failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(502, `${what} returned invalid JSON`);
  }
}

async function pinataPin(jwt: string, body: Blob, filename: string): Promise<string> {
  const form = new FormData();
  form.append("network", "public");
  form.append("name", filename);
  form.append("file", body, filename);
  const res = await fetch(PINATA_UPLOAD_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${jwt}` },
    body: form,
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  const json = (await upstreamJson(res, "pinata upload")) as { data?: { cid?: unknown } };
  const cid = json.data?.cid;
  if (typeof cid !== "string" || !cid) throw new HttpError(502, "pinata upload returned no cid");
  return cid;
}

export interface Uploader {
  storage: UploadStorage;
  upload(image: Buffer, kind: ImageKind, fields: CoinFields): Promise<UploadResponse>;
}

/** The configured IPFS / local backend for coin images + metadata JSON. */
export function createUploader(opts: {
  storage: UploadStorage;
  pinataJwt: string | null;
  pinataGateway: string;
  filesDir: string;
  publicUrl: string;
}): Uploader {
  const checkUri = (uri: string) => {
    if (Buffer.byteLength(uri) > MAX_URI_LEN) throw new HttpError(500, `metadata URI is ${uri.length} bytes, pump allows ${MAX_URI_LEN}`);
    return uri;
  };
  switch (opts.storage) {
    case "pinata": {
      const jwt = opts.pinataJwt!;
      return {
        storage: "pinata",
        async upload(image, kind, fields) {
          const id = randomBytes(6).toString("hex");
          const imageCid = await pinataPin(jwt, new Blob([new Uint8Array(image)], { type: kind.mime }), `${fields.symbol}-${id}.${kind.ext}`);
          const imageUrl = `${opts.pinataGateway}/${imageCid}`;
          const meta = JSON.stringify(coinMetadata(fields, imageUrl));
          const metaCid = await pinataPin(jwt, new Blob([meta], { type: "application/json" }), `${fields.symbol}-${id}.json`);
          return { uri: checkUri(`${opts.pinataGateway}/${metaCid}`), image: imageUrl };
        },
      };
    }
    case "pump":
      return {
        storage: "pump",
        async upload(image, kind, fields) {
          const form = new FormData();
          form.append("file", new Blob([new Uint8Array(image)], { type: kind.mime }), `image.${kind.ext}`);
          form.append("name", fields.name);
          form.append("symbol", fields.symbol);
          form.append("description", fields.description ?? "");
          if (fields.twitter) form.append("twitter", fields.twitter);
          if (fields.telegram) form.append("telegram", fields.telegram);
          if (fields.website) form.append("website", fields.website);
          form.append("showName", "true");
          const res = await fetch(PUMP_IPFS_URL, { method: "POST", body: form, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
          const json = (await upstreamJson(res, "pump.fun ipfs upload")) as { metadataUri?: unknown; metadata?: { image?: unknown } };
          if (typeof json.metadataUri !== "string" || typeof json.metadata?.image !== "string") {
            throw new HttpError(502, "pump.fun ipfs upload returned no metadataUri");
          }
          return { uri: checkUri(json.metadataUri), image: json.metadata.image };
        },
      };
    case "local":
      return {
        storage: "local",
        async upload(image, kind, fields) {
          const id = randomBytes(9).toString("base64url");
          const imageUrl = `${opts.publicUrl}/files/img/${id}.${kind.ext}`;
          const uri = checkUri(`${opts.publicUrl}/files/meta/${id}.json`);
          await fs.writeFile(path.join(opts.filesDir, "img", `${id}.${kind.ext}`), image, { flag: "wx" });
          await fs.writeFile(path.join(opts.filesDir, "meta", `${id}.json`), JSON.stringify(coinMetadata(fields, imageUrl)), { flag: "wx" });
          return { uri, image: imageUrl };
        },
      };
  }
}

/** `POST /api/upload` (multipart `image` + coin fields) → `{ uri, image }`. */
export function registerUpload(app: FastifyInstance, uploader: Uploader): void {
  app.post("/api/upload", async (req, reply) => {
    if (!req.isMultipart()) throw new ValidationError("expected multipart/form-data");
    const raw: Record<string, string> = {};
    let image: Buffer | null = null;
    for await (const part of req.parts()) {
      if (part.type === "file") {
        const buf = await part.toBuffer();
        if (part.fieldname === "image") image = buf;
        continue;
      }
      if (part.valueTruncated) throw new ValidationError(`${part.fieldname} is too long`);
      raw[part.fieldname] = String(part.value);
    }
    if (!image || image.length === 0) throw new ValidationError("image file is required");
    const kind = sniffImage(image);
    if (!kind) throw new ValidationError("image must be a PNG, JPEG, GIF or WebP file");
    const fields = validateFields(raw);
    const stored = await uploader.upload(image, kind, fields);
    req.log.info({ storage: uploader.storage, kind: kind.ext, bytes: image.length, uri: stored.uri }, "upload stored");
    return reply.send(stored satisfies UploadResponse);
  });
}
