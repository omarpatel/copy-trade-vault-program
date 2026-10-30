import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { accountKeys, classifyTx } from "./classifier";
import type { RawTx } from "./rpc";

/**
 * Real mainnet transactions (fetched 2026-10-04 with getTransaction(maxSupportedTransactionVersion: 1), see
 * __fixtures__/manifest.json): KOL trades on the pump curve, PumpSwap (direct and through a terminal router), a
 * Jupiter route, a pump-coin airdrop sent to two KOLs, and the noise that must classify as nothing.
 */

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__");
const manifest: Record<string, { signature: string; target: string; alsoTargets?: string[] }> = JSON.parse(
  fs.readFileSync(path.join(dir, "manifest.json"), "utf8"),
);
const load = (name: string): RawTx => JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), "utf8"));
const only = (name: string) => {
  const legs = classifyTx(load(name), manifest[name]!.target);
  assert.equal(legs.length, 1, `${name}: expected exactly one leg`);
  return legs[0]!;
};

describe("classifyTx on recorded mainnet transactions", () => {
  it("pump curve buy: signer, token up, SOL spent net of fee and ATA rent", () => {
    const tx = load("pump-curve-buy");
    const leg = only("pump-curve-buy");
    assert.equal(leg.side, "buy");
    assert.equal(leg.signer, true);
    assert.equal(leg.signature, manifest["pump-curve-buy"]!.signature);
    assert.equal(leg.tokenMint, "RrM6FkvmJ8kwyK2SEN6K9wNm3kX5jrV262ihQM1sF99");
    assert.equal(leg.tokenDelta, 2_307_150_686_072n);
    assert.equal(leg.venueHint, "pump");
    assert.equal(leg.isCreate, false);
    // The raw lamport drop includes the network fee and the rent of the token account opened in this tx.
    const i = accountKeys(tx).indexOf(leg.target);
    const rawDrop = BigInt(tx.meta!.postBalances[i]! - tx.meta!.preBalances[i]!);
    assert.ok(rawDrop < leg.solDelta, "fee/rent must not count as trade flow");
    assert.equal(leg.solDelta, -206_000_000n);
    assert.equal(leg.solBefore, BigInt(tx.meta!.preBalances[i]!));
    assert.ok(Math.abs(leg.priceLamportsPerToken! - 206_000_000 / 2_307_150_686_072) < 1e-15);
  });

  it("pump curve sell of the whole bag", () => {
    const leg = only("pump-curve-sell");
    assert.equal(leg.side, "sell");
    assert.equal(leg.tokenDelta, -27_383_123_176_675n);
    assert.equal(leg.tokenAfter, 0n);
    assert.equal(leg.solDelta, 1_657_123_552n);
    assert.equal(leg.venueHint, "pump");
  });

  it("PumpSwap buy and sell (graduated coin)", () => {
    const buy = only("pumpswap-buy");
    assert.equal(buy.side, "buy");
    assert.equal(buy.tokenMint, "22JqJZSRbvCZFwXVd4qYtKw89EE1vgqDk8bw966ykxCi");
    assert.equal(buy.solDelta, -222_000_000n);
    assert.equal(buy.venueHint, "pump_amm");
    const sell = only("pumpswap-sell");
    assert.equal(sell.side, "sell");
    assert.equal(sell.tokenMint, buy.tokenMint);
    assert.equal(sell.solDelta, 7_917_512_353n);
  });

  it("terminal router into PumpSwap: wSOL folded, the untouched USDC account ignored", () => {
    const buy = only("router-pumpswap-buy");
    assert.equal(buy.side, "buy");
    assert.equal(buy.tokenDelta, 687_556_744_478n);
    assert.equal(buy.solDelta, -8_500_010_000n);
    const sell = only("router-pumpswap-sell");
    assert.equal(sell.side, "sell");
    assert.equal(sell.tokenDelta, -429_337_168_891n);
    assert.equal(sell.solDelta, 8_325_933_211n);
  });

  it("Jupiter route sell", () => {
    const leg = only("jupiter-sell");
    assert.equal(leg.side, "sell");
    assert.equal(leg.tokenMint, "H5mBRtgRA2jkAx4ALbF3cEbhYJJVHYcdYDSjE4wUpump");
    assert.equal(leg.tokenDelta, -110_613_551_146n);
    assert.equal(leg.solDelta, 27_446_420n);
  });

  it("pump-coin airdrop to two KOLs: unsigned increase for each, never a buy", () => {
    const tx = load("pump-coin-airdrop");
    const { target, alsoTargets } = manifest["pump-coin-airdrop"]!;
    for (const wallet of [target, ...alsoTargets!]) {
      const legs = classifyTx(tx, wallet);
      assert.equal(legs.length, 1);
      assert.equal(legs[0]!.side, "airdrop");
      assert.equal(legs[0]!.signer, false);
      assert.equal(legs[0]!.tokenDelta, 10_000_000n);
      assert.equal(legs[0]!.solDelta, 0n);
      assert.equal(legs[0]!.priceLamportsPerToken, null);
    }
  });

  it("noise classifies as nothing: creator-fee receipt, v1 mention spam, zero-amount ATA creation", () => {
    for (const name of ["creator-fee-receipt", "v1-mention-spam", "ata-create-spam"]) {
      assert.deepEqual(classifyTx(load(name), manifest[name]!.target), [], name);
    }
  });

  it("reads v1 transactions (lookup-table keys included in the index space)", () => {
    const tx = load("v1-mention-spam");
    assert.equal(tx.version, 1);
    assert.ok(accountKeys(tx).includes(manifest["v1-mention-spam"]!.target));
  });

  it("a failed transaction has no legs", () => {
    const tx = load("pump-curve-buy");
    tx.meta!.err = { InstructionError: [3, { Custom: 6002 }] };
    assert.deepEqual(classifyTx(tx, manifest["pump-curve-buy"]!.target), []);
  });

  it("an unsigned decrease (delegate / limit fill) is a transfer out, copied as de-risking", () => {
    const tx = load("pump-coin-airdrop");
    const meta = tx.meta!;
    [meta.preTokenBalances, meta.postTokenBalances] = [meta.postTokenBalances, meta.preTokenBalances];
    [meta.preBalances, meta.postBalances] = [meta.postBalances, meta.preBalances];
    const legs = classifyTx(tx, manifest["pump-coin-airdrop"]!.target);
    assert.equal(legs.length, 1);
    assert.equal(legs[0]!.side, "transfer_out");
    assert.equal(legs[0]!.tokenDelta, -10_000_000n);
  });

  it("a wallet that is not in the transaction has no legs", () => {
    assert.deepEqual(classifyTx(load("pump-curve-buy"), manifest["jupiter-sell"]!.target), []);
  });
});
