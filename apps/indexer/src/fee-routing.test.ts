import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { PUMP_ACCOUNT_DISC, PUMP_AMM_PROGRAM_ID, PUMP_FEES_PROGRAM_ID, PUMP_PROGRAM_ID, sharingConfigPda, vaultPda } from "@copy-trade-vault/sdk";
import { PublicKey } from "@solana/web3.js";
import { checkFeeRouting, expectedShareholders, type RawAccount, type RegisteredRouting } from "./fee-routing";

const MINT = new PublicKey(Buffer.alloc(32, 7));
const TARGET = new PublicKey("D1YLG89jz5vPH4UHYPZqQrE47CRehFWuGiWSLP6Pj9uC");
const LAUNCHER = new PublicKey(Buffer.alloc(32, 9));
const SC = sharingConfigPda(MINT);
const VAULT = vaultPda(MINT);
const NOW = 1_759_560_000;

const single: RegisteredRouting = {
  mint: MINT.toBase58(),
  kind: "single",
  targets: [TARGET.toBase58()],
  traderBps: 1_500,
  vault: VAULT.toBase58(),
  sharingConfig: SC.toBase58(),
};

/** pump_fees `SharingConfig` bytes (fee-sharing research §2): disc, bump, version, status, mint, admin, admin_revoked, vec<Shareholder{pubkey,u16}>. */
function sharingConfig(o: { version?: number; active?: boolean; adminRevoked?: boolean; shareholders: [PublicKey, number][] }): RawAccount {
  const b = Buffer.alloc(80 + 34 * o.shareholders.length);
  Buffer.from(PUMP_ACCOUNT_DISC.sharingConfig).copy(b, 0);
  b[8] = 254;
  b[9] = o.version ?? 2;
  b[10] = o.active === false ? 0 : 1;
  MINT.toBuffer().copy(b, 11);
  LAUNCHER.toBuffer().copy(b, 43);
  b[75] = o.adminRevoked === false ? 0 : 1;
  b.writeUInt32LE(o.shareholders.length, 76);
  o.shareholders.forEach(([address, bps], i) => {
    address.toBuffer().copy(b, 80 + 34 * i);
    b.writeUInt16LE(bps, 112 + 34 * i);
  });
  return { owner: PUMP_FEES_PROGRAM_ID.toBase58(), data: b };
}

/** pump `BondingCurve` bytes (151, pump-integration research §4.1). */
function bondingCurve(creator: PublicKey, complete = false): RawAccount {
  const b = Buffer.alloc(151);
  Buffer.from(PUMP_ACCOUNT_DISC.bondingCurve).copy(b, 0);
  b.writeBigUInt64LE(1_000_000_000_000_000n, 8);
  b.writeBigUInt64LE(30_000_000_000n, 16);
  b.writeBigUInt64LE(793_100_000_000_000n, 24);
  b.writeBigUInt64LE(0n, 32);
  b.writeBigUInt64LE(1_000_000_000_000_000n, 40);
  b[48] = complete ? 1 : 0;
  creator.toBuffer().copy(b, 49);
  return { owner: PUMP_PROGRAM_ID.toBase58(), data: b };
}

/** pump_amm `Pool` bytes (300, research §4.2): coin_creator at 211. */
function pool(coinCreator: PublicKey): RawAccount {
  const b = Buffer.alloc(300);
  Buffer.from(PUMP_ACCOUNT_DISC.pool).copy(b, 0);
  MINT.toBuffer().copy(b, 43);
  coinCreator.toBuffer().copy(b, 211);
  return { owner: PUMP_AMM_PROGRAM_ID.toBase58(), data: b };
}

const registered: [PublicKey, number][] = [
  [TARGET, 1_500],
  [VAULT, 8_500],
];

describe("checkFeeRouting", () => {
  test("intact: registered split, admin revoked, curve creator = sharing config (any shareholder order)", () => {
    const r = checkFeeRouting(single, { sharingConfig: sharingConfig({ shareholders: [...registered].reverse() }), bondingCurve: bondingCurve(SC), pool: null }, NOW);
    assert.equal(r.status, "intact");
    assert.equal(r.detail, null);
    assert.equal(r.checkedAt, NOW);
    assert.deepEqual(r.shareholders, [
      { address: VAULT.toBase58(), bps: 8_500 },
      { address: TARGET.toBase58(), bps: 1_500 },
    ]);
  });

  test("intact after graduation: completed curve and pool coin_creator both still the sharing config", () => {
    const r = checkFeeRouting(single, { sharingConfig: sharingConfig({ shareholders: registered }), bondingCurve: bondingCurve(SC, true), pool: pool(SC) }, NOW);
    assert.equal(r.status, "intact");
  });

  test("shareholders changed: the admin redirected the split", () => {
    const thief = new PublicKey(Buffer.alloc(32, 66));
    const r = checkFeeRouting(
      single,
      {
        sharingConfig: sharingConfig({
          shareholders: [
            [thief, 9_000],
            [VAULT, 1_000],
          ],
        }),
        bondingCurve: bondingCurve(SC),
        pool: null,
      },
      NOW,
    );
    assert.equal(r.status, "changed");
    assert.match(r.detail!, /shareholders changed/);
    assert.deepEqual(r.shareholders[0], { address: thief.toBase58(), bps: 9_000 });
  });

  test("same addresses but different bps is a change", () => {
    const r = checkFeeRouting(
      single,
      {
        sharingConfig: sharingConfig({
          shareholders: [
            [TARGET, 2_500],
            [VAULT, 7_500],
          ],
        }),
        bondingCurve: bondingCurve(SC),
        pool: null,
      },
      NOW,
    );
    assert.equal(r.status, "changed");
  });

  test("creator migrated away: curve creator or pool coin_creator no longer the sharing config", () => {
    const other = new PublicKey(Buffer.alloc(32, 77));
    const curve = checkFeeRouting(single, { sharingConfig: sharingConfig({ shareholders: registered }), bondingCurve: bondingCurve(other), pool: null }, NOW);
    assert.equal(curve.status, "changed");
    assert.match(curve.detail!, /bonding curve creator moved/);
    const graduated = checkFeeRouting(single, { sharingConfig: sharingConfig({ shareholders: registered }), bondingCurve: bondingCurve(SC, true), pool: pool(other) }, NOW);
    assert.equal(graduated.status, "changed");
    assert.match(graduated.detail!, /coin_creator moved/);
  });

  test("admin not revoked, paused, version reset or closed config are changes", () => {
    const cases: [RawAccount | null, RegExp][] = [
      [sharingConfig({ shareholders: registered, adminRevoked: false }), /admin is no longer revoked/],
      [sharingConfig({ shareholders: registered, active: false }), /paused/],
      [sharingConfig({ shareholders: registered, version: 3 }), /version is 3/],
      [null, /closed/],
      [{ owner: PublicKey.default.toBase58(), data: new Uint8Array(0) }, /not pump_fees/],
    ];
    for (const [sc, re] of cases) {
      const r = checkFeeRouting(single, { sharingConfig: sc, bondingCurve: bondingCurve(SC), pool: null }, NOW);
      assert.equal(r.status, "changed");
      assert.match(r.detail!, re);
    }
  });

  test("index copiers must route 100% to the vault", () => {
    const index: RegisteredRouting = { ...single, kind: "index", traderBps: 0, targets: [TARGET.toBase58(), LAUNCHER.toBase58()] };
    assert.deepEqual(expectedShareholders(index), [{ address: VAULT.toBase58(), bps: 10_000 }]);
    const ok = checkFeeRouting(index, { sharingConfig: sharingConfig({ shareholders: [[VAULT, 10_000]] }), bondingCurve: bondingCurve(SC), pool: null }, NOW);
    assert.equal(ok.status, "intact");
    const bad = checkFeeRouting(index, { sharingConfig: sharingConfig({ shareholders: registered }), bondingCurve: bondingCurve(SC), pool: null }, NOW);
    assert.equal(bad.status, "changed");
  });
});
