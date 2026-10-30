import type { TargetTradeIngest, TargetTradesIngestBody } from "@copy-trade-vault/sdk/api";
import { errMsg, log } from "./log";
import type { State } from "./state";

/**
 * Delivers every observed target trade + decision to the indexer (`POST /internal/target-trades`, bearer
 * `INDEXER_INGEST_TOKEN`). Reports go through the SQLite outbox first, so an indexer outage or a keeper restart
 * loses nothing; the indexer upserts on (copier, signature), so re-delivery is harmless. A batch the indexer rejects
 * as invalid (400) is retried item by item so one bad report cannot block the rest; a single invalid item is dropped
 * with a log line.
 */

const BATCH = 50;
const FLUSH_MS = 1_000;

export interface ReporterStats {
  pending: number;
  delivered: number;
  dropped: number;
  lastError: string | null;
  lastDeliveredAt: number | null;
}

export class Reporter {
  private timer: NodeJS.Timeout | null = null;
  private flushing = false;
  private deliveredCount = 0;
  private droppedCount = 0;
  private lastError: string | null = null;
  private lastDeliveredAt: number | null = null;

  constructor(
    private readonly state: State,
    private readonly url: string,
    private readonly token: string | null,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.flush(), FLUSH_MS);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer ?? undefined);
  }

  report(trades: TargetTradeIngest[]): void {
    if (trades.length === 0) return;
    this.state.enqueue(trades);
    void this.flush();
  }

  stats(): ReporterStats {
    return {
      pending: this.state.outboxSize(),
      delivered: this.deliveredCount,
      dropped: this.droppedCount,
      lastError: this.lastError,
      lastDeliveredAt: this.lastDeliveredAt,
    };
  }

  async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      for (;;) {
        const items = this.state.due(BATCH);
        if (items.length === 0) return;
        const status = await this.post(items.map((i) => i.trade));
        if (status === 200) {
          this.state.removeFromOutbox(items.map((i) => i.id));
          this.deliveredCount += items.length;
          this.lastDeliveredAt = Date.now();
          continue;
        }
        if (status === 400) {
          for (const item of items) {
            const single = items.length === 1 ? status : await this.post([item.trade]);
            if (single === 200) {
              this.deliveredCount += 1;
              this.state.removeFromOutbox([item.id]);
            } else if (single === 400) {
              this.droppedCount += 1;
              this.state.removeFromOutbox([item.id]);
              log("report_dropped", { copier: item.trade.copier, signature: item.trade.signature, error: this.lastError });
            } else {
              this.state.retryLater([item.id], item.attempts);
            }
          }
          continue;
        }
        const attempts = Math.max(...items.map((i) => i.attempts));
        this.state.retryLater(items.map((i) => i.id), attempts);
        // Log the first failure of an outage and then every few attempts, not every second.
        if (attempts === 0 || attempts % 5 === 0) log("report_retry", { pending: this.state.outboxSize(), attempts, error: this.lastError });
        return;
      }
    } finally {
      this.flushing = false;
    }
  }

  /** HTTP status, or 0 when the request did not complete. */
  private async post(trades: TargetTradeIngest[]): Promise<number> {
    const body: TargetTradesIngestBody = { trades };
    try {
      const res = await fetch(`${this.url}/internal/target-trades`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      const text = await res.text();
      if (res.status !== 200) this.lastError = `HTTP ${res.status}: ${text.slice(0, 300)}`;
      return res.status;
    } catch (err) {
      this.lastError = errMsg(err);
      return 0;
    }
  }
}
