/**
 * Test support: checks an instruction's account metas against an Anchor IDL instruction — count,
 * order, writable / signer flags, fixed addresses and every PDA the IDL can derive from the
 * instruction's own accounts and constants.
 */
import { PublicKey, type TransactionInstruction } from "@solana/web3.js";

interface IdlSeed {
  kind: "const" | "account" | "arg";
  value?: number[];
  path?: string;
}

interface IdlAccount {
  name: string;
  writable?: boolean;
  signer?: boolean;
  optional?: boolean;
  address?: string;
  pda?: { seeds: IdlSeed[]; program?: IdlSeed };
}

export interface Idl {
  address: string;
  instructions: { name: string; discriminator: number[]; accounts: IdlAccount[] }[];
}

export interface IdlCheckOptions {
  /** Accounts expected as signers although the IDL marks them writable non-signers, or vice versa. */
  signerOverrides?: Record<string, boolean>;
  /** Extra accounts after the IDL list (remaining accounts) allowed. */
  remaining?: number;
}

/** Throws a descriptive error on the first mismatch; returns the name → pubkey map. */
export function checkIxAgainstIdl(
  idl: Idl,
  name: string,
  ix: TransactionInstruction,
  opts: IdlCheckOptions = {},
): Record<string, PublicKey> {
  const def = idl.instructions.find((i) => i.name === name);
  if (!def) throw new Error(`IDL has no instruction ${name}`);
  const programId = new PublicKey(idl.address);
  if (!ix.programId.equals(programId)) throw new Error(`${name}: program ${ix.programId.toBase58()} != ${idl.address}`);
  const disc = Buffer.from(def.discriminator);
  if (!Buffer.from(ix.data.subarray(0, 8)).equals(disc)) throw new Error(`${name}: discriminator mismatch`);
  const expected = def.accounts.length + (opts.remaining ?? 0);
  if (ix.keys.length !== expected) throw new Error(`${name}: ${ix.keys.length} accounts, IDL expects ${expected}`);

  const byName: Record<string, PublicKey> = {};
  def.accounts.forEach((a, i) => (byName[a.name] = ix.keys[i]!.pubkey));

  def.accounts.forEach((a, i) => {
    const meta = ix.keys[i]!;
    const where = `${name}[${i}] ${a.name}`;
    const placeholder = a.optional && meta.pubkey.equals(programId);
    if (!placeholder && meta.isWritable !== Boolean(a.writable)) throw new Error(`${where}: writable ${meta.isWritable}`);
    const signer = opts.signerOverrides?.[a.name] ?? Boolean(a.signer);
    if (meta.isSigner !== signer) throw new Error(`${where}: signer ${meta.isSigner}`);
    if (placeholder) return;
    if (a.address && !meta.pubkey.equals(new PublicKey(a.address))) throw new Error(`${where}: ${meta.pubkey.toBase58()} != ${a.address}`);
    if (a.pda) {
      const derived = derive(a.pda, byName, programId);
      if (derived && !derived.equals(meta.pubkey)) throw new Error(`${where}: ${meta.pubkey.toBase58()} != PDA ${derived.toBase58()}`);
    }
  });
  return byName;
}

function seedBytes(seed: IdlSeed, byName: Record<string, PublicKey>): Uint8Array | null {
  if (seed.kind === "const") return Uint8Array.from(seed.value!);
  if (seed.kind === "account" && seed.path && !seed.path.includes(".")) return byName[seed.path]?.toBytes() ?? null;
  return null; // arg seeds and account-data paths (e.g. `bonding_curve.creator`) are not derivable here
}

function derive(pda: NonNullable<IdlAccount["pda"]>, byName: Record<string, PublicKey>, programId: PublicKey): PublicKey | null {
  const seeds: Uint8Array[] = [];
  for (const s of pda.seeds) {
    const b = seedBytes(s, byName);
    if (!b) return null;
    seeds.push(b);
  }
  let program = programId;
  if (pda.program) {
    const b = seedBytes(pda.program, byName);
    if (!b) return null;
    program = new PublicKey(b);
  }
  return PublicKey.findProgramAddressSync(seeds, program)[0];
}
