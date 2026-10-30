/**
 * Every discriminator the SDK hard-codes equals (a) sha256("global:<name>")[..8] / sha256("account:<Name>")[..8],
 * (b) the IDL's own value, and (c) the tables in docs/research/pump-integration.md §2–4 and fee-sharing.md §1.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import pumpIdl from "./idl/pump.json";
import ammIdl from "./idl/pump_amm.json";
import feesIdl from "./idl/pump_fees.json";
import { ANCHOR_EVENT_CPI_TAG, PUMP_ACCOUNT_DISC, PUMP_AMM_IX, PUMP_FEES_IX, PUMP_IX } from "./constants";
import copierIdl from "./idl/copy_vault.json";
import { COPIER_ACCOUNT_DISC } from "./program";

interface DiscIdl {
  instructions: { name: string; discriminator: number[] }[];
  accounts: { name: string; discriminator: number[] }[];
}

const hex = (b: ArrayLike<number>) => Buffer.from(Uint8Array.from(b)).toString("hex");
const sha8 = (s: string) => createHash("sha256").update(s).digest().subarray(0, 8).toString("hex");

function idlIx(idl: DiscIdl, name: string): string {
  const ix = idl.instructions.find((i) => i.name === name);
  assert.ok(ix, `IDL has ${name}`);
  return hex(ix.discriminator);
}

function idlAccount(idl: DiscIdl, name: string): string {
  const a = idl.accounts.find((x) => x.name === name);
  assert.ok(a, `IDL has account ${name}`);
  return hex(a.discriminator);
}

/** [SDK constant, IDL, instruction name, hex from the research tables]. */
const IX_TABLE: [Uint8Array, DiscIdl, string, string][] = [
  [PUMP_IX.createV2, pumpIdl, "create_v2", "d6904cec5f8b31b4"],
  [PUMP_IX.buyV2, pumpIdl, "buy_v2", "b817ee6167c5d33d"],
  [PUMP_IX.sellV2, pumpIdl, "sell_v2", "5df6823ce7e940b2"],
  [PUMP_IX.buyExactQuoteInV2, pumpIdl, "buy_exact_quote_in_v2", "c2ab1c46684d5b2f"],
  [PUMP_IX.buyV3, pumpIdl, "buy_v3", "07051dc4f5176550"],
  [PUMP_IX.sellV3, pumpIdl, "sell_v3", "1c92de7726c469d5"],
  [PUMP_IX.buyExactQuoteInV3, pumpIdl, "buy_exact_quote_in_v3", "e1f7501ed5b38488"],
  [PUMP_IX.sweepCreatorFee, pumpIdl, "sweep_creator_fee", "20f6bf3408c949ba"],
  [PUMP_IX.distributeCreatorFeesV2, pumpIdl, "distribute_creator_fees_v2", "ffcb134ff444089f"],
  [PUMP_AMM_IX.buy, ammIdl, "buy", "66063d1201daebea"],
  [PUMP_AMM_IX.sell, ammIdl, "sell", "33e685a4017f83ad"],
  [PUMP_AMM_IX.buyExactQuoteIn, ammIdl, "buy_exact_quote_in", "c62e1552b4d9e870"],
  [PUMP_AMM_IX.buyV2, ammIdl, "buy_v2", "b817ee6167c5d33d"],
  [PUMP_AMM_IX.sellV2, ammIdl, "sell_v2", "5df6823ce7e940b2"],
  [PUMP_AMM_IX.buyExactQuoteInV2, ammIdl, "buy_exact_quote_in_v2", "c2ab1c46684d5b2f"],
  [PUMP_AMM_IX.sweepCreatorFee, ammIdl, "sweep_creator_fee", "20f6bf3408c949ba"],
  [PUMP_AMM_IX.transferCreatorFeesToPumpV2, ammIdl, "transfer_creator_fees_to_pump_v2", "01214eb921432c5c"],
  [PUMP_FEES_IX.createFeeSharingConfig, feesIdl, "create_fee_sharing_config", "c34e564c6f34fbd5"],
  [PUMP_FEES_IX.updateFeeSharesV2, feesIdl, "update_fee_shares_v2", "6ffb31064e4e6a12"],
];

test("instruction discriminators match sha256, the IDLs and the research tables", () => {
  for (const [constant, idl, name, documented] of IX_TABLE) {
    assert.equal(hex(constant), documented, `${name}: SDK constant vs research`);
    assert.equal(idlIx(idl, name), documented, `${name}: IDL vs research`);
    assert.equal(sha8(`global:${name}`), documented, `${name}: sha256`);
  }
  // migrate_v2 is not in the research tables; its disc comes from the IDL alone
  assert.equal(hex(PUMP_IX.migrateV2), idlIx(pumpIdl, "migrate_v2"));
  assert.equal(sha8("global:migrate_v2"), hex(PUMP_IX.migrateV2));
});

test("pump and pump_amm share buy/sell discriminators, so whitelists key on (program, disc)", () => {
  assert.equal(idlIx(pumpIdl, "buy_v2"), idlIx(ammIdl, "buy_v2"));
  assert.equal(idlIx(pumpIdl, "sell_v2"), idlIx(ammIdl, "sell_v2"));
  assert.equal(idlIx(pumpIdl, "buy"), idlIx(ammIdl, "buy"));
});

test("account discriminators match the IDLs and the research tables", () => {
  const table: [Uint8Array, DiscIdl, string, string][] = [
    [PUMP_ACCOUNT_DISC.bondingCurve, pumpIdl, "BondingCurve", "17b7f83760d8ac60"],
    [PUMP_ACCOUNT_DISC.global, pumpIdl, "Global", "a7e8e8b1c86c727f"],
    [PUMP_ACCOUNT_DISC.pool, ammIdl, "Pool", "f19a6d0411b16dbc"],
    [PUMP_ACCOUNT_DISC.globalConfig, ammIdl, "GlobalConfig", "95089ccaa0fcb0d9"],
    [PUMP_ACCOUNT_DISC.sharingConfig, feesIdl, "SharingConfig", "d84a0900388c5d4b"],
    [PUMP_ACCOUNT_DISC.feeConfig, feesIdl, "FeeConfig", "8f3492bbdb7b4c9b"],
  ];
  for (const [constant, idl, name, documented] of table) {
    assert.equal(hex(constant), documented, name);
    assert.equal(idlAccount(idl, name), documented, `${name}: IDL`);
    assert.equal(sha8(`account:${name}`), documented, `${name}: sha256`);
  }
  assert.equal(hex(ANCHOR_EVENT_CPI_TAG), "e445a52e51cb9a1d");
  // Anchor's EVENT_IX_TAG: the first 8 sha256("anchor:event") bytes, byte-reversed (a u64 constant written LE)
  assert.equal(Buffer.from(createHash("sha256").update("anchor:event").digest().subarray(0, 8)).reverse().toString("hex"), "e445a52e51cb9a1d");
});

test("Copier account discriminators match sha256 and the synced Copier IDL", () => {
  const idl = copierIdl as DiscIdl;
  for (const [key, name] of [["config", "Config"], ["copier", "Copier"], ["position", "Position"], ["pendingChange", "PendingChange"]] as const) {
    assert.equal(hex(COPIER_ACCOUNT_DISC[key]), sha8(`account:${name}`), name);
    assert.equal(hex(COPIER_ACCOUNT_DISC[key]), idlAccount(idl, name), `${name}: IDL`);
  }
});
