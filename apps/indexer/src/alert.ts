/**
 * Operator alerts (`ALERT_WEBHOOK_URL`): one JSON POST per event, carrying both `text` (Slack) and `content`
 * (Discord) so either webhook kind works unchanged. Delivery is best effort: a failure is logged, never retried, and
 * never blocks indexing — `pnpm ops:check` stays the scheduled source of truth.
 */
import type { FastifyBaseLogger } from "fastify";

const TIMEOUT_MS = 5_000;
/** Discord rejects `content` over 2000 characters. */
const MAX_LEN = 1_900;

export type Alert = (message: string) => void;

export function webhookAlert(url: string | null, log: FastifyBaseLogger): Alert {
  if (!url) return () => {};
  return (message) => {
    const text = message.length > MAX_LEN ? `${message.slice(0, MAX_LEN - 1)}…` : message;
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, content: text }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
      .then((res) => {
        if (!res.ok) log.warn({ status: res.status }, "alert webhook rejected the alert");
      })
      .catch((err: unknown) => log.warn({ error: err instanceof Error ? err.message : String(err) }, "alert webhook unreachable"));
  };
}
