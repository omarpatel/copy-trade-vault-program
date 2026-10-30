import type { Commitment } from "@solana/web3.js";
import { log } from "./log";

/**
 * One JSON-RPC websocket carrying every subscription the keeper holds:
 * `accountSubscribe` (target lamports), `programSubscribe` (target token accounts under Token / Token-2022) and
 * `slotSubscribe` (liveness: a slot arrives every ~400 ms, so a quiet socket is a dead socket). Reconnects with
 * exponential back-off and re-subscribes everything; `epoch` changes on every new socket so the detector can
 * backfill whatever the gap missed.
 */

const STALE_MS = 10_000;
const HEALTHY_MS = 5_000;
const MIN_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 30_000;
const CONNECT_TIMEOUT_MS = 10_000;
const WATCHDOG_MS = 1_000;

export interface AccountNote {
  lamports: number;
  data: Buffer;
  slot: number;
}

export interface ProgramNote {
  pubkey: string;
  lamports: number;
  data: Buffer;
  slot: number;
}

type Sub =
  | { method: "accountSubscribe"; params: unknown[]; on: (n: AccountNote) => void }
  | { method: "programSubscribe"; params: unknown[]; on: (n: ProgramNote) => void }
  | { method: "slotSubscribe"; params: unknown[]; on: (slot: number) => void };

const UNSUBSCRIBE: Record<Sub["method"], string> = {
  accountSubscribe: "accountUnsubscribe",
  programSubscribe: "programUnsubscribe",
  slotSubscribe: "slotUnsubscribe",
};

export interface StreamStats {
  connected: boolean;
  healthy: boolean;
  subscriptions: number;
  /** Subscriptions the server confirmed on the current socket. */
  active: number;
  /** Subscriptions the server refused on the current socket (e.g. providers that block programSubscribe on Token). */
  refused: number;
  notifications: number;
  reconnects: number;
  lastMessageAt: number | null;
}

/** The union of `slotNotification` / `accountNotification` / `programNotification` results (Solana pubsub spec). */
interface PubsubResult {
  slot?: number;
  context?: { slot: number };
  value?:
    | { data: [string, string]; lamports: number }
    | { pubkey: string; account: { data: [string, string]; lamports: number } }
    | null;
}

export class Stream {
  private ws: WebSocket | null = null;
  private open = false;
  private readonly subs = new Map<number, Sub>();
  private readonly byServer = new Map<number, number>();
  private readonly toServer = new Map<number, number>();
  private readonly refusedLocal = new Set<number>();
  private readonly requests = new Map<number, { local: number; method: Sub["method"] }>();
  private nextLocal = 1;
  private nextRequest = 1;
  private backoffMs = MIN_BACKOFF_MS;
  private connectStartedAt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private readonly watchdog: NodeJS.Timeout;
  private closed = false;
  private lastMessageAt: number | null = null;
  private notifications = 0;
  private reconnects = 0;
  private opens = 0;

  /** Fires after every (re)connect once subscriptions were re-sent: missed notifications must be backfilled. */
  onReconnect: (() => void) | null = null;

  constructor(
    private readonly url: string,
    private readonly commitment: Commitment,
  ) {
    this.watchdog = setInterval(() => this.check(), WATCHDOG_MS);
    this.watchdog.unref();
    this.add({ method: "slotSubscribe", params: [], on: () => undefined });
    this.connect();
  }

  get healthy(): boolean {
    return this.open && this.lastMessageAt !== null && Date.now() - this.lastMessageAt < HEALTHY_MS;
  }

  get epoch(): number {
    return this.opens;
  }

  /** Whether the server refused subscription `id` on the current socket. */
  refused(id: number): boolean {
    return this.refusedLocal.has(id);
  }

  stats(): StreamStats {
    return {
      connected: this.open,
      healthy: this.healthy,
      subscriptions: this.subs.size,
      active: this.toServer.size,
      refused: this.refusedLocal.size,
      notifications: this.notifications,
      reconnects: this.reconnects,
      lastMessageAt: this.lastMessageAt,
    };
  }

  account(address: string, on: (n: AccountNote) => void): number {
    return this.add({ method: "accountSubscribe", params: [address, { encoding: "base64", commitment: this.commitment }], on });
  }

  /** Token accounts of `programId` whose owner field (offset 32) is `owner`. */
  tokenAccountsOf(programId: string, owner: string, on: (n: ProgramNote) => void): number {
    return this.add({
      method: "programSubscribe",
      params: [programId, { encoding: "base64", commitment: this.commitment, filters: [{ memcmp: { offset: 32, bytes: owner } }] }],
      on,
    });
  }

  remove(id: number): void {
    const sub = this.subs.get(id);
    if (!sub) return;
    this.subs.delete(id);
    this.refusedLocal.delete(id);
    const server = this.toServer.get(id);
    if (server === undefined) return;
    this.toServer.delete(id);
    this.byServer.delete(server);
    this.send(UNSUBSCRIBE[sub.method], [server]);
  }

  close(): void {
    this.closed = true;
    clearInterval(this.watchdog);
    clearTimeout(this.reconnectTimer ?? undefined);
    this.ws?.close();
  }

  private add(sub: Sub): number {
    const id = this.nextLocal++;
    this.subs.set(id, sub);
    if (this.open) this.subscribe(id, sub);
    return id;
  }

  private subscribe(id: number, sub: Sub): void {
    const request = this.send(sub.method, sub.params);
    if (request !== null) this.requests.set(request, { local: id, method: sub.method });
  }

  private send(method: string, params: unknown[]): number | null {
    if (!this.ws || !this.open) return null;
    const id = this.nextRequest++;
    this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return id;
  }

  private connect(): void {
    if (this.closed) return;
    this.reconnectTimer = null;
    this.connectStartedAt = Date.now();
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.open = true;
      this.opens += 1;
      this.lastMessageAt = Date.now();
      for (const [id, sub] of this.subs) this.subscribe(id, sub);
      if (this.opens > 1) this.onReconnect?.();
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      this.onMessage(String(ev.data));
    };
    ws.onclose = () => this.dropped(ws, "closed");
    ws.onerror = () => this.dropped(ws, "error");
  }

  private dropped(ws: WebSocket, why: string): void {
    if (this.ws !== ws) return;
    const wasOpen = this.open;
    this.ws = null;
    this.open = false;
    this.byServer.clear();
    this.toServer.clear();
    this.requests.clear();
    this.refusedLocal.clear();
    try {
      ws.close();
    } catch {
      // already closing
    }
    if (this.closed) return;
    this.reconnects += 1;
    log("ws_reconnect", { why, wasOpen, retryInMs: this.backoffMs, origin: new URL(this.url).origin });
    this.reconnectTimer = setTimeout(() => this.connect(), this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
  }

  private check(): void {
    if (!this.ws) return;
    const now = Date.now();
    if (!this.open && now - this.connectStartedAt > CONNECT_TIMEOUT_MS) this.dropped(this.ws, "connect timeout");
    else if (this.open && this.lastMessageAt !== null && now - this.lastMessageAt > STALE_MS) this.dropped(this.ws, "stale");
  }

  private onMessage(raw: string): void {
    this.lastMessageAt = Date.now();
    let msg: { id?: number; result?: unknown; error?: { message?: string }; params?: { subscription: number; result: PubsubResult } };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.id !== undefined) {
      const req = this.requests.get(msg.id);
      if (req === undefined) return;
      this.requests.delete(msg.id);
      if (msg.error || typeof msg.result !== "number") {
        this.refusedLocal.add(req.local);
        log("ws_subscribe_refused", { method: req.method, error: msg.error?.message ?? "no subscription id" });
        return;
      }
      if (!this.subs.has(req.local)) {
        this.send(UNSUBSCRIBE[req.method], [msg.result]);
        return;
      }
      this.byServer.set(msg.result, req.local);
      this.toServer.set(req.local, msg.result);
      this.backoffMs = MIN_BACKOFF_MS;
      return;
    }
    if (!msg.params) return;
    const local = this.byServer.get(msg.params.subscription);
    const sub = local === undefined ? undefined : this.subs.get(local);
    if (!sub) return;
    this.notifications += 1;
    const r = msg.params.result;
    if (sub.method === "slotSubscribe") {
      if (typeof r.slot === "number") sub.on(r.slot);
      return;
    }
    const slot = r.context?.slot ?? 0;
    if (sub.method === "accountSubscribe") {
      const v = r.value;
      if (!v || !("data" in v)) return;
      sub.on({ lamports: v.lamports, data: Buffer.from(v.data[0], "base64"), slot });
    } else {
      const v = r.value;
      if (!v || !("account" in v)) return;
      sub.on({ pubkey: v.pubkey, lamports: v.account.lamports, data: Buffer.from(v.account.data[0], "base64"), slot });
    }
  }
}
