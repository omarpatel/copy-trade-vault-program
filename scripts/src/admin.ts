/**
 * Admin operations on the deployed program (any cluster). Configuration changes are timelocked on-chain: the admin
 * proposes, the change waits `config.timelock_secs`, then anyone executes it (or the admin cancels it). Every command
 * simulates against the cluster and prints what it would do; `--yes` signs and sends (ADMIN_KEYPAIR; `execute` is
 * permissionless and is paid by PAYER_KEYPAIR, else the admin). Once the admin is a multisig, use `--print-ix`: it
 * prints the instruction (program, accounts, data) to propose in the multisig (e.g. Squads).
 *
 *   pnpm admin show                                   config, timelock, keeper heartbeat, params, descriptors
 *   pnpm admin pending                                queued changes with their ETA
 *   pnpm admin descriptors > descriptors.json         the current whitelist as editable JSON
 *   pnpm admin propose-descriptors descriptors.json   replace the whitelist (pump interface change)
 *   pnpm admin propose-params slippageBps=600 …       change params (merged into the current ones; ranges on-chain)
 *   pnpm admin propose-keeper <pubkey>                hand the keeper role to another key
 *   pnpm admin propose-index-targets [mint]           basket ← scripts/copier-basket.json (default mint: the platform token)
 *   pnpm admin execute <id>                           apply the live change of its kind in [ETA, ETA + 7 days] (anyone)
 *   pnpm admin cancel <id>                            drop a queued change (admin)
 *   pnpm admin discard <id>                           close a superseded / expired change, rent back (anyone)
 *   pnpm admin pause                                  INSTANT: keeper → none (copies, buybacks, burns stop)
 *   pnpm admin propose-admin <pubkey>                 step 1 of the admin handoff (timelocked)
 *   pnpm admin accept-admin                           step 2, signed by the pending admin after the timelock
 *
 * Env: CLUSTER, RPC_URL, KEYS_DIR, ADMIN_KEYPAIR, PAYER_KEYPAIR (execute), PRIORITY_MICROLAMPORTS.
 */
import { Connection, PublicKey, type Keypair, type TransactionInstruction } from "@solana/web3.js";
import {
  CHANGE_KIND_INDEX,
  NO_CHANGE_ID,
  buildAcceptAdminIx,
  buildCancelPendingIx,
  buildDiscardPendingIx,
  buildExecutePendingIx,
  buildPauseKeeperIx,
  buildProposeAdminIx,
  buildProposeDescriptorsIx,
  buildProposeIndexTargetsIx,
  buildProposeKeeperIx,
  buildProposeParamsIx,
  fetchConfig,
  fetchCopier,
  fetchPendingChanges,
  pendingChangeStatus,
  validateDescriptors,
  type ConfigAccount,
  type PendingChangeAccount,
  type ProgramParams,
  type TradeDescriptor,
} from "@copy-trade-vault/sdk";
import { utils } from "@coral-xyz/anchor";
import fs from "node:fs";
import path from "node:path";
import { loadBasket } from "./basket";
import { CLUSTER, ROOT, RPC_URL, loadAdmin, main, readKeypair, send, simulate } from "./common";

const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith("--")));
const [command, ...args] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const YES = flags.has("--yes");
const PRINT_IX = flags.has("--print-ix");

interface DescriptorJson {
  program: string;
  /** 8-byte instruction discriminator, hex. */
  disc: string;
  side: "buy" | "sell";
  venue: "curve" | "pool";
  userIdx: number;
  baseMintIdx: number;
  venueIdx: number;
  minAccounts: number;
}

const toJson = (d: TradeDescriptor): DescriptorJson => ({ ...d, program: d.program.toBase58(), disc: Buffer.from(d.disc).toString("hex") });
const fromJson = (d: DescriptorJson): TradeDescriptor => {
  const disc = Uint8Array.from(Buffer.from(d.disc, "hex"));
  if (disc.length !== 8) throw new Error(`descriptor disc ${d.disc} is not 8 bytes of hex`);
  if (d.side !== "buy" && d.side !== "sell") throw new Error(`descriptor side ${d.side} must be buy or sell`);
  if (d.venue !== "curve" && d.venue !== "pool") throw new Error(`descriptor venue ${d.venue} must be curve or pool`);
  return { ...d, program: new PublicKey(d.program), disc };
};
const jsonBig = (value: unknown) => JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2);
const isSet = (key: PublicKey) => !key.equals(PublicKey.default);
const when = (unix: bigint) => new Date(Number(unix) * 1000).toISOString().replace(".000Z", "Z");

/** "in 23h 59m" / "ready 5m ago" for an ETA. */
function eta(unix: bigint, now: bigint): string {
  const d = Number(unix - now);
  const span = (s: number) => (s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`);
  return d > 0 ? `in ${span(d)} (${when(unix)})` : `ready since ${span(-d)} (${when(unix)})`;
}

function describeChange(c: PendingChangeAccount, config: ConfigAccount): string {
  switch (c.kind) {
    case "keeper":
      return `keeper ${config.keeper.toBase58()} → ${c.keeper.toBase58()}`;
    case "params": {
      const keys = (Object.keys(c.params) as (keyof ProgramParams)[]).filter((k) => c.params[k] !== config.params[k]);
      return `params ${keys.map((k) => `${k} ${config.params[k]} → ${c.params[k]}`).join(", ") || "(no difference from current)"}`;
    }
    case "descriptors":
      return `descriptors ${config.descriptors.length} → ${c.descriptors.length}`;
    case "indexTargets":
      return `index targets of copier ${c.copier.toBase58()} → ${c.targets.length} wallets`;
  }
}

function printConfig(config: ConfigAccount, pending: { account: PendingChangeAccount }[], now: bigint): void {
  const heartbeatAge = now - config.keeperHeartbeatTs;
  console.log(
    jsonBig({
      admin: config.admin.toBase58(),
      pendingAdmin: isSet(config.pendingAdmin) ? { key: config.pendingAdmin.toBase58(), accept: eta(config.pendingAdminEta, now) } : null,
      keeper: isSet(config.keeper) ? config.keeper.toBase58() : "NONE (paused)",
      keeperHeartbeat: `${heartbeatAge}s ago (grace ${config.params.keeperGraceSecs}s)`,
      timelockSecs: config.timelockSecs,
      platformMint: isSet(config.platformMint) ? config.platformMint.toBase58() : null,
      pendingChanges: pending.length,
      params: config.params,
      descriptors: config.descriptors.map(toJson),
    }),
  );
}

/** `key=value` pairs merged into the current params (numbers or bigints as the field requires). */
function mergeParams(current: ProgramParams, pairs: string[]): ProgramParams {
  if (pairs.length === 0) throw new Error(`usage: propose-params key=value … (keys: ${Object.keys(current).join(", ")})`);
  const next: ProgramParams = { ...current };
  for (const pair of pairs) {
    const [key, raw] = pair.split("=");
    if (!key || raw === undefined || !(key in current)) throw new Error(`unknown param ${pair} (keys: ${Object.keys(current).join(", ")})`);
    const field = key as keyof ProgramParams;
    (next as unknown as Record<string, number | bigint>)[field] = typeof current[field] === "bigint" ? BigInt(raw) : Number(raw);
  }
  return next;
}

/** Instruction in a form a multisig UI takes: program, accounts with flags, data (base58 + base64). */
function printInstruction(ix: TransactionInstruction): void {
  console.log(
    JSON.stringify(
      {
        programId: ix.programId.toBase58(),
        accounts: ix.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })),
        dataBase58: utils.bytes.bs58.encode(ix.data),
        dataBase64: ix.data.toString("base64"),
      },
      null,
      2,
    ),
  );
}

function findChange(pending: { account: PendingChangeAccount }[], raw: string | undefined): PendingChangeAccount {
  if (!raw) throw new Error("usage: <execute|cancel|discard> <id> (ids: pnpm admin pending)");
  const change = pending.find((p) => p.account.id === BigInt(raw))?.account;
  if (!change) throw new Error(`no pending change #${raw} (ids: ${pending.map((p) => p.account.id).join(", ") || "none"})`);
  return change;
}

/** Status + timing line of a change: queued / executable (with its window), superseded, expired. */
function statusLine(c: PendingChangeAccount, config: ConfigAccount, now: bigint): string {
  const status = pendingChangeStatus(c, config, now);
  switch (status) {
    case "queued":
      return `queued: executable ${eta(c.eta, now)}, until ${when(c.expiresAt)}`;
    case "executable":
      return `EXECUTABLE until ${when(c.expiresAt)} (pnpm admin execute ${c.id})`;
    case "superseded": {
      const live = config.latestChangeIds[CHANGE_KIND_INDEX[c.kind]]!;
      return `superseded (live ${c.kind} change: ${live === NO_CHANGE_ID ? "none, cancelled or voided" : `#${live}`}): can only be discarded (pnpm admin discard ${c.id})`;
    }
    case "expired":
      return `expired ${when(c.expiresAt)}: can only be discarded (pnpm admin discard ${c.id})`;
  }
}

/** " (supersedes live #N)" when a proposal of this kind is already queued. */
function livePending(config: ConfigAccount, kind: PendingChangeAccount["kind"]): string {
  const live = config.latestChangeIds[CHANGE_KIND_INDEX[kind]]!;
  return live === NO_CHANGE_ID ? "" : ` (supersedes the live ${kind} change #${live})`;
}

main(async () => {
  const connection = new Connection(RPC_URL, "confirmed");
  const config = await fetchConfig(connection);
  if (!config) throw new Error(`copier config not initialized on ${CLUSTER} (${RPC_URL})`);
  const pending = await fetchPendingChanges(connection);
  const now = BigInt(Math.floor(Date.now() / 1000));

  if (!command || command === "show") return printConfig(config, pending, now);
  if (command === "descriptors") {
    console.log(JSON.stringify(config.descriptors.map(toJson), null, 2));
    return;
  }
  if (command === "pending") {
    if (pending.length === 0) console.log(`no pending changes (timelock ${config.timelockSecs}s)`);
    for (const { address, account: c } of pending) {
      console.log(
        `#${c.id} ${c.kind.padEnd(12)} ${describeChange(c, config)}\n    ${statusLine(c, config, now)}\n    ${address.toBase58()}  proposed ${when(c.proposedAt)} by ${c.proposer.toBase58()}`,
      );
    }
    return;
  }

  const admin = config.admin;
  const changeId = config.nextChangeId;
  let signer = admin;
  let ixs: TransactionInstruction[];
  let summary: string;
  switch (command) {
    case "propose-descriptors": {
      const file = args[0] ? path.resolve(process.cwd(), args[0]) : null;
      if (!file || !fs.existsSync(file)) throw new Error("usage: propose-descriptors <descriptors.json> (start from `pnpm admin descriptors`)");
      const descriptors = (JSON.parse(fs.readFileSync(file, "utf8")) as DescriptorJson[]).map(fromJson);
      ixs = buildProposeDescriptorsIx({ admin, descriptors, changeId, config });
      const proven = validateDescriptors(descriptors, config);
      summary =
        `propose #${changeId}: descriptors ${config.descriptors.length} → ${descriptors.length}` +
        `${livePending(config, "descriptors")}\n`;
      summary +=
        descriptors
          .map(
            (d, i) =>
              `  ${i}. ${d.program.toBase58().slice(0, 6)}… ${Buffer.from(d.disc).toString("hex")} ${d.side} ${d.venue} user ${d.userIdx} mint ${d.baseMintIdx} venue ${d.venueIdx} min ${d.minAccounts}${(proven >> i) & 1 ? "  (proven)" : ""}`,
          )
          .join("\n");
      break;
    }
    case "propose-params": {
      const params = mergeParams(config.params, args);
      ixs = buildProposeParamsIx({ admin, params, changeId });
      const changed = (Object.keys(params) as (keyof ProgramParams)[]).filter((k) => params[k] !== config.params[k]);
      summary = `propose #${changeId}: ${changed.map((k) => `${k} ${config.params[k]} → ${params[k]}`).join(", ") || "no change"}${livePending(config, "params")}`;
      break;
    }
    case "propose-keeper": {
      if (!args[0]) throw new Error("usage: propose-keeper <pubkey>");
      const keeper = new PublicKey(args[0]);
      ixs = buildProposeKeeperIx({ admin, keeper, changeId });
      summary = `propose #${changeId}: keeper ${isSet(config.keeper) ? config.keeper.toBase58() : "none (paused)"} → ${keeper.toBase58()}${livePending(config, "keeper")}`;
      break;
    }
    case "propose-index-targets": {
      const mint = args[0] ? new PublicKey(args[0]) : config.platformMint;
      if (!isSet(mint)) throw new Error("no mint given and the platform token is not set");
      const copier = await fetchCopier(connection, mint);
      if (!copier || copier.kind !== "index") throw new Error(`${mint.toBase58()} is not an index copier`);
      const { entries, targets } = loadBasket();
      const added = targets.filter((t) => !copier.targets.some((m) => m.equals(t)));
      const removed = copier.targets.filter((m) => !targets.some((t) => t.equals(m)));
      ixs = buildProposeIndexTargetsIx({ admin, mint, targets, changeId });
      summary =
        `propose #${changeId}: index targets of ${mint.toBase58()} ${copier.targets.length} → ${targets.length}${livePending(config, "indexTargets")}` +
        `\n  added:   ${added.map((t) => entries.find((e) => e.address === t.toBase58())?.name ?? t.toBase58()).join(", ") || "—"}` +
        `\n  removed: ${removed.map((t) => t.toBase58()).join(", ") || "—"} (execution fails while they have open positions)`;
      break;
    }
    case "execute": {
      const change = findChange(pending, args[0]);
      const status = pendingChangeStatus(change, config, now);
      if (status !== "executable") throw new Error(`#${change.id} is not executable: ${statusLine(change, config, now)}`);
      ixs = buildExecutePendingIx({ change });
      summary = `execute #${change.id}: ${describeChange(change, config)} (permissionless; rent returns to ${change.proposer.toBase58()})`;
      signer = process.env.PAYER_KEYPAIR ? readKeypair(path.resolve(ROOT, process.env.PAYER_KEYPAIR)).publicKey : admin;
      break;
    }
    case "cancel": {
      const change = findChange(pending, args[0]);
      ixs = buildCancelPendingIx({ admin, change });
      summary = `cancel #${change.id}: ${describeChange(change, config)}`;
      break;
    }
    case "discard": {
      const change = findChange(pending, args[0]);
      const status = pendingChangeStatus(change, config, now);
      if (status !== "superseded" && status !== "expired") throw new Error(`#${change.id} is still live (${status}): cancel it instead`);
      ixs = buildDiscardPendingIx({ change });
      summary = `discard #${change.id} (${status}): rent returns to ${change.proposer.toBase58()} (permissionless)`;
      signer = process.env.PAYER_KEYPAIR ? readKeypair(path.resolve(ROOT, process.env.PAYER_KEYPAIR)).publicKey : admin;
      break;
    }
    case "pause": {
      ixs = buildPauseKeeperIx({ admin });
      summary =
        `PAUSE (instant): keeper ${isSet(config.keeper) ? config.keeper.toBase58() : "already none"} → none. copier_buy, buyback_burn and burn_platform stop.` +
        `\n  Resume: pnpm admin propose-keeper <key> → wait ${config.timelockSecs}s → pnpm admin execute <id>`;
      break;
    }
    case "propose-admin": {
      if (!args[0]) throw new Error("usage: propose-admin <pubkey> (e.g. the multisig vault)");
      const newAdmin = new PublicKey(args[0]);
      ixs = buildProposeAdminIx({ admin, newAdmin });
      summary = `propose admin ${admin.toBase58()} → ${newAdmin.toBase58()}; it may accept after ${config.timelockSecs}s`;
      break;
    }
    case "accept-admin": {
      if (!isSet(config.pendingAdmin)) throw new Error("no pending admin (run propose-admin first)");
      if (config.pendingAdminEta > now) throw new Error(`accept-admin is possible ${eta(config.pendingAdminEta, now)}`);
      signer = config.pendingAdmin;
      ixs = buildAcceptAdminIx({ pendingAdmin: signer });
      summary = `accept admin: ${admin.toBase58()} → ${signer.toBase58()}`;
      break;
    }
    default:
      throw new Error(`unknown command ${command} (see the header of scripts/src/admin.ts)`);
  }

  console.log(`${CLUSTER} (${RPC_URL}) — signer ${signer.toBase58()}, timelock ${config.timelockSecs}s\n${summary}`);
  if (PRINT_IX) {
    for (const ix of ixs) printInstruction(ix);
    return;
  }
  // Simulated as the on-chain signer (unsigned): works whether or not the local key is that signer.
  const sim = await simulate(connection, signer, ixs);
  console.log(sim.reason ? `✗ simulation: ${sim.reason}\n  ${sim.logs.slice(-6).join("\n  ")}` : `✓ simulated (${sim.unitsConsumed} CU)`);
  if (sim.reason) throw new Error("simulation failed");
  if (!YES) {
    console.log("dry run: re-run with --yes to send (or --print-ix for a multisig)");
    return;
  }
  // `execute` and `discard` are permissionless: PAYER_KEYPAIR (if set) signs and pays; everything else is the admin.
  const permissionless = command === "execute" || command === "discard";
  const key: Keypair = permissionless && process.env.PAYER_KEYPAIR ? readKeypair(path.resolve(ROOT, process.env.PAYER_KEYPAIR)) : loadAdmin();
  if (!key.publicKey.equals(signer)) throw new Error(`the local key is ${key.publicKey.toBase58()}, not the signer ${signer.toBase58()} (use --print-ix)`);
  console.log(`✓ sent: ${await send(connection, key, ixs, [], { label: command })}`);
  if (command.startsWith("propose-") && command !== "propose-admin") {
    const ready = now + config.timelockSecs;
    console.log(`queued as #${changeId}; execute ${eta(ready, BigInt(Math.floor(Date.now() / 1000)))}: pnpm admin execute ${changeId} --yes`);
  }
});
