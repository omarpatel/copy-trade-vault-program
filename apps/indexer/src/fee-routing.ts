import {
  bondingCurvePda,
  canonicalPoolPda,
  decodeBondingCurve,
  decodePool,
  decodeSharingConfig,
  PUMP_AMM_PROGRAM_ID,
  PUMP_FEES_PROGRAM_ID,
  PUMP_PROGRAM_ID,
  sharingConfigPda,
  type SharingConfig,
} from "@copy-trade-vault/sdk";
import type { FeeRouting, FeeRoutingStatus } from "@copy-trade-vault/sdk/api";
import { PublicKey } from "@solana/web3.js";

/** What a copier registered with (`register_copier` / `register_index`). */
export interface RegisteredRouting {
  mint: string;
  kind: "single" | "index";
  /** Single: the one target; index copiers' shareholders are the vault alone. */
  targets: string[];
  traderBps: number;
  vault: string;
  sharingConfig: string;
}

export interface RawAccount {
  owner: string;
  data: Uint8Array;
}

/** The three accounts fee routing depends on (null = account does not exist). */
export interface RoutingAccounts {
  sharingConfig: RawAccount | null;
  bondingCurve: RawAccount | null;
  /** Canonical PumpSwap pool (exists once the coin graduated). */
  pool: RawAccount | null;
}

export interface RoutingKeys {
  sharingConfig: PublicKey;
  bondingCurve: PublicKey;
  pool: PublicKey;
}

/** Accounts to read for `checkFeeRouting`, in `RoutingAccounts` order. */
export function routingKeys(r: RegisteredRouting): RoutingKeys {
  const mint = new PublicKey(r.mint);
  return { sharingConfig: new PublicKey(r.sharingConfig), bondingCurve: bondingCurvePda(mint), pool: canonicalPoolPda(mint) };
}

/** The split `register_copier` / `register_index` required: single = [target X, vault 10000 − X]; index = [vault 10000]. */
export function expectedShareholders(r: RegisteredRouting): { address: string; bps: number }[] {
  if (r.kind === "index") return [{ address: r.vault, bps: 10_000 }];
  return [
    { address: r.targets[0] ?? "", bps: r.traderBps },
    { address: r.vault, bps: 10_000 - r.traderBps },
  ];
}

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

/**
 * Re-runs `check_launch`'s fee-routing checks (programs/copy-vault/src/instructions/register.rs, fee-sharing research §7)
 * against current chain state: the canonical pump_fees sharing config (v2, Active, admin revoked, for this mint) holds
 * exactly the registered shareholders, the bonding curve's creator is the sharing config, and after graduation the
 * canonical pool's coin_creator is too. Any difference means pump.fun's admin (CTO) rewrote the routing.
 */
export function checkFeeRouting(r: RegisteredRouting, acc: RoutingAccounts, now: number): FeeRouting {
  const problems: string[] = [];
  let shareholders: FeeRouting["shareholders"] = [];
  const result = (status: FeeRoutingStatus): FeeRouting => ({ status, checkedAt: now, detail: problems.length ? problems.join("; ") : null, shareholders });

  const canonical = sharingConfigPda(new PublicKey(r.mint)).toBase58();
  if (r.sharingConfig !== canonical) problems.push(`registered sharing config ${short(r.sharingConfig)} is not the canonical ${short(canonical)}`);

  const sc = acc.sharingConfig;
  if (!sc) {
    problems.push("sharing config account was closed");
  } else if (sc.owner !== PUMP_FEES_PROGRAM_ID.toBase58()) {
    problems.push(`sharing config is now owned by ${short(sc.owner)}, not pump_fees`);
  } else {
    let decoded: SharingConfig | null = null;
    try {
      decoded = decodeSharingConfig(sc.data);
    } catch (err) {
      problems.push(`sharing config no longer decodes (${err instanceof Error ? err.message : String(err)})`);
    }
    if (decoded) {
      shareholders = decoded.shareholders.map((s) => ({ address: s.address.toBase58(), bps: s.shareBps }));
      if (decoded.version !== 2) problems.push(`sharing config version is ${decoded.version} (registered at 2: a CTO reset bumps it)`);
      if (decoded.status !== "active") problems.push("sharing config is paused: distributions are blocked");
      if (decoded.mint.toBase58() !== r.mint) problems.push("sharing config belongs to another mint");
      if (!decoded.adminRevoked) problems.push("admin is no longer revoked: the split can be edited again");
      const expected = expectedShareholders(r);
      const same =
        shareholders.length === expected.length &&
        expected.every((e) => shareholders.filter((s) => s.address === e.address && s.bps === e.bps).length === 1);
      if (!same) {
        const fmt = (list: { address: string; bps: number }[]) => list.map((s) => `${short(s.address)} ${s.bps / 100}%`).join(", ") || "none";
        problems.push(`shareholders changed: now [${fmt(shareholders)}], registered [${fmt(expected)}]`);
      }
    }
  }

  const bc = acc.bondingCurve;
  if (bc && bc.owner === PUMP_PROGRAM_ID.toBase58()) {
    try {
      const curve = decodeBondingCurve(bc.data);
      if (curve.creator.toBase58() !== r.sharingConfig) problems.push(`bonding curve creator moved to ${short(curve.creator.toBase58())}`);
    } catch (err) {
      problems.push(`bonding curve no longer decodes (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  const pool = acc.pool;
  if (pool && pool.owner === PUMP_AMM_PROGRAM_ID.toBase58()) {
    try {
      const p = decodePool(pool.data);
      if (p.coinCreator.toBase58() !== r.sharingConfig) problems.push(`PumpSwap pool coin_creator moved to ${short(p.coinCreator.toBase58())}`);
    } catch (err) {
      problems.push(`PumpSwap pool no longer decodes (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  if (!bc && !pool) problems.push("neither the bonding curve nor the canonical pool exists");
  return result(problems.length ? "changed" : "intact");
}
