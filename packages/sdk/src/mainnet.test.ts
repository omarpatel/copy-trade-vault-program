/**
 * PDAs and decoders against live mainnet accounts (src/fixtures/mainnet.json, dumped 2026-10-04:
 * pump globals, a fee-sharing coin on its curve, and a graduated fee-sharing coin with its pool).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { PublicKey } from "@solana/web3.js";
import fixtures from "./fixtures/mainnet.json";
import {
  PUMP_AMM_FEE_CONFIG,
  PUMP_AMM_GLOBAL_CONFIG,
  PUMP_AMM_PROGRAM_ID,
  PUMP_BUYBACK_FEE_RECIPIENTS,
  PUMP_FEE_CONFIG,
  PUMP_FEE_RECIPIENTS,
  PUMP_GLOBAL,
  PUMP_GLOBAL_VOLUME_ACCUMULATOR,
  PUMP_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "./constants";
import {
  decodeAmmGlobalConfig,
  decodeBondingCurve,
  decodeFeeConfig,
  decodePool,
  decodePumpGlobal,
  decodeSharingConfig,
  tokenAccountAmount,
} from "./layout";
import { curveFeeBps, poolFeeBps } from "./math";
import { curveReserves, PUMP_AMM_FEE_TIERS, PUMP_CURVE_FEE_BPS, poolReserves, marketCapLamports } from "./quote";
import {
  ammGlobalConfigPda,
  ata,
  bondingCurvePda,
  canonicalPoolPda,
  feeConfigPda,
  poolAuthorityPda,
  pumpGlobalPda,
  pumpGlobalVolumeAccumulatorPda,
  sharingConfigPda,
  wsolAta,
} from "./pda";

type Fixture = { address: string; owner: string; data: string };
const fx = fixtures as unknown as Record<string, Fixture>;
const data = (name: string) => Buffer.from(fx[name]!.data, "base64");
const addr = (name: string) => new PublicKey(fx[name]!.address);

test("global PDAs equal the live mainnet addresses", () => {
  assert.ok(pumpGlobalPda().equals(PUMP_GLOBAL));
  assert.ok(feeConfigPda(PUMP_PROGRAM_ID).equals(PUMP_FEE_CONFIG));
  assert.ok(feeConfigPda(PUMP_AMM_PROGRAM_ID).equals(PUMP_AMM_FEE_CONFIG));
  assert.ok(ammGlobalConfigPda().equals(PUMP_AMM_GLOBAL_CONFIG));
  assert.ok(pumpGlobalVolumeAccumulatorPda().equals(PUMP_GLOBAL_VOLUME_ACCUMULATOR));
});

test("a live fee-sharing coin: curve + sharing config PDAs and decoders", () => {
  const mint = addr("liveMint");
  assert.ok(bondingCurvePda(mint).equals(addr("liveCurve")));
  assert.ok(sharingConfigPda(mint).equals(addr("liveSharingConfig")));
  assert.equal(fx.liveCurve!.owner, PUMP_PROGRAM_ID.toBase58());

  const curve = decodeBondingCurve(data("liveCurve"));
  assert.equal(curve.complete, false);
  assert.ok(curve.creator.equals(sharingConfigPda(mint)), "fee-sharing curve creator is the sharing config");
  assert.ok(curve.quoteMint.equals(PublicKey.default));
  assert.equal(curve.tokenTotalSupply, 1_000_000_000_000_000n);
  // pump's curve invariant: virtual − real token reserves is the fixed 279.9M offset
  assert.equal(curve.virtualTokenReserves - curve.realTokenReserves, 279_900_000_000_000n);
  assert.equal(curve.virtualQuoteReserves - curve.realQuoteReserves, 30_000_000_000n);

  const sc = decodeSharingConfig(data("liveSharingConfig"));
  assert.equal(sc.version, 2);
  assert.equal(sc.status, "active");
  assert.equal(sc.adminRevoked, true);
  assert.ok(sc.mint.equals(mint));
  assert.equal(sc.shareholders.length, 2);
  assert.equal(sc.shareholders.reduce((s, x) => s + x.shareBps, 0), 10_000);
});

test("a graduated coin: canonical pool PDA, pool vault ATAs and coin creator", () => {
  const mint = addr("gradMint");
  assert.equal(decodeBondingCurve(data("gradCurve")).complete, true);
  const pool = canonicalPoolPda(mint);
  assert.ok(pool.equals(addr("gradPool")));
  const p = decodePool(data("gradPool"));
  assert.ok(p.baseMint.equals(mint));
  assert.ok(p.creator.equals(poolAuthorityPda(mint)));
  assert.ok(p.poolBaseTokenAccount.equals(ata(pool, mint, TOKEN_2022_PROGRAM_ID)));
  assert.ok(p.poolQuoteTokenAccount.equals(wsolAta(pool)));
  assert.ok(p.coinCreator.equals(sharingConfigPda(mint)), "migrated pool's coin creator is the sharing config");

  const reserves = poolReserves(p, tokenAccountAmount(data("gradPoolBase")), tokenAccountAmount(data("gradPoolQuote")));
  assert.ok(reserves.baseReserve > 0n && reserves.quoteReserve > 0n);
  const fees = poolFeeBps(decodeFeeConfig(data("ammFeeConfig")), p, reserves.baseReserve, reserves.quoteReserve, reserves.supply);
  const mcap = marketCapLamports(reserves);
  const expectTier = mcap >= 420_000_000_000n ? 20 : 2;
  assert.equal(fees.lpBps, expectTier);
});

test("FeeConfig decoders read the live schedules", () => {
  const curveCfg = decodeFeeConfig(data("pumpFeeConfig"));
  assert.deepEqual(curveCfg.feeTiers.map((t) => t.fees), [PUMP_CURVE_FEE_BPS]);
  const curve = decodeBondingCurve(data("liveCurve"));
  assert.deepEqual(curveFeeBps(curveCfg, curve, curveReserves(curve).supply), PUMP_CURVE_FEE_BPS);

  const ammCfg = decodeFeeConfig(data("ammFeeConfig"));
  assert.deepEqual(ammCfg.feeTiers, PUMP_AMM_FEE_TIERS);
  assert.deepEqual(ammCfg.flatFees, { lpBps: 25, protocolBps: 5, creatorBps: 0 });
});

test("Global / GlobalConfig decoders list the live fee recipients", () => {
  const g = decodePumpGlobal(data("pumpGlobal"));
  assert.deepEqual(g.buybackFeeRecipients.map(String), PUMP_BUYBACK_FEE_RECIPIENTS.map(String));
  assert.deepEqual(g.feeRecipients.map(String), PUMP_FEE_RECIPIENTS.map(String));
  assert.equal(g.initialVirtualTokenReserves, 1_073_000_000_000_000n);
  assert.equal(g.initialRealTokenReserves, 793_100_000_000_000n);
  const gc = decodeAmmGlobalConfig(data("ammGlobalConfig"));
  assert.deepEqual(gc.buybackFeeRecipients.map(String), PUMP_BUYBACK_FEE_RECIPIENTS.map(String));
});

test("decoders reject accounts of another type", () => {
  assert.throws(() => decodeBondingCurve(data("gradPool")));
  assert.throws(() => decodePool(data("liveCurve")));
  assert.throws(() => decodeSharingConfig(data("pumpGlobal")));
});
