import { PublicKey, type Commitment, type Connection } from "@solana/web3.js";
import bs58 from "bs58";
import {
  COPIER_ACCOUNT_DISC,
  COPIER_PROGRAM_ID,
  ata,
  decodeCopier,
  decodePosition,
  fetchConfig,
  type ConfigAccount,
  type CopierAccount,
  type PositionAccount,
} from "@copy-trade-vault/sdk";
import type { TrackedAccount } from "./detector";

/**
 * The keeper's view of the program: Config, every Copier account (`getProgramAccounts` on the copier program,
 * refreshed every `COPIER_REFRESH_MS`) and every open Position. Index copiers follow up to 16 targets, so the
 * routing table is target → [(copier, target index)].
 */

export interface Follower {
  mint: string;
  targetIdx: number;
}

export interface CopierEntry {
  account: CopierAccount;
  /** Open positions keyed by token mint. */
  positions: Map<string, PositionAccount>;
}

export interface RegistrySnapshot {
  config: ConfigAccount | null;
  copiers: Map<string, CopierEntry>;
  followers: Map<string, Follower[]>;
}

/** Loads Config, copiers and positions in three reads. */
export async function loadRegistry(connection: Connection, commitment: Commitment): Promise<RegistrySnapshot> {
  const [config, copierRaw, positionRaw] = await Promise.all([
    fetchConfig(connection, commitment),
    connection.getProgramAccounts(COPIER_PROGRAM_ID, {
      commitment,
      filters: [{ memcmp: { offset: 0, bytes: bs58.encode(COPIER_ACCOUNT_DISC.copier) } }],
    }),
    connection.getProgramAccounts(COPIER_PROGRAM_ID, {
      commitment,
      filters: [{ memcmp: { offset: 0, bytes: bs58.encode(COPIER_ACCOUNT_DISC.position) } }],
    }),
  ]);
  const copiers = new Map<string, CopierEntry>();
  for (const r of copierRaw) {
    const account = decodeCopier(r.account.data);
    copiers.set(account.mint.toBase58(), { account, positions: new Map() });
  }
  for (const r of positionRaw) {
    const p = decodePosition(r.account.data);
    copiers.get(p.mint.toBase58())?.positions.set(p.tokenMint.toBase58(), p);
  }
  const followers = new Map<string, Follower[]>();
  for (const [mint, m] of copiers) {
    m.account.targets.forEach((t, targetIdx) => {
      const key = t.toBase58();
      const list = followers.get(key) ?? [];
      list.push({ mint, targetIdx });
      followers.set(key, list);
    });
  }
  return { config, copiers, followers };
}

/** The targets' canonical token accounts of every mint a vault holds (what the program reads for sells). */
export function trackedAccounts(snapshot: RegistrySnapshot, tokenProgramOf: (mint: string) => PublicKey | undefined): TrackedAccount[] {
  const out = new Map<string, TrackedAccount>();
  for (const m of snapshot.copiers.values()) {
    for (const [mint, p] of m.positions) {
      const program = tokenProgramOf(mint);
      if (!program) continue;
      const address = ata(p.target, new PublicKey(mint), program).toBase58();
      out.set(address, { target: p.target.toBase58(), tokenAccount: address });
    }
  }
  return [...out.values()];
}
