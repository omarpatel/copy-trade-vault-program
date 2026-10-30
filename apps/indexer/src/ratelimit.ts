import type { FastifyInstance } from "fastify";

const WINDOW_MS = 60_000;

/** Fixed one-minute request windows per key (client IP). */
export class Limiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  constructor(readonly perMin: number) {}

  /** Counts one request; null while within budget, else the seconds until the window resets. */
  hit(key: string, now: number): { wait: number; first: boolean } | null {
    let w = this.windows.get(key);
    if (!w || w.resetAt <= now) {
      w = { count: 0, resetAt: now + WINDOW_MS };
      this.windows.set(key, w);
    }
    w.count += 1;
    if (w.count <= this.perMin) return null;
    return { wait: Math.ceil((w.resetAt - now) / 1000), first: w.count - 1 === this.perMin };
  }

  sweep(now: number): void {
    for (const [key, w] of this.windows) if (w.resetAt <= now) this.windows.delete(key);
  }
}

const LOOPBACK: Record<string, true> = { "127.0.0.1": true, "::1": true, "::ffff:127.0.0.1": true };

/**
 * Per-IP limits: a general budget across every route (0 disables) and a tight one for `POST /api/upload` (it pins
 * files on IPFS). Over-budget requests get 429 + `Retry-After`. `/internal/*` is bearer-authenticated and exempt.
 * On localnet loopback clients (the seed scripts) are exempt too.
 */
export function registerRateLimits(app: FastifyInstance, opts: { perMin: number; uploadPerMin: number; exemptLoopback: boolean }): void {
  const all = opts.perMin > 0 ? new Limiter(opts.perMin) : null;
  const upload = opts.uploadPerMin > 0 ? new Limiter(opts.uploadPerMin) : null;
  if (!all && !upload) return;
  const sweeper = setInterval(() => {
    const now = Date.now();
    all?.sweep(now);
    upload?.sweep(now);
  }, WINDOW_MS);
  sweeper.unref();
  app.addHook("onClose", async () => clearInterval(sweeper));

  app.addHook("onRequest", async (req, reply) => {
    const route = req.routeOptions.url ?? "";
    if (route.startsWith("/internal/")) return;
    if (opts.exemptLoopback && LOOPBACK[req.ip]) return;
    const now = Date.now();
    const isUpload = req.method === "POST" && route === "/api/upload";
    for (const limiter of isUpload ? [all, upload] : [all]) {
      if (!limiter) continue;
      const over = limiter.hit(req.ip, now);
      if (!over) continue;
      if (over.first) req.log.warn({ ip: req.ip, url: req.url, perMin: limiter.perMin }, "rate limit hit");
      return reply
        .code(429)
        .header("Retry-After", String(over.wait))
        .send({ error: `rate limit exceeded (${limiter.perMin} requests/min); retry in ${over.wait}s` });
    }
  });
}
