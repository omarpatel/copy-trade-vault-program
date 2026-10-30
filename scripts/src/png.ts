/**
 * Procedural coin logos / avatars as PNG (the indexer's upload endpoint takes png/jpeg/gif/webp), drawn with
 * anti-aliased signed-distance shapes over a two-colour gradient and encoded with node:zlib — no native deps.
 */
import { deflateSync } from "node:zlib";

export type Glyph = "ring" | "diamond" | "split" | "wave" | "orbit" | "prism" | "eye" | "bolt";

export interface LogoDesign {
  /** Gradient start / end (`#rrggbb`), top-left → bottom-right. */
  from: string;
  to: string;
  glyph: Glyph;
  /** Glyph colour (default white). */
  ink?: string;
}

const SIZE = 256;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** Encodes RGBA pixels (row-major, `width * height * 4` bytes) as a PNG. */
export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

const rgb = (hex: string): [number, number, number] => {
  const n = Number.parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
/** Coverage of a shape at signed distance `d` (negative inside), 1px anti-aliasing. */
const cover = (d: number) => clamp01(0.5 - d);

const circle = (x: number, y: number, cx: number, cy: number, r: number) => Math.hypot(x - cx, y - cy) - r;
const ring = (x: number, y: number, cx: number, cy: number, r: number, w: number) => Math.abs(circle(x, y, cx, cy, r)) - w;
const diamond = (x: number, y: number, cx: number, cy: number, r: number) => (Math.abs(x - cx) + Math.abs(y - cy) - r) / Math.SQRT2;
const box = (x: number, y: number, cx: number, cy: number, hw: number, hh: number) => {
  const dx = Math.abs(x - cx) - hw;
  const dy = Math.abs(y - cy) - hh;
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0);
};
/** Distance to the segment a→b. */
const segment = (x: number, y: number, ax: number, ay: number, bx: number, by: number) => {
  const px = x - ax;
  const py = y - ay;
  const vx = bx - ax;
  const vy = by - ay;
  const h = clamp01((px * vx + py * vy) / (vx * vx + vy * vy));
  return Math.hypot(px - vx * h, py - vy * h);
};

/** Signed distance of the glyph (centre 128,128; the lower band below y≈200 copiers the top: "reflection"). */
function glyphDistance(glyph: Glyph, x: number, y: number): number {
  const c = 128;
  switch (glyph) {
    case "ring":
      return Math.min(ring(x, y, c, c, 70, 9), circle(x, y, c, c, 26));
    case "diamond":
      return Math.min(Math.abs(diamond(x, y, c, c, 62)) - 12, diamond(x, y, c, c, 18));
    case "split": {
      // Two half-discs offset across a vertical "copier" line.
      const left = Math.max(circle(x, y, c - 8, c, 66), x - (c - 8));
      const right = Math.max(circle(x, y, c + 8, c, 66), c + 8 - x);
      return Math.min(left, right);
    }
    case "wave": {
      const w = Math.abs(y - c - 26 * Math.sin((x / SIZE) * Math.PI * 3)) - 11;
      const w2 = Math.abs(y - c + 44 - 18 * Math.sin((x / SIZE) * Math.PI * 3 + 1.4)) - 7;
      return Math.max(Math.min(w, w2), circle(x, y, c, c, 98));
    }
    case "orbit":
      return Math.min(ring(x, y, c, c, 78, 5), circle(x, y, c, c, 34), circle(x, y, c + 55, c - 55, 13));
    case "prism": {
      // Triangle (equilateral, pointing up) via three half-planes.
      const k = Math.sqrt(3);
      const px = Math.abs(x - c);
      const py = -(y - c - 18);
      const tri = Math.max(px * k * 0.5 + py * 0.5, -py) - 46;
      return Math.min(tri, box(x, y, c, c + 66, 70, 5));
    }
    case "eye": {
      const lens = Math.max(circle(x, y, c, c - 70, 112), circle(x, y, c, c + 70, 112));
      return Math.min(Math.max(lens, -circle(x, y, c, c, 36)), circle(x, y, c, c, 18));
    }
    case "bolt": {
      const d = Math.min(segment(x, y, 150, 52, 104, 136), segment(x, y, 104, 136, 156, 122), segment(x, y, 156, 122, 108, 206));
      return d - 13;
    }
  }
}

/** A 256×256 logo: rounded-square gradient tile, soft sheen, glyph with a drop shadow. */
export function logoPng(design: LogoDesign): Buffer {
  const [r0, g0, b0] = rgb(design.from);
  const [r1, g1, b1] = rgb(design.to);
  const [ri, gi, bi] = rgb(design.ink ?? "#ffffff");
  const px = new Uint8Array(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const sx = x + 0.5;
      const sy = y + 0.5;
      const t = clamp01((sx + sy) / (2 * SIZE));
      let r = r0 + (r1 - r0) * t;
      let g = g0 + (g1 - g0) * t;
      let b = b0 + (b1 - b0) * t;
      // Sheen from the top-left.
      const sheen = clamp01(1 - Math.hypot(sx - 70, sy - 50) / 260) * 0.35;
      r += (255 - r) * sheen;
      g += (255 - g) * sheen;
      b += (255 - b) * sheen;
      // Drop shadow, then the glyph.
      const shadow = cover(glyphDistance(design.glyph, sx - 4, sy - 6) / 3) * 0.25;
      r *= 1 - shadow;
      g *= 1 - shadow;
      b *= 1 - shadow;
      const ink = cover(glyphDistance(design.glyph, sx, sy)) * 0.95;
      r += (ri - r) * ink;
      g += (gi - g) * ink;
      b += (bi - b) * ink;
      const alpha = cover(box(sx, sy, 128, 128, 128 - 52, 128 - 52) - 52);
      const i = (y * SIZE + x) * 4;
      px[i] = Math.round(r);
      px[i + 1] = Math.round(g);
      px[i + 2] = Math.round(b);
      px[i + 3] = Math.round(alpha * 255);
    }
  }
  return encodePng(SIZE, SIZE, px);
}
