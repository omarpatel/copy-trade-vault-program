import { once } from "node:events";
import http from "node:http";

/** `GET /status` (JSON, permissive CORS, no-store). */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function startStatusServer(host: string, port: number, status: () => unknown): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS).end();
      return;
    }
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(body, (_, v: unknown) => (typeof v === "bigint" ? v.toString() : v)));
    };
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (pathname !== "/status") send(404, { error: "not found" });
    else if (req.method !== "GET") send(405, { error: "method not allowed" });
    else {
      try {
        send(200, status());
      } catch (err) {
        send(500, { error: err instanceof Error ? err.message : String(err) });
      }
    }
  });
  server.listen(port, host);
  try {
    await once(server, "listening");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new Error(code === "EADDRINUSE" ? `status port ${host}:${port} is already in use (set STATUS_PORT)` : String(err));
  }
  return server;
}
