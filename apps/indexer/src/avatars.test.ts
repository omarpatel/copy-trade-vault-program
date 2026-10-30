import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import sharp from "sharp";
import { AvatarCache } from "./avatars";
import type { MergedWallet } from "./directory-merge";

const PUBLIC_URL = "http://127.0.0.1:8790";
let filesDir: string;

/** The cache only reads `avatarSources`, `handle`, `sources` and `rank` of a wallet. */
function wallet(avatarSources: string[]): MergedWallet {
  const partial = { address: "W1", avatarSources, handle: null, sources: [], rank: null };
  // Test double: the remaining MergedWallet fields are never touched by AvatarCache.
  const w = partial as unknown as MergedWallet;
  return w;
}

before(async () => {
  filesDir = await fs.mkdtemp(path.join(os.tmpdir(), "copier-avatars-"));
  await fs.mkdir(path.join(filesDir, "img"));
  const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#2439b8" } }).png().toBuffer();
  await fs.writeFile(path.join(filesDir, "img", "seed-kol.png"), png);
  await fs.writeFile(path.join(filesDir, "secret.txt"), "not an image");
});

after(() => fs.rm(filesDir, { recursive: true, force: true }));

describe("avatar cache: the indexer's own uploads", () => {
  test("an avatar hosted by this indexer (localnet seed KOLs) is read from disk and cached despite the SSRF guard", async () => {
    const cache = new AvatarCache(null, filesDir, PUBLIC_URL, null);
    const w = wallet([`${PUBLIC_URL}/files/img/seed-kol.png`]);
    await cache.sync([w]);
    const url = cache.url(w, 128);
    assert.match(url ?? "", /^http:\/\/127\.0\.0\.1:8790\/files\/avatars\/[0-9a-f]{24}-128\.webp$/);
    const file = path.join(filesDir, "avatars", path.basename(new URL(url!).pathname));
    assert.equal((await sharp(await fs.readFile(file)).metadata()).width, 128);
  });

  test("a path-traversal id under our prefix is refused, not read", async () => {
    const cache = new AvatarCache(null, filesDir, PUBLIC_URL, null);
    const w = wallet([`${PUBLIC_URL}/files/img/../secret.txt`]);
    await cache.sync([w]);
    assert.equal(cache.url(w, 128), null);
  });
});
