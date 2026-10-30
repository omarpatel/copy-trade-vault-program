#!/usr/bin/env node
/**
 * Cross-platform front end for scripts/localnet.sh (through WSL on Windows, bash elsewhere).
 *
 *   pnpm localnet [start]         validator in the background (log: .localnet/validator.log), resuming its
 *                                 ledger or creating a fresh one (mainnet pump programs cloned) when none exists
 *   pnpm localnet start --reset   same, from a fresh ledger (new genesis; picks up a new `anchor build`)
 *   pnpm localnet fg [--reset]    validator in the foreground (Ctrl+C stops it)
 *   pnpm localnet status          validator, program, config and ledger state
 *   pnpm localnet deploy          (re)deploy target/deploy/copy_vault.so on the running validator through
 *                                 scripts/deploy.sh (CLUSTER=localnet --skip-build), keeping state
 *   pnpm stop:localnet            stop a running validator
 *   pnpm reset:localnet           stop → fresh validator in the background → wipe the indexer DB (when the
 *                                 indexer isn't running) → setup:localnet → seed:localnet
 *
 * Env: RPC_URL (default http://127.0.0.1:8899), INDEXER_URL (default http://127.0.0.1:8790), DB_PATH
 * (indexer DB, default apps/indexer/data/indexer.db), KEYS_DIR (state dir, default .localnet), WSL_DISTRO (default:
 * the default WSL distro), plus localnet.sh's LEDGER, CLONE_URL, LEDGER_LIMIT, RPC_PORT, FAUCET_PORT, GOSSIP_PORT,
 * DYNAMIC_PORT_RANGE, PRELOAD_PROGRAM. A second validator (own LEDGER + ports) logs to .localnet/validator-<ledger>.log.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WIN = process.platform === "win32";
const RPC_URL = process.env.RPC_URL || `http://127.0.0.1:${process.env.RPC_PORT || 8899}`;
const INDEXER_URL = (process.env.INDEXER_URL || "http://127.0.0.1:8790").replace(/\/+$/, "");
const DB_PATH = path.resolve(ROOT, process.env.DB_PATH || "apps/indexer/data/indexer.db");
const LOCALNET_DIR = path.resolve(ROOT, process.env.KEYS_DIR || ".localnet");
const LOG_DIR = path.join(ROOT, ".localnet");
const VALIDATOR_LOG = path.join(LOG_DIR, process.env.LEDGER ? `validator-${path.posix.basename(process.env.LEDGER).replace(/^\./, "")}.log` : "validator.log");
const PROGRAM_ID = "9R8g8JtEqRAh5yZ4aXbf1mWcfgLq9kAo6fmx93MSK9k7";
// Only this project's validator (other projects may run their own on other ports).
const VALIDATOR_PATTERN = `solana-test-validator.*${process.env.LEDGER ? path.posix.basename(process.env.LEDGER) : "\\.copier-ledger"}`;

/** [command, args] running `args` in the validator's environment: WSL on Windows (no shell in between). */
const inShell = (...args) =>
  WIN ? ["wsl", [...(process.env.WSL_DISTRO ? ["-d", process.env.WSL_DISTRO] : []), "--exec", ...args]] : [args[0], args.slice(1)];
// `wsl` only forwards the variables WSLENV names: pass localnet.sh's options through.
if (WIN) {
  const forwarded = [
    "CLONE_URL",
    "RPC_PORT",
    "FAUCET_PORT",
    "GOSSIP_PORT",
    "DYNAMIC_PORT_RANGE",
    "LEDGER",
    "LEDGER_LIMIT",
    "UPGRADE_AUTHORITY",
    "PRELOAD_PROGRAM",
    "CLUSTER",
    "KEYS_DIR",
    "ADMIN_KEYPAIR",
  ];
  process.env.WSLENV = [process.env.WSLENV, ...forwarded.filter((v) => process.env[v])].filter(Boolean).join(":");
}

async function rpc(method, params = []) {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(3_000),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

async function rpcHealthy() {
  return rpc("getHealth").then(
    (r) => r === "ok",
    () => false,
  );
}

async function indexerUp() {
  return fetch(`${INDEXER_URL}/api/health`, { signal: AbortSignal.timeout(2_000) }).then(
    () => true,
    () => false,
  );
}

async function waitFor(what, want, timeoutMs, logHint) {
  const until = Date.now() + timeoutMs;
  while ((await rpcHealthy()) !== want) {
    if (Date.now() > until) throw new Error(`timed out after ${timeoutMs / 1000}s waiting for ${what}${logHint ? ` (see ${logHint})` : ""}`);
    await sleep(1_000);
  }
}

/** Runs a root package script (pnpm is a .cmd shim on Windows, hence the shell). */
function pnpm(script) {
  console.log(`\n$ pnpm ${script}`);
  const r = spawnSync(`pnpm ${script}`, { cwd: ROOT, stdio: "inherit", shell: true });
  if (r.status !== 0) throw new Error(`pnpm ${script} failed (exit ${r.status})`);
}

/** Runs a command in the validator's environment from the repo root; throws on failure. */
function shell(...args) {
  const [cmd, cmdArgs] = inShell(...args);
  const r = spawnSync(cmd, cmdArgs, { cwd: ROOT, stdio: "inherit" });
  if (r.status !== 0) throw new Error(`${args.join(" ")} failed (exit ${r.status})`);
}

async function stop() {
  if (!(await rpcHealthy())) return console.log(`no validator answering on ${RPC_URL}`);
  const [cmd, args] = inShell("pkill", "-INT", "-f", VALIDATOR_PATTERN);
  spawnSync(cmd, args, { stdio: "inherit" });
  await waitFor("the validator to stop", false, 30_000);
  console.log("validator stopped");
}

async function startBackground(reset) {
  if (await rpcHealthy()) {
    if (!reset) {
      console.log(`validator already running on ${RPC_URL}`);
      return status();
    }
    await stop();
  }
  fs.mkdirSync(LOCALNET_DIR, { recursive: true });
  fs.writeFileSync(VALIDATOR_LOG, "");
  // The shell writes the log itself: wsl.exe does not reliably forward a detached child's output to a file handle.
  const script = `bash scripts/localnet.sh${reset ? " --reset" : ""} >> '${path.relative(ROOT, VALIDATOR_LOG).replaceAll("\\", "/")}' 2>&1`;
  const [cmd, args] = inShell("bash", "-c", script);
  const child = spawn(cmd, args, { cwd: ROOT, detached: true, stdio: "ignore", windowsHide: true });
  let exited = null;
  child.on("exit", (code) => (exited = code));
  child.unref();
  const rel = path.relative(ROOT, VALIDATOR_LOG);
  console.log(`starting ${reset ? "a fresh" : "the"} validator in the background (log: ${rel})…`);
  // A fresh ledger clones the pump programs and their accounts from mainnet first: allow minutes.
  const until = Date.now() + 300_000;
  while (!(await rpcHealthy())) {
    if (exited !== null) {
      const tail = fs.readFileSync(VALIDATOR_LOG, "utf8").trim().split("\n").slice(-15).join("\n");
      throw new Error(`validator exited (code ${exited}):\n${tail}`);
    }
    if (Date.now() > until) throw new Error(`timed out after 300s waiting for the validator (see ${rel})`);
    await sleep(1_000);
  }
  console.log(`validator up on ${RPC_URL}`);
  await status();
}

async function status() {
  if (!(await rpcHealthy())) {
    console.log(`validator: not answering on ${RPC_URL} (start it: pnpm localnet)`);
    return false;
  }
  const [version, slot, genesis, program] = await Promise.all([
    rpc("getVersion"),
    rpc("getSlot"),
    rpc("getGenesisHash"),
    rpc("getAccountInfo", [PROGRAM_ID, { encoding: "base64", dataSlice: { offset: 0, length: 0 } }]),
  ]);
  const pump = await rpc("getAccountInfo", ["6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", { encoding: "base64", dataSlice: { offset: 0, length: 0 } }]);
  const read = (f) => (fs.existsSync(path.join(LOCALNET_DIR, f)) ? JSON.parse(fs.readFileSync(path.join(LOCALNET_DIR, f), "utf8")) : null);
  const config = read("config.json");
  const seed = read("seed.json");
  const sameChain = (j) => j && j.genesisHash === genesis;
  console.log(
    [
      `validator: ${RPC_URL} (ws ${RPC_URL.replace(/^http/, "ws").replace(/:(\d+)(\/|$)/, (_, p, s) => `:${Number(p) + 1}${s}`)}) solana-core ${version["solana-core"]}, slot ${slot}, genesis ${genesis}`,
      `pump.fun:  ${pump.value?.executable ? "cloned" : "MISSING (fresh ledger needed: pnpm localnet start --reset)"}`,
      `copier:    ${program.value?.executable ? `${PROGRAM_ID} deployed` : `${PROGRAM_ID} NOT deployed (anchor build, then pnpm localnet deploy)`}`,
      `setup:     ${sameChain(config) ? `config + ALT ${config.alt} (keeper ${config.keeper})` : "not run on this chain (pnpm setup:localnet)"}`,
      `seed:      ${sameChain(seed) ? `${seed.copiers.length} copiers, the platform token ${seed.platformToken}` : "not run on this chain (pnpm seed:localnet)"}`,
    ].join("\n"),
  );
  return true;
}

async function deploy() {
  if (!(await rpcHealthy())) throw new Error(`no validator answering on ${RPC_URL} (pnpm localnet)`);
  // deploy.sh runs the Solana CLI inside WSL, where the validator's RPC is localhost too.
  process.env.CLUSTER = "localnet";
  process.env.RPC_PORT ||= new URL(RPC_URL).port || "8899";
  if (WIN) process.env.WSLENV = [process.env.WSLENV, "CLUSTER", "RPC_PORT"].filter(Boolean).join(":");
  shell("bash", "scripts/deploy.sh", "--skip-build");
}

async function reset() {
  await startBackground(true);
  const indexerRunning = await indexerUp();
  if (indexerRunning) {
    console.log("indexer is running: it detects the new genesis and re-indexes by itself");
  } else {
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(DB_PATH + suffix, { force: true });
    console.log(`wiped indexer DB ${path.relative(ROOT, DB_PATH)}`);
  }
  pnpm("setup:localnet");
  pnpm("seed:localnet");
  console.log(`\nfresh localnet ready. Live activity: pnpm simulate:localnet · stop: pnpm stop:localnet`);
}

function foreground(extra) {
  const [cmd, args] = inShell("bash", "scripts/localnet.sh", ...extra);
  const child = spawn(cmd, args, { cwd: ROOT, stdio: "inherit" });
  // Ctrl+C reaches the validator directly; exit with it.
  process.on("SIGINT", () => undefined);
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 130 : 1)));
}

const [sub = "start", ...rest] = process.argv.slice(2);
const USAGE = "usage: localnet.mjs [start [--reset] | fg [--reset] | status | deploy | stop | reset]";
try {
  if (sub === "start" || sub === "--reset") await startBackground(sub === "--reset" || rest.includes("--reset"));
  else if (sub === "fg") foreground(rest);
  else if (sub === "status") process.exitCode = (await status()) ? 0 : 1;
  else if (sub === "deploy") await deploy();
  else if (sub === "stop") await stop();
  else if (sub === "reset") await reset();
  else throw new Error(USAGE);
} catch (err) {
  console.error(`✗ ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}
