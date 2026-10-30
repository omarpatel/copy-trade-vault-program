/**
 * One-time chain setup: initializes the Copier config (admin + keeper), creates, fills and freezes the platform
 * address lookup table, and writes `<state dir>/config.json`. Idempotent: re-running on the same chain only
 * re-checks, tops up localnet balances and re-writes the files.
 *
 *   pnpm setup:localnet                                             localnet: generated keeper, faucet-funded
 *   CLUSTER=mainnet-beta RPC_URL=… ADMIN_KEYPAIR=… KEEPER_PUBKEY=… pnpm setup:cluster [--yes]
 *
 * The admin must be the program's upgrade authority (`initialize_config` checks it): `.localnet/admin.json` on
 * localnet (scripts/localnet.sh), the ADMIN_KEYPAIR scripts/deploy.sh deployed with elsewhere. On real clusters
 * the keeper is never generated or funded here: pass its public key (KEEPER_PUBKEY) and fund it yourself. Devnet
 * and mainnet send nothing without `--yes` (they print the plan); localnet always executes.
 *
 * Env: CLUSTER (localnet | devnet | mainnet-beta), RPC_URL, KEYS_DIR (state dir), ADMIN_KEYPAIR, KEEPER_PUBKEY,
 *      TIMELOCK_SECS (admin-change delay, fixed at initialization: default 86400 on mainnet-beta, 60 elsewhere),
 *      INDEXER_URL, PRIORITY_MICROLAMPORTS.
 */
import { AddressLookupTableProgram, Connection, LAMPORTS_PER_SOL, PublicKey, type Keypair } from "@solana/web3.js";
import {
  MAX_TIMELOCK_SECS,
  MIN_TIMELOCK_SECS,
  COPIER_PROGRAM_ID,
  buildInitializeConfigIx,
  configPda,
  decodeConfig,
  platformLookupTableAddresses,
} from "@copy-trade-vault/sdk";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  CLUSTER,
  CONFIG_FILE,
  INDEXER_URL,
  INGEST_TOKEN,
  IS_LOCAL,
  ROOT,
  RPC_URL,
  STATE_DIR,
  WS_URL,
  loadAdmin,
  loadOrCreateKeypair,
  main,
  readJson,
  rel,
  send,
  sol,
  topUp,
  writeJson,
  type ChainConfig,
} from "./common";

const CONFIRMED = process.argv.includes("--yes");
const TIMELOCK_SECS = Number(process.env.TIMELOCK_SECS ?? (CLUSTER === "mainnet-beta" ? 86_400 : 60));
if (!Number.isInteger(TIMELOCK_SECS) || TIMELOCK_SECS < MIN_TIMELOCK_SECS || TIMELOCK_SECS > MAX_TIMELOCK_SECS) {
  throw new Error(`TIMELOCK_SECS must be an integer in ${MIN_TIMELOCK_SECS}..=${MAX_TIMELOCK_SECS} (got ${process.env.TIMELOCK_SECS})`);
}
/** Addresses per extend instruction (keeps each tx far below the size limit). */
const EXTEND_CHUNK = 24;

/**
 * The platform ALT recorded for this chain when it still holds every platform address, else a new one:
 * created, extended in chunks, then frozen (authority removed) so launch txs can trust its contents.
 */
async function ensureLookupTable(connection: Connection, admin: Keypair, previous: string | undefined): Promise<PublicKey> {
  const wanted = platformLookupTableAddresses();
  if (previous) {
    const existing = (await connection.getAddressLookupTable(new PublicKey(previous))).value;
    const have = new Set(existing?.state.addresses.map((a) => a.toBase58()));
    if (existing?.isActive() && wanted.every((a) => have.has(a.toBase58()))) {
      console.log(`platform ALT ${previous} already holds all ${wanted.length} platform addresses`);
      return existing.key;
    }
  }
  const recentSlot = await connection.getSlot("finalized");
  const [createIx, alt] = AddressLookupTableProgram.createLookupTable({ authority: admin.publicKey, payer: admin.publicKey, recentSlot });
  await send(connection, admin, [createIx], [], { label: "create ALT" });
  for (let i = 0; i < wanted.length; i += EXTEND_CHUNK) {
    const addresses = wanted.slice(i, i + EXTEND_CHUNK);
    await send(
      connection,
      admin,
      [AddressLookupTableProgram.extendLookupTable({ payer: admin.publicKey, authority: admin.publicKey, lookupTable: alt, addresses })],
      [],
      { label: "extend ALT" },
    );
  }
  await send(connection, admin, [AddressLookupTableProgram.freezeLookupTable({ authority: admin.publicKey, lookupTable: alt })], [], {
    label: "freeze ALT",
  });
  // Entries become usable one slot after the extension.
  const extendedAt = await connection.getSlot("confirmed");
  while ((await connection.getSlot("confirmed")) <= extendedAt) await sleep(200);
  const state = (await connection.getAddressLookupTable(alt)).value;
  if (!state || state.state.addresses.length !== wanted.length || state.state.authority) {
    throw new Error(`platform ALT ${alt.toBase58()} did not end up frozen with ${wanted.length} addresses`);
  }
  console.log(`platform ALT ${alt.toBase58()}: ${wanted.length} addresses, frozen`);
  return alt;
}

/** The upgrade authority recorded in the program's ProgramData account (null = immutable). */
async function upgradeAuthority(connection: Connection): Promise<PublicKey | null> {
  const [programData] = PublicKey.findProgramAddressSync([COPIER_PROGRAM_ID.toBuffer()], new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"));
  const info = await connection.getAccountInfo(programData);
  if (!info) throw new Error(`program data account ${programData.toBase58()} missing`);
  // UpgradeableLoaderState::ProgramData { slot: u64, upgrade_authority_address: Option<Pubkey> } after a u32 tag.
  return info.data[12] === 1 ? new PublicKey(info.data.subarray(13, 45)) : null;
}

main(async () => {
  const connection = new Connection(RPC_URL, "confirmed");
  const genesisHash = await connection.getGenesisHash().catch(() => {
    throw new Error(`RPC not reachable at ${RPC_URL}${IS_LOCAL ? " (start the validator: pnpm localnet)" : ""}`);
  });
  const program = await connection.getAccountInfo(COPIER_PROGRAM_ID);
  if (!program?.executable) {
    throw new Error(
      `copier program ${COPIER_PROGRAM_ID.toBase58()} is not deployed on ${CLUSTER} (${IS_LOCAL ? "pnpm localnet deploy" : `CLUSTER=${CLUSTER} bash scripts/deploy.sh`})`,
    );
  }

  const admin = loadAdmin();
  let keeper: PublicKey;
  let keeperKeypair: string | null = null;
  if (process.env.KEEPER_PUBKEY) {
    keeper = new PublicKey(process.env.KEEPER_PUBKEY);
  } else if (IS_LOCAL) {
    keeper = loadOrCreateKeypair("keeper").publicKey;
    keeperKeypair = rel(path.join(STATE_DIR, "keeper.json"));
  } else {
    throw new Error(`KEEPER_PUBKEY is required on ${CLUSTER}: the keeper key is generated and held by its operator, never by setup`);
  }
  if (IS_LOCAL) {
    await topUp(connection, admin.publicKey, 100);
    if (keeperKeypair) await topUp(connection, keeper, 50);
  }

  const configAddress = configPda();
  const existing = await connection.getAccountInfo(configAddress);
  const previous = readJson<ChainConfig>(CONFIG_FILE);
  const previousAlt = previous?.genesisHash === genesisHash ? previous.alt : undefined;
  const balance = await connection.getBalance(admin.publicKey);
  console.log(
    [
      `cluster   ${CLUSTER} (${RPC_URL}, genesis ${genesisHash})`,
      `program   ${COPIER_PROGRAM_ID.toBase58()}`,
      `admin     ${admin.publicKey.toBase58()} (${sol(balance)} SOL)`,
      `keeper    ${keeper.toBase58()}${keeperKeypair ? ` (${keeperKeypair})` : ""}`,
      `config    ${configAddress.toBase58()}: ${existing ? `already initialized (timelock ${decodeConfig(existing.data).timelockSecs}s)` : `initialize_config, timelock ${TIMELOCK_SECS}s (fixed for good; admin pays config + burn-pool rent)`}`,
      `ALT       ${previousAlt ? `${previousAlt} (re-checked)` : `create + extend with ${platformLookupTableAddresses().length} platform addresses + freeze`}`,
      `state     ${rel(STATE_DIR)}/`,
    ].join("\n"),
  );

  if (existing) {
    const config = decodeConfig(existing.data);
    if (!config.admin.equals(admin.publicKey)) console.warn(`! config admin is ${config.admin.toBase58()}, not ${admin.publicKey.toBase58()}`);
    if (!config.keeper.equals(keeper)) {
      console.warn(`! config keeper is ${config.keeper.toBase58()}, not ${keeper.toBase58()} (pnpm admin propose-keeper)`);
    }
  } else {
    const authority = await upgradeAuthority(connection);
    if (!authority?.equals(admin.publicKey)) {
      throw new Error(`initialize_config needs the program's upgrade authority (${authority?.toBase58() ?? "none"}) as admin, not ${admin.publicKey.toBase58()}`);
    }
  }
  if (!IS_LOCAL && balance < 0.1 * LAMPORTS_PER_SOL) {
    throw new Error(`fund the admin ${admin.publicKey.toBase58()} with ≥ 0.1 SOL (config + ALT rent and fees) first`);
  }
  if (!IS_LOCAL && !CONFIRMED) {
    console.log(`\n${CLUSTER}: dry run, nothing sent. Re-run with --yes to execute this plan.`);
    return;
  }

  if (!existing) {
    const sig = await send(connection, admin, buildInitializeConfigIx({ admin: admin.publicKey, keeper, timelockSecs: TIMELOCK_SECS }), [], {
      label: "initialize_config",
    });
    console.log(`config ${configAddress.toBase58()} initialized (keeper ${keeper.toBase58()}): ${sig}`);
  }
  const alt = await ensureLookupTable(connection, admin, previousAlt);

  const config: ChainConfig = {
    cluster: CLUSTER,
    rpcUrl: RPC_URL,
    wsUrl: WS_URL,
    genesisHash,
    programId: COPIER_PROGRAM_ID.toBase58(),
    config: configAddress.toBase58(),
    admin: admin.publicKey.toBase58(),
    keeper: keeper.toBase58(),
    keeperKeypair,
    alt: alt.toBase58(),
    indexerUrl: INDEXER_URL,
    // Real clusters: the ingest token is a secret shared by indexer + keeper env, never written here.
    ingestToken: IS_LOCAL ? INGEST_TOKEN : null,
  };
  writeJson(CONFIG_FILE, config);
  console.log(`\nwrote ${rel(CONFIG_FILE)}`);
  console.log("\nkeeper env (apps/watcher):");
  console.log(`RPC_URL=${RPC_URL}\nCOPIER_ALT=${config.alt}\nKEEPER_KEYPAIR=<path to the keypair of ${keeper.toBase58()}>`);
  console.log(`INDEXER_URL=${INDEXER_URL}\nINDEXER_INGEST_TOKEN=<shared secret, same as the indexer's>`);
});
