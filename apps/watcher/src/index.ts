import { Connection } from "@solana/web3.js";
import { COPIER_PROGRAM_ID } from "@copy-trade-vault/sdk";
import { loadConfig } from "./config";
import { Cranks } from "./cranks";
import { Detector } from "./detector";
import { Executor } from "./executor";
import { GrpcSource } from "./grpc";
import { Keeper } from "./keeper";
import { errMsg, log } from "./log";
import { Reporter } from "./reporter";
import { RawRpc } from "./rpc";
import { State } from "./state";
import { startStatusServer } from "./status";

const cfg = loadConfig();
const connection = new Connection(cfg.rpcUrl, { commitment: cfg.commitment, wsEndpoint: cfg.wsUrl });
const rpc = new RawRpc(cfg.rpcUrl);
const state = new State(cfg.dbFile);
const reporter = new Reporter(state, cfg.indexerUrl, cfg.ingestToken);
const executor = new Executor(connection, cfg);
const keeper = new Keeper(cfg, connection, executor, state, reporter);
const detector = new Detector(cfg, connection, rpc, state, keeper.onTx, { websocket: true });
keeper.attach(detector);
const grpc = cfg.grpc ? new GrpcSource(cfg.grpc.url, cfg.grpc.token, (tx) => void detector.ingest(tx, "grpc")) : null;
const cranks = new Cranks(keeper, executor, rpc, cfg.crankMs);
const startedAt = Date.now();

const origin = (url: string) => new URL(url).origin;

const server = await startStatusServer(cfg.statusHost, cfg.statusPort, () => {
  const config = keeper.registry.config;
  const copiers = [...keeper.registry.copiers.entries()].map(([mint, m]) => ({
    mint,
    kind: m.account.kind,
    targets: m.account.targets.map((t) => t.toBase58()),
    openPositions: m.account.openPositions,
    buybackPool: m.account.buybackPool,
    realizedPnl: m.account.realizedPnl,
  }));
  return {
    keeper: keeper.keeper?.publicKey.toBase58() ?? null,
    mode: keeper.mode,
    programId: COPIER_PROGRAM_ID.toBase58(),
    // Pre-launch (not deployed / Config not initialized) runs in observe mode and re-checks every COPIER_REFRESH_MS.
    program: keeper.program,
    // Origins only: keyed RPC URLs (`?api-key=`) must not leak through the status API.
    rpc: origin(cfg.rpcUrl),
    startedAt: Math.floor(startedAt / 1000),
    uptimeSecs: Math.floor((Date.now() - startedAt) / 1000),
    config: config
      ? { keeper: config.keeper.toBase58(), platformMint: config.platformMint.toBase58(), params: config.params, descriptors: config.descriptors.length }
      : null,
    registry: {
      copiers: copiers.length,
      targets: keeper.registry.followers.size,
      lastRefreshAt: keeper.lastRefreshAt ? Math.floor(keeper.lastRefreshAt / 1000) : null,
      lastRefreshError: keeper.lastRefreshError,
      items: copiers,
    },
    detection: { ...detector.stats(), grpc: grpc?.stats() ?? null },
    counters: { ...keeper.counters, last24h: state.decisionCounts(Date.now() - 86_400_000) },
    decisions: state.recentDecisions(50),
    cranks: { lastRoundAt: cranks.lastRoundAt ? Math.floor(cranks.lastRoundAt / 1000) : null, recent: cranks.attempts },
    heartbeat: {
      ...cranks.heartbeatStatus,
      onChainTs: config ? Number(config.keeperHeartbeatTs) : null,
      graceSecs: config ? Number(config.params.keeperGraceSecs) : null,
    },
    reporter: reporter.stats(),
    sending: {
      jito: cfg.jito ? { url: origin(cfg.jito.url), tipLamports: cfg.jito.tipLamports } : null,
      priorityMicroLamports: cfg.priority,
      lookupTable: executor.lookupTable,
      dryRun: cfg.dryRun,
    },
  };
});

log("started", {
  rpc: origin(cfg.rpcUrl),
  ws: origin(cfg.wsUrl),
  grpc: cfg.grpc ? origin(cfg.grpc.url) : "off",
  programId: COPIER_PROGRAM_ID.toBase58(),
  indexer: cfg.indexerUrl,
  jito: cfg.jito ? origin(cfg.jito.url) : "off",
  priority: cfg.priority,
  commitment: cfg.commitment,
  dryRun: cfg.dryRun,
  db: cfg.dbFile,
  status: `http://${cfg.statusHost}:${cfg.statusPort}/status`,
});

await executor.start();
reporter.start();
detector.start();
await keeper.start();
cranks.start();
if (grpc) void grpc.start(detector.targets).catch((err) => log("grpc_start_failed", { error: errMsg(err) }));
const grpcSync = grpc ? setInterval(() => grpc.setTargets(detector.targets), cfg.copierRefreshMs) : null;
const pruneTimer = setInterval(() => state.prune(), 3_600_000);

let signals = 0;
const shutdown = async (signal: NodeJS.Signals) => {
  signals += 1;
  if (signals > 1) process.exit(130);
  log("stopping", { signal });
  clearInterval(grpcSync ?? undefined);
  clearInterval(pruneTimer);
  cranks.stop();
  keeper.stop();
  detector.stop();
  grpc?.stop();
  await reporter.flush().catch(() => undefined);
  reporter.stop();
  server.closeAllConnections();
  server.close();
  state.close();
  log("stopped");
  process.exit(0);
};
// SIGBREAK: Ctrl+Break on Windows consoles.
for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"] as const) process.on(signal, (s) => void shutdown(s));
