import assert from "node:assert/strict";
import { test } from "node:test";
import { Keypair, PublicKey } from "@solana/web3.js";
import pumpIdl from "./idl/pump.json";
import ammIdl from "./idl/pump_amm.json";
import feesIdl from "./idl/pump_fees.json";
import { checkIxAgainstIdl, type Idl } from "./testing/idl-check";
import {
  ammBuyIxs,
  ammSellIxs,
  canonicalPoolKeys,
  createFeeSharingConfigIx,
  CURVE_V3_INDEX,
  distributeCreatorFeesV2Ix,
  POOL_V2_INDEX,
  pumpBuyExactQuoteInV2Ix,
  pumpBuyIxs,
  pumpCreateV2Ix,
  pumpMigrateIx,
  pumpSellIx,
  sweepCreatorFeeIx,
  sweepPoolCreatorFeeIx,
  transferCreatorFeesToPumpV2Ix,
  updateFeeSharesV2Ix,
} from "./pump";
import { bondingCurvePda, canonicalPoolPda, sharingConfigPda, wsolAta } from "./pda";

const PUMP = pumpIdl as Idl;
const AMM = ammIdl as Idl;
const FEES = feesIdl as Idl;

const key = () => Keypair.generate().publicKey;
const mint = key();
const user = key();

test("create_v2 matches the pump IDL and encodes its args", () => {
  const ix = pumpCreateV2Ix({ mint, user, creator: user, name: "Copier", symbol: "MRR", uri: "https://x/y.json" });
  checkIxAgainstIdl(PUMP, "create_v2", ix);
  const data = ix.data;
  // disc + 3 strings (4-byte len prefixes) + creator + mayhem + cashback + creator_fee_bps(u64) + holder_reward
  assert.equal(data.length, 8 + 4 + 6 + 4 + 3 + 4 + 16 + 32 + 1 + 1 + 8 + 1);
  assert.equal(data.readUInt32LE(8), 6);
  assert.equal(data.subarray(12, 18).toString(), "Copier");
  assert.ok(new PublicKey(data.subarray(45, 77)).equals(user));
  assert.deepEqual([...data.subarray(77)], [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
});

test("fee-sharing launch instructions match the pump_fees IDL", () => {
  checkIxAgainstIdl(FEES, "create_fee_sharing_config", createFeeSharingConfigIx({ payer: user, mint }));
  const target = key();
  const vault = key();
  const ix = updateFeeSharesV2Ix({
    authority: user,
    mint,
    shareholders: [
      { address: target, shareBps: 2_000 },
      { address: vault, shareBps: 8_000 },
    ],
    currentShareholders: [user],
  });
  checkIxAgainstIdl(FEES, "update_fee_shares_v2", ix, { remaining: 1 });
  assert.ok(ix.keys.at(-1)!.pubkey.equals(user) && ix.keys.at(-1)!.isWritable);
  assert.equal(ix.data.readUInt32LE(8), 2);
  assert.ok(new PublicKey(ix.data.subarray(12, 44)).equals(target));
  assert.equal(ix.data.readUInt16LE(44), 2_000);
  assert.ok(new PublicKey(ix.data.subarray(46, 78)).equals(vault));
  assert.equal(ix.data.readUInt16LE(78), 8_000);
});

test("update_fee_shares_v2 rejects splits pump would reject", () => {
  const a = key();
  const b = key();
  const base = { authority: user, mint, currentShareholders: [user] };
  assert.throws(() => updateFeeSharesV2Ix({ ...base, shareholders: [] }));
  assert.throws(() => updateFeeSharesV2Ix({ ...base, shareholders: [{ address: a, shareBps: 9_999 }] }));
  assert.throws(() => updateFeeSharesV2Ix({ ...base, shareholders: [{ address: a, shareBps: 10_000 }, { address: b, shareBps: 0 }] }));
  assert.throws(() =>
    updateFeeSharesV2Ix({ ...base, shareholders: [{ address: a, shareBps: 5_000 }, { address: a, shareBps: 5_000 }] }),
  );
  const eleven = Array.from({ length: 11 }, (_, i) => ({ address: key(), shareBps: i === 0 ? 10_000 - 10 * 909 : 909 }));
  assert.throws(() => updateFeeSharesV2Ix({ ...base, shareholders: eleven }));
});

test("dev buy (buy_exact_quote_in_v2) matches the pump IDL and pays the sharing config's creator vault", () => {
  const sc = sharingConfigPda(mint);
  const ix = pumpBuyExactQuoteInV2Ix({ user, mint, creator: sc, solIn: 1_000_000_000n, minTokensOut: 5n });
  const named = checkIxAgainstIdl(PUMP, "buy_exact_quote_in_v2", ix);
  assert.ok(named.sharing_config!.equals(sc));
  const creatorVault = PublicKey.findProgramAddressSync([Buffer.from("creator-vault"), sc.toBuffer()], new PublicKey(PUMP.address))[0];
  assert.ok(named.creator_vault!.equals(creatorVault));
  assert.equal(ix.data.length, 8 + 8 + 8 + 1);
  assert.equal(ix.data.readBigUInt64LE(8), 1_000_000_000n);
  assert.equal(ix.data.readBigUInt64LE(16), 5n);
  assert.equal(ix.data[24], 1);
});

test("curve v3 trades match the pump IDL; descriptor indices point at user / mint / curve", () => {
  const [ataIx, buy] = pumpBuyIxs({ user, mint, solIn: 10n ** 8n, minTokensOut: 1n });
  assert.ok(ataIx);
  const named = checkIxAgainstIdl(PUMP, "buy_exact_quote_in_v3", buy!);
  const sell = pumpSellIx({ user, mint, tokensIn: 7n, minSolOut: 3n });
  checkIxAgainstIdl(PUMP, "sell_v3", sell);
  checkIxAgainstIdl(PUMP, "buy_v3", { ...sell, data: Buffer.concat([Buffer.from(PUMP.instructions.find((i) => i.name === "buy_v3")!.discriminator), Buffer.alloc(17)]) } as typeof sell);
  assert.equal(buy!.keys.length, CURVE_V3_INDEX.count);
  assert.ok(buy!.keys[CURVE_V3_INDEX.user]!.pubkey.equals(user));
  assert.ok(buy!.keys[CURVE_V3_INDEX.baseMint]!.pubkey.equals(mint));
  assert.ok(buy!.keys[CURVE_V3_INDEX.venue]!.pubkey.equals(bondingCurvePda(mint)));
  assert.ok(named.quote_mint!.equals(new PublicKey("So11111111111111111111111111111111111111112")));
  assert.equal(buy!.data.length, 25);
  assert.equal(sell.data.length, 24);
});

test("AMM v2 trades match the pump_amm IDL; descriptor indices point at user / mint / pool", () => {
  const ixs = ammBuyIxs({ user, mint, solIn: 10n ** 8n, minTokensOut: 1n });
  const buy = ixs.find((i) => i.programId.toBase58() === AMM.address)!;
  checkIxAgainstIdl(AMM, "buy_exact_quote_in_v2", buy);
  const sell = ammSellIxs({ user, mint, tokensIn: 5n, minSolOut: 1n }).find((i) => i.programId.toBase58() === AMM.address)!;
  checkIxAgainstIdl(AMM, "sell_v2", sell);
  assert.ok(buy.keys[POOL_V2_INDEX.user]!.pubkey.equals(user));
  assert.ok(buy.keys[POOL_V2_INDEX.baseMint]!.pubkey.equals(mint));
  assert.ok(buy.keys[POOL_V2_INDEX.venue]!.pubkey.equals(canonicalPoolPda(mint)));
  assert.ok(buy.keys[6]!.pubkey.equals(wsolAta(user)));
});

test("migrate_v2 matches the pump IDL", () => {
  checkIxAgainstIdl(PUMP, "migrate_v2", pumpMigrateIx({ user, mint, withdrawAuthority: key() }), { remaining: 2 });
});

test("creator-fee crank instructions match the IDLs", () => {
  const sc = sharingConfigPda(mint);
  checkIxAgainstIdl(PUMP, "sweep_creator_fee", sweepCreatorFeeIx({ payer: user, mint, creator: sc }));
  checkIxAgainstIdl(AMM, "sweep_creator_fee", sweepPoolCreatorFeeIx({ payer: user, pool: canonicalPoolKeys(mint), coinCreator: sc }));
  checkIxAgainstIdl(AMM, "transfer_creator_fees_to_pump_v2", transferCreatorFeesToPumpV2Ix({ payer: user, coinCreator: sc }));
  const shareholders = [key(), key()];
  const dist = distributeCreatorFeesV2Ix({ payer: user, mint, shareholders });
  checkIxAgainstIdl(PUMP, "distribute_creator_fees_v2", dist, { remaining: 2 });
  assert.deepEqual(dist.keys.slice(-2).map((k) => k.pubkey.toBase58()), shareholders.map((k) => k.toBase58()));
  assert.equal(dist.data[8], 0);
});
