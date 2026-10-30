import fs from "node:fs";
import path from "node:path";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify, { LogController, type FastifyInstance } from "fastify";
import type { Hub } from "./hub";
import { registerIngest } from "./ingest";
import type { TargetTradeRow } from "./db";
import { registerRateLimits } from "./ratelimit";
import { registerRoutes, type RouteDeps } from "./routes";
import { HttpError, NotFoundError, ValidationError } from "./sanitize";
import { MAX_IMAGE_BYTES, registerUpload, type Uploader } from "./upload";

export interface ServerOptions {
  filesDir: string;
  rateLimitPerMin: number;
  uploadLimitPerMin: number;
  /** Loopback clients skip rate limits (localnet seed scripts). */
  exemptLoopback: boolean;
  trustProxy: boolean | string;
  logLevel?: string;
}

const statusOf = (err: unknown): number => {
  if (err instanceof ValidationError) return 400;
  if (err instanceof NotFoundError) return 404;
  const code = typeof err === "object" && err !== null && "statusCode" in err ? err.statusCode : undefined;
  return typeof code === "number" && code >= 400 && code < 600 ? code : 500;
};

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
};

/** Fastify instance with plugins, error handling and `/files` static serving (local uploads). */
export async function createServer(opts: ServerOptions): Promise<FastifyInstance> {
  for (const dir of ["img", "meta", "avatars"]) fs.mkdirSync(path.join(opts.filesDir, dir), { recursive: true });
  const app = Fastify({
    logger: {
      level: opts.logLevel ?? process.env.LOG_LEVEL ?? "info",
      base: null,
      timestamp: () => `,"time":"${new Date().toISOString()}"`,
    },
    logController: new LogController({ disableRequestLogging: true }),
    trustProxy: opts.trustProxy,
  });
  app.setErrorHandler((err, req, reply) => {
    const status = statusOf(err);
    const intended = err instanceof HttpError;
    if (status >= 500 && !intended) req.log.error({ err, url: req.url }, "request failed");
    const message = intended || (status < 500 && err instanceof Error) ? err.message : "internal server error";
    void reply.status(status).send({ error: message });
  });
  app.setNotFoundHandler((_req, reply) => {
    void reply.status(404).send({ error: "not found" });
  });
  app.addHook("onRequest", async (_req, reply) => {
    void reply.headers(SECURITY_HEADERS);
  });
  // Repeated `?k=a&k=b` parses to an array; handlers expect one string per key.
  app.addHook("preHandler", async (req) => {
    const q = req.query;
    if (q && typeof q === "object" && Object.values(q).some((v) => typeof v !== "string")) throw new ValidationError("query parameters must not repeat");
  });
  await app.register(cors, { origin: "*", methods: ["GET", "POST", "OPTIONS"] });
  // After CORS so 429s still carry Access-Control-Allow-Origin.
  registerRateLimits(app, { perMin: opts.rateLimitPerMin, uploadPerMin: opts.uploadLimitPerMin, exemptLoopback: opts.exemptLoopback });
  await app.register(multipart, {
    throwFileSizeLimit: true,
    limits: { fileSize: MAX_IMAGE_BYTES, files: 1, fields: 10, parts: 12, fieldSize: 8 * 1024 },
  });
  // Clients never send anything over /ws.
  await app.register(websocket, { options: { maxPayload: 4 * 1024 } });
  await app.register(fastifyStatic, {
    root: opts.filesDir,
    prefix: "/files/",
    index: false,
    list: false,
    dotfiles: "deny",
    decorateReply: false,
    maxAge: "365d",
    immutable: true,
  });
  return app;
}

/** `/ws`, the JSON API, uploads and the keeper ingest. */
export function registerApi(
  app: FastifyInstance,
  deps: RouteDeps & { hub: Hub; uploader: Uploader; ingestToken: string; onTargetTrades: (rows: TargetTradeRow[]) => void },
): void {
  app.get("/ws", { websocket: true }, (socket) => deps.hub.add(socket));
  registerRoutes(app, deps);
  registerUpload(app, deps.uploader);
  registerIngest(app, { token: deps.ingestToken, onTrades: deps.onTargetTrades });
}
