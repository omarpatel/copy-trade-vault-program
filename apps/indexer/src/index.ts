import { Connection } from "@solana/web3.js";
import { webhookAlert } from "./alert";
import { config } from "./config";
import { Store } from "./db";
import { Directory } from "./directory";
import { Hub } from "./hub";
import { Market } from "./market";
import { createServer, registerApi } from "./server";
import { ChainSync } from "./sync";
import { createUploader } from "./upload";
import { Views } from "./views";

/** Hard stop if a hung RPC call keeps the sync queue from draining. */
const SHUTDOWN_TIMEOUT_MS = 5_000;

// Live logs use the sync's own reconnecting websocket; this connection only makes HTTP calls.
const connection = new Connection(config.rpcUrl, { commitment: "confirmed" });
const store = new Store(config.dbPath);
const hub = new Hub();

const app = await createServer({
  filesDir: config.filesDir,
  rateLimitPerMin: config.rateLimitPerMin,
  uploadLimitPerMin: config.uploadLimitPerMin,
  exemptLoopback: config.localnet,
  trustProxy: config.trustProxy,
});
const directory = new Directory({
  store,
  localnetFile: config.localnetKols,
  filesDir: config.filesDir,
  publicUrl: config.publicUrl,
  log: app.log.child({ module: "directory" }),
});
const views = new Views(store, directory);
const market = new Market(store, connection, app.log.child({ module: "market" }));
const chain = new ChainSync(store, connection, hub, views, market, app.log.child({ module: "sync" }), {
  rpcUrl: config.rpcUrl,
  wsUrl: config.wsUrl,
  pollMs: config.pollMs,
  refreshMs: config.refreshMs,
  feesPollMs: config.feesPollMs,
  snapshotMs: config.snapshotMs,
  chainCheckMs: config.chainCheckMs,
  localnet: config.localnet,
  publicUrl: config.publicUrl,
  filesDir: config.filesDir,
  alert: webhookAlert(config.alertWebhookUrl, app.log.child({ module: "alert" })),
});

registerApi(app, {
  views,
  health: () => chain.health(),
  hub,
  uploader: createUploader({
    storage: config.uploadStorage,
    pinataJwt: config.pinataJwt,
    pinataGateway: config.pinataGateway,
    filesDir: config.filesDir,
    publicUrl: config.publicUrl,
  }),
  ingestToken: config.ingestToken,
  onTargetTrades: (rows) => chain.ingestTargetTrades(rows),
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "shutting down");
  const timer = setTimeout(() => {
    app.log.warn("shutdown timed out; exiting");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  timer.unref();
  directory.stop();
  await chain.stop();
  hub.close();
  await app.close();
  store.close();
  process.exit(0);
}
// SIGBREAK: Ctrl+Break on Windows consoles.
for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"] as const) process.on(signal, () => void shutdown(signal));

await app.listen({ port: config.port, host: config.host });
app.log.info(
  {
    port: config.port,
    // Origins only: keyed RPC URLs (`?api-key=`) must not reach the host's log store.
    rpc: new URL(config.rpcUrl).origin,
    ws: new URL(config.wsUrl).origin,
    db: config.dbPath,
    uploads: config.uploadStorage,
    localnet: config.localnet,
    directory: directory.all().length,
    directoryRefresh: config.directoryRefresh,
  },
  "indexer listening",
);
chain.start();
if (config.directoryRefresh) directory.start();
