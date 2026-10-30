import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { Store, type TargetTradeRow } from "./db";
import { Directory } from "./directory";
import { Hub } from "./hub";
import { createServer, registerApi } from "./server";
import { createUploader } from "./upload";
import { Views } from "./views";

const TOKEN = "test-ingest-token";
const COPIER = "D1YLG89jz5vPH4UHYPZqQrE47CRehFWuGiWSLP6Pj9uC";
const TARGET = "FxdFhjeXqNRerLLiPznscf2dXFAvgUXZuJkFSoxHaxgi";
const MINT = "So11111111111111111111111111111111111111112";
const SIG = "4".repeat(88);

const report = (over: Record<string, unknown> = {}) => ({
  copier: COPIER,
  target: TARGET,
  signature: SIG,
  slot: 10,
  blockTime: 1_759_560_000,
  side: "buy",
  tokenMint: MINT,
  tokenDelta: "1000",
  solDelta: "-5000000",
  targetSolBefore: "9000000000",
  priceLamportsPerToken: 5000,
  venue: "curve",
  status: "skipped",
  reason: "signal_below_min",
  error: null,
  vaultSignature: null,
  vaultSolIn: null,
  vaultTokensIn: null,
  detectedAt: 1_759_560_000_350,
  decidedAt: 1_759_560_000_400,
  ...over,
});

let app: FastifyInstance;
let store: Store;
let filesDir: string;
const ingested: TargetTradeRow[][] = [];

before(async () => {
  filesDir = fs.mkdtempSync(path.join(os.tmpdir(), "copier-indexer-"));
  store = new Store(":memory:");
  const views = new Views(store, new Directory({ snapshotFile: null }));
  app = await createServer({ filesDir, rateLimitPerMin: 0, uploadLimitPerMin: 0, exemptLoopback: false, trustProxy: false, logLevel: "silent" });
  registerApi(app, {
    views,
    health: async () => ({
      ok: true,
      slot: 5,
      lastIndexedSlot: 5,
      lagSlots: 0,
      wsConnected: true,
      genesisHash: "g",
      program: { id: "p", deployed: true, configInitialized: true },
    }),
    hub: new Hub(),
    uploader: createUploader({ storage: "local", pinataJwt: null, pinataGateway: "https://ipfs.io/ipfs", filesDir, publicUrl: "http://127.0.0.1:8790" }),
    ingestToken: TOKEN,
    onTargetTrades: (rows) => {
      ingested.push(rows);
      for (const r of rows) store.upsertTargetTrade(r);
    },
  });
  await app.ready();
});

after(async () => {
  await app.close();
  fs.rmSync(filesDir, { recursive: true, force: true });
});

describe("read API on an empty index", () => {
  test("/api/stats returns zeros", async () => {
    const res = await app.inject({ method: "GET", url: "/api/stats" });
    assert.equal(res.statusCode, 200);
    const s = res.json();
    assert.equal(s.copiers, 0);
    assert.equal(s.tvlLamports, "0");
    assert.equal(s.avgLagMs, null);
    assert.equal(res.headers["access-control-allow-origin"], "*");
  });

  test("lists are empty, unknown copiers 404, bad keys 400", async () => {
    assert.deepEqual((await app.inject({ url: "/api/copiers?sort=tvl" })).json(), []);
    assert.equal((await app.inject({ url: "/api/copiers?sort=volume" })).statusCode, 400);
    assert.equal((await app.inject({ url: `/api/copiers/${COPIER}` })).statusCode, 404);
    assert.equal((await app.inject({ url: "/api/copiers/not-a-key/positions" })).statusCode, 400);
    assert.equal((await app.inject({ url: "/api/feed?types=copy,nope" })).statusCode, 400);
    assert.equal((await app.inject({ url: "/api/burns?limit=0" })).statusCode, 400);
  });

  test("trader profile of an unknown valid wallet is 200 with entry null; directory comes from kols.json", async () => {
    const p = (await app.inject({ url: `/api/traders/${COPIER}` })).json();
    assert.equal(p.entry?.name, "Sample Trader D");
    const unknown = await app.inject({ url: "/api/traders/11111111111111111111111111111112" });
    assert.equal(unknown.statusCode, 200);
    assert.equal(unknown.json().entry, null);
    const dir = (await app.inject({ url: "/api/traders?q=sample_trader_a" })).json();
    assert.equal(dir.items[0].address, TARGET);
    assert.deepEqual(dir.items[0].tags, ["hft"]);
  });

  test("/api/traders validates sort, source, tag and offset", async () => {
    for (const qs of ["sort=nope", "source=kolscan,nope", "tag=Bad%20Tag", "offset=-1", "limit=500"]) {
      assert.equal((await app.inject({ url: `/api/traders?${qs}` })).statusCode, 400, qs);
    }
    const page = (await app.inject({ url: "/api/traders?source=curated&tag=-hft&sort=rank&limit=5&offset=2" })).json();
    assert.equal(page.offset, 2);
    assert.equal(page.items.length, 5);
    assert.ok(page.items.every((e: { tags: string[]; sources: string[] }) => !e.tags.includes("hft") && e.sources.includes("curated")));
  });

  test("inherited Object.prototype names and repeated params are 400, not 500", async () => {
    for (const url of [
      "/api/traders?sort=valueOf",
      "/api/traders?sort=__proto__",
      "/api/traders?source=constructor",
      "/api/copiers?sort=constructor",
      "/api/copiers?kind=toString",
      `/api/copiers/${COPIER}/equity?range=toString`,
      `/api/copiers/${COPIER}/candles?range=hasOwnProperty`,
      "/api/feed?types=valueOf",
      "/api/traders?sort=score&sort=rank",
    ]) {
      const res = await app.inject({ url });
      assert.equal(res.statusCode, 400, url);
      assert.match(res.json().error, /must/, url);
    }
  });

  test("/api/platform-token before set_platform_mint", async () => {
    const t = (await app.inject({ url: "/api/platform-token" })).json();
    assert.equal(t.mint, null);
    assert.deepEqual(t.targets, []);
  });
});

describe("POST /internal/target-trades", () => {
  test("rejects a missing or wrong bearer token", async () => {
    const none = await app.inject({ method: "POST", url: "/internal/target-trades", payload: { trades: [report()] } });
    assert.equal(none.statusCode, 401);
    const wrong = await app.inject({ method: "POST", url: "/internal/target-trades", headers: { authorization: "Bearer nope" }, payload: { trades: [report()] } });
    assert.equal(wrong.statusCode, 401);
  });

  test("validates every trade and rejects the whole batch on one bad entry", async () => {
    const auth = { authorization: `Bearer ${TOKEN}` };
    const bad = [
      { trades: [] },
      { trades: [report({ signature: "short" })] },
      { trades: [report({ status: "skipped", reason: null })] },
      { trades: [report({ status: "copied", reason: null, vaultSignature: null })] },
      { trades: [report(), report({ tokenDelta: "1.5" })] },
      { trades: [report({ reason: "made_up" })] },
    ];
    for (const payload of bad) {
      const res = await app.inject({ method: "POST", url: "/internal/target-trades", headers: auth, payload });
      assert.equal(res.statusCode, 400, JSON.stringify(payload).slice(0, 120));
    }
    assert.equal(ingested.length, 0);
  });

  test("accepts a batch and upserts on (copier, signature)", async () => {
    const auth = { authorization: `Bearer ${TOKEN}` };
    const first = await app.inject({ method: "POST", url: "/internal/target-trades", headers: auth, payload: { trades: [report()] } });
    assert.deepEqual(first.json(), { accepted: 1 });
    const second = await app.inject({
      method: "POST",
      url: "/internal/target-trades",
      headers: auth,
      payload: { trades: [report({ status: "copied", reason: null, vaultSignature: "3".repeat(88), vaultSolIn: "1000000" })] },
    });
    assert.equal(second.statusCode, 200);
    const rows = store.copies(COPIER, 10);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.status, "copied");
    assert.equal(rows[0]?.vault_sig, "3".repeat(88));
  });
});

describe("POST /api/upload (local storage)", () => {
  const PNG = Buffer.from(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082",
    "hex",
  );
  const form = (image: Buffer, fields: Record<string, string>) => {
    const fd = new FormData();
    fd.append("image", new Blob([new Uint8Array(image)]), "coin.png");
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    return fd;
  };
  const post = async (fd: FormData) => {
    const req = new Request("http://x/api/upload", { method: "POST", body: fd });
    return app.inject({
      method: "POST",
      url: "/api/upload",
      headers: { "content-type": req.headers.get("content-type")! },
      payload: Buffer.from(await req.arrayBuffer()),
    });
  };

  test("stores image + pump-style metadata JSON and serves both", async () => {
    const res = await post(form(PNG, { name: "Sample D Copier", symbol: "CSAMPD", description: "copies Sample Trader D", twitter: "sample_trader_d" }));
    assert.equal(res.statusCode, 200, res.body);
    const { uri, image } = res.json();
    assert.match(uri, /^http:\/\/127\.0\.0\.1:8790\/files\/meta\/[\w-]+\.json$/);
    const meta = (await app.inject({ url: new URL(uri).pathname })).json();
    assert.deepEqual(meta, {
      name: "Sample D Copier",
      symbol: "CSAMPD",
      description: "copies Sample Trader D",
      image,
      showName: true,
      createdOn: "https://pump.fun",
      twitter: "sample_trader_d",
    });
    const img = await app.inject({ url: new URL(image).pathname });
    assert.equal(img.statusCode, 200);
    assert.equal(img.rawPayload.length, PNG.length);
  });

  test("rejects non-images (sniffed, not trusted from the filename) and over-long symbols", async () => {
    assert.equal((await post(form(Buffer.from("<html>hi</html>"), { name: "x", symbol: "X" }))).statusCode, 400);
    assert.equal((await post(form(PNG, { name: "x", symbol: "TOOLONGSYMBOL" }))).statusCode, 400);
  });
});
