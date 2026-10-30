import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import zlib from "node:zlib";
import { politeBytes, request, type RawResponse } from "./directory-sources/util";
import { assertPublicUrl, BodyTooLargeError, isPrivateIp, resolvePublic, UnfetchableUriError } from "./net-guard";

const MiB = 1024 * 1024;
let server: http.Server;
let base: string;
let hits = 0;

before(async () => {
  // 64 MiB of zeros gzip to ~64 KB: Content-Length looks harmless, the decoded body is not.
  const bomb = zlib.gzipSync(Buffer.alloc(64 * MiB));
  server = http.createServer((req, res) => {
    hits++;
    if (req.url === "/gzip") {
      res.writeHead(200, { "content-type": "image/png", "content-encoding": "gzip", "content-length": bomb.length });
      res.end(bomb);
    } else if (req.url === "/chunked") {
      // No Content-Length; streams until the client hangs up.
      res.writeHead(200, { "content-type": "image/png" });
      const chunk = Buffer.alloc(256 * 1024);
      const pump = () => {
        while (res.write(chunk));
      };
      res.on("drain", pump);
      pump();
      req.on("close", () => res.destroy());
    } else {
      res.writeHead(200).end("ok");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

describe("bounded downloads", () => {
  test("a gzip body whose decoded size exceeds the cap aborts", async () => {
    await assert.rejects(politeBytes(`${base}/gzip`, { maxBytes: 5 * MiB, minGapMs: 0, retries: 0 }), BodyTooLargeError);
  });

  test("a chunked body without Content-Length aborts at the cap, not the timeout", async () => {
    const t0 = Date.now();
    await assert.rejects(politeBytes(`${base}/chunked`, { maxBytes: MiB, minGapMs: 0, retries: 0, timeoutMs: 30_000 }), BodyTooLargeError);
    assert.ok(Date.now() - t0 < 10_000);
  });

  test("bodies under the cap pass", async () => {
    assert.equal((await politeBytes(`${base}/ok`, { maxBytes: 16, minGapMs: 0, retries: 0 })).toString(), "ok");
  });
});

describe("SSRF guard", () => {
  test("private, loopback, CGNAT, link-local, ULA and mapped addresses are private", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "100.64.0.1",
      "100.127.255.255",
      "169.254.169.254",
      "0.0.0.0",
      "::1",
      "::",
      "fc00::1",
      "fd12:3456::1",
      "fe80::1",
      "::ffff:127.0.0.1",
      "::ffff:10.0.0.1",
      "::ffff:a9fe:a9fe",
    ]) {
      assert.ok(isPrivateIp(ip), ip);
    }
    for (const ip of ["8.8.8.8", "104.16.0.1", "100.128.0.1", "172.32.0.1", "2606:4700::1111"]) assert.ok(!isPrivateIp(ip), ip);
  });

  test("private literals, internal names and non-https are rejected", () => {
    for (const url of [
      "https://127.0.0.1/a.png",
      "https://[::1]/a.png",
      "https://[::ffff:169.254.169.254]/",
      "https://169.254.169.254/latest/meta-data/",
      "https://100.64.1.1/",
      "https://[fd00::1]/",
      "https://localhost/",
      "https://foo.localhost/",
      "https://copier-keeper.railway.internal:8792/status",
      "https://printer.local/",
      "https://intranet/",
      "http://pbs.twimg.com/a.jpg",
      "file:///etc/passwd",
    ]) {
      assert.throws(() => assertPublicUrl(new URL(url), ["https:"]), UnfetchableUriError, url);
    }
    assert.doesNotThrow(() => assertPublicUrl(new URL("https://pbs.twimg.com/a.jpg"), ["https:"]));
  });

  test("names resolving to private addresses are rejected after DNS", async () => {
    await assert.rejects(resolvePublic("localhost"), UnfetchableUriError);
  });

  test("redirects are re-vetted per hop and capped at 3", async () => {
    const seen: string[] = [];
    const hopTo = (targets: string[]) => async (url: string): Promise<RawResponse> => {
      seen.push(url);
      const location = targets.shift() ?? null;
      return { status: location ? 302 : 200, body: Buffer.from("img"), retryAfter: null, location };
    };
    for (const target of ["https://10.0.0.5/x", "https://[::ffff:7f00:1]/", "http://cdn.example.com/x", "https://metadata.google.internal/", "https://192.168.0.1/"]) {
      seen.length = 0;
      await assert.rejects(request("https://cdn.example.com/a.png", { publicOnly: true }, {}, hopTo([target])), UnfetchableUriError, target);
      assert.deepEqual(seen, ["https://cdn.example.com/a.png"], target);
    }
    const ok = await request("https://cdn.example.com/a.png", { publicOnly: true }, {}, hopTo(["https://cdn2.example.com/b.png", "/c.png"]));
    assert.equal(ok.status, 200);
    await assert.rejects(
      request("https://cdn.example.com/a", { publicOnly: true }, {}, hopTo(["/1", "/2", "/3", "/4"])),
      /more than 3 redirects/,
    );
  });

  test("an untrusted fetch never connects to a private address", async () => {
    const before = hits;
    await assert.rejects(politeBytes(`${base}/ok`, { publicOnly: true, minGapMs: 0, retries: 0 }), UnfetchableUriError);
    await assert.rejects(politeBytes(base.replace("http:", "https:") + "/ok", { publicOnly: true, minGapMs: 0, retries: 0 }), UnfetchableUriError);
    assert.equal(hits, before);
  });
});
