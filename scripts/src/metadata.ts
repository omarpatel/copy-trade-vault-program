/**
 * Coin / avatar metadata through the indexer's `POST /api/upload` (on localnet it stores the files itself and
 * serves them under /files). When no indexer answers, `withIndexer` runs one for the duration of the work.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { INDEXER_URL, ROOT, STATE_DIR, reachable } from "./common";
import { logoPng, type LogoDesign } from "./png";

export interface Upload {
  /** Metadata JSON URI (what `create_v2` stores). */
  uri: string;
  /** Image URL. */
  image: string;
}

export async function upload(p: {
  name: string;
  symbol: string;
  description?: string;
  design: LogoDesign;
  twitter?: string;
  website?: string;
}): Promise<Upload> {
  const form = new FormData();
  form.append("image", new Blob([new Uint8Array(logoPng(p.design))], { type: "image/png" }), `${p.symbol}.png`);
  form.append("name", p.name);
  form.append("symbol", p.symbol);
  if (p.description) form.append("description", p.description);
  if (p.twitter) form.append("twitter", p.twitter);
  if (p.website) form.append("website", p.website);
  // A restarting indexer drops connections for a few seconds: retry those, never HTTP errors.
  let res: Response | null = null;
  for (let attempt = 1; !res; attempt++) {
    res = await fetch(`${INDEXER_URL}/api/upload`, { method: "POST", body: form, signal: AbortSignal.timeout(30_000) }).catch((err: unknown) => {
      if (attempt >= 15) throw new Error(`upload ${p.symbol}: indexer unreachable at ${INDEXER_URL} (${String(err)})`);
      return null;
    });
    if (!res) await sleep(2_000);
  }
  const body = (await res.json().catch(() => ({}))) as { uri?: string; image?: string; error?: string };
  if (!res.ok || !body.uri || !body.image) throw new Error(`upload ${p.symbol} failed: HTTP ${res.status} ${body.error ?? ""}`);
  return { uri: body.uri, image: body.image };
}

/**
 * Runs `work` with an indexer answering on INDEXER_URL: the running one, or `pnpm --filter @copy-trade-vault/indexer start`
 * started for the occasion (log: .localnet/indexer-seed.log) and stopped afterwards.
 */
export async function withIndexer<T>(work: () => Promise<T>): Promise<T> {
  const health = `${INDEXER_URL}/api/health`;
  if (await reachable(health)) return work();
  const logFile = path.join(STATE_DIR, "indexer-seed.log");
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const log = fs.openSync(logFile, "w");
  console.log(`no indexer on ${INDEXER_URL}: starting one for the uploads (log: ${path.relative(ROOT, logFile)})`);
  const win = process.platform === "win32";
  const child = spawn("pnpm --filter @copy-trade-vault/indexer start", {
    cwd: ROOT,
    shell: true,
    detached: !win,
    stdio: ["ignore", log, log],
    windowsHide: true,
  });
  let exited: number | null = null;
  child.on("exit", (code) => (exited = code ?? 1));
  const stop = () => {
    if (exited !== null || child.pid === undefined) return;
    if (win) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    else process.kill(-child.pid, "SIGTERM");
  };
  try {
    const until = Date.now() + 120_000;
    while (!(await reachable(health))) {
      if (exited !== null) throw new Error(`the indexer exited (code ${exited}); see ${path.relative(ROOT, logFile)}`);
      if (Date.now() > until) throw new Error(`the indexer did not come up within 120s; see ${path.relative(ROOT, logFile)}`);
      await sleep(1_000);
    }
    return await work();
  } finally {
    stop();
  }
}
