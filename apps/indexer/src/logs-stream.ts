import type { FastifyBaseLogger } from "fastify";
import WebSocket from "ws";

export interface LogsNotification {
  signature: string;
  err: unknown;
  logs: string[];
  slot: number;
}

export interface LogsStreamHandlers {
  /** Logs of a transaction mentioning `address` (one of the watched addresses). */
  onLogs(address: string, n: LogsNotification): void;
  /** Called every time a (re)subscription of `address` is confirmed. */
  onSubscribed(address: string): void;
}

const HEARTBEAT_MS = 15_000;
const HANDSHAKE_TIMEOUT_MS = 10_000;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

/**
 * One `logsSubscribe` (mentions: address, confirmed) per watched address over a dedicated socket: the Copier
 * program plus every copier's pump fee-sharing config. Reconnects with jittered exponential backoff (1s → 30s)
 * after validator restarts or network drops (re-subscribing everything), and detects half-open sockets with
 * ping/pong. Delivery is best effort: the signature pollers fill any gap.
 */
export class LogsStream {
  private socket: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private attempt = 0;
  private closed = false;
  private downSince: number | null = null;
  private lastError: string | null = null;
  private nextId = 1;
  /** Watched address → its live subscription id (null while the request is pending or the socket is down). */
  private readonly watched = new Map<string, number | null>();
  /** Pending `logsSubscribe` / `logsUnsubscribe` request ids → the address they concern. */
  private readonly pending = new Map<number, { address: string; unsubscribe: boolean }>();
  private readonly byId = new Map<number, string>();

  constructor(
    private readonly url: string,
    private readonly handlers: LogsStreamHandlers,
    private readonly log: FastifyBaseLogger,
  ) {}

  /** True while the server confirmed the subscription for `address` on the current socket. */
  isSubscribed(address: string): boolean {
    return typeof this.watched.get(address) === "number";
  }

  start(): void {
    this.connect();
  }

  /** Adds an address to the subscription set (subscribes now when the socket is open; otherwise on connect). */
  watch(address: string): void {
    if (this.watched.has(address)) return;
    this.watched.set(address, null);
    if (this.socket?.readyState === WebSocket.OPEN) this.subscribe(this.socket, address);
  }

  unwatch(address: string): void {
    const id = this.watched.get(address);
    if (id === undefined) return;
    this.watched.delete(address);
    if (typeof id !== "number") return;
    this.byId.delete(id);
    if (this.socket?.readyState === WebSocket.OPEN) {
      const reqId = this.nextId++;
      this.pending.set(reqId, { address, unsubscribe: true });
      this.socket.send(JSON.stringify({ jsonrpc: "2.0", id: reqId, method: "logsUnsubscribe", params: [id] }));
    }
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.stopHeartbeat();
    const socket = this.socket;
    this.socket = null;
    this.dropSubscriptions();
    if (socket) {
      socket.removeAllListeners();
      socket.on("error", () => undefined);
      if (socket.readyState === WebSocket.OPEN) socket.close(1000, "indexer shutting down");
      else socket.terminate();
    }
  }

  private dropSubscriptions(): void {
    for (const address of this.watched.keys()) this.watched.set(address, null);
    this.pending.clear();
    this.byId.clear();
  }

  private subscribe(socket: WebSocket, address: string): void {
    const reqId = this.nextId++;
    this.pending.set(reqId, { address, unsubscribe: false });
    socket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: reqId,
        method: "logsSubscribe",
        params: [{ mentions: [address] }, { commitment: "confirmed" }],
      }),
    );
  }

  private connect(): void {
    if (this.closed) return;
    const socket = new WebSocket(this.url, { handshakeTimeout: HANDSHAKE_TIMEOUT_MS });
    this.socket = socket;
    let awaitingPong = false;
    socket.on("open", () => {
      for (const address of this.watched.keys()) this.subscribe(socket, address);
      this.stopHeartbeat();
      this.heartbeat = setInterval(() => {
        if (awaitingPong) {
          this.lastError = "no pong within heartbeat interval";
          socket.terminate();
          return;
        }
        awaitingPong = true;
        socket.ping();
      }, HEARTBEAT_MS);
    });
    socket.on("pong", () => {
      awaitingPong = false;
    });
    socket.on("message", (data) => this.onMessage(socket, data.toString()));
    socket.on("error", (err) => {
      this.lastError = err.message || String(err);
    });
    socket.on("close", () => this.onClose(socket));
  }

  private onMessage(socket: WebSocket, raw: string): void {
    let msg: {
      id?: number;
      result?: unknown;
      error?: { message?: string };
      method?: string;
      params?: {
        subscription?: number;
        result?: { context?: { slot?: number }; value?: { signature?: string; err?: unknown; logs?: string[] } };
      };
    };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof msg.id === "number") {
      const req = this.pending.get(msg.id);
      if (!req) return;
      this.pending.delete(msg.id);
      if (req.unsubscribe) return;
      // `unwatch` raced the reply: release the subscription the server just confirmed.
      if (!this.watched.has(req.address)) {
        if (typeof msg.result === "number") {
          const reqId = this.nextId++;
          this.pending.set(reqId, { address: req.address, unsubscribe: true });
          socket.send(JSON.stringify({ jsonrpc: "2.0", id: reqId, method: "logsUnsubscribe", params: [msg.result] }));
        }
        return;
      }
      if (msg.error || typeof msg.result !== "number") {
        this.lastError = `logsSubscribe rejected: ${msg.error?.message ?? raw.slice(0, 120)}`;
        socket.terminate();
        return;
      }
      this.watched.set(req.address, msg.result);
      this.byId.set(msg.result, req.address);
      const retries = this.attempt;
      this.attempt = 0;
      if (this.downSince !== null) {
        this.log.info({ downMs: Date.now() - this.downSince, retries }, "logs websocket reconnected");
      } else if (retries > 0 || !this.lastError) {
        this.log.debug({ address: req.address }, "logs subscription confirmed");
      }
      this.downSince = null;
      this.lastError = null;
      this.handlers.onSubscribed(req.address);
      return;
    }
    if (msg.method !== "logsNotification") return;
    const res = msg.params?.result;
    const value = res?.value;
    const address = typeof msg.params?.subscription === "number" ? this.byId.get(msg.params.subscription) : undefined;
    if (!address || !value?.signature || typeof res?.context?.slot !== "number") return;
    this.handlers.onLogs(address, {
      signature: value.signature,
      err: value.err ?? null,
      logs: value.logs ?? [],
      slot: res.context.slot,
    });
  }

  private onClose(socket: WebSocket): void {
    if (socket !== this.socket) return;
    this.stopHeartbeat();
    this.socket = null;
    const wasSubscribed = this.byId.size > 0;
    this.dropSubscriptions();
    if (this.closed) return;
    if (wasSubscribed) {
      this.downSince = Date.now();
      this.log.warn({ reason: this.lastError ?? "closed by server" }, "logs websocket lost; poller covers the gap while reconnecting");
    } else if (this.downSince === null) {
      this.downSince = Date.now();
      this.log.warn({ origin: new URL(this.url).origin, reason: this.lastError ?? "closed" }, "logs websocket unavailable; retrying with backoff");
    }
    const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** this.attempt);
    const delay = Math.round(base * (0.8 + Math.random() * 0.4));
    this.attempt += 1;
    this.log.debug({ attempt: this.attempt, delayMs: delay, reason: this.lastError }, "logs websocket reconnect scheduled");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }
}
