import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, test } from "node:test";
import { BN, BorshCoder, type Idl } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { copierMemoTarget, parseDistributeEvents, PUMP_PROGRAM } from "./chain-logs";
import { walletDeltas, type RawTx } from "./rpc";

const require = createRequire(import.meta.url);
/** pump's own IDL (packages/sdk/src/idl/pump.json): the event is encoded by pump's layout, not by our decoder. */
const pumpIdl = require("../../../packages/sdk/src/idl/pump.json") as Idl;
const coder = new BorshCoder(pumpIdl);

const key = (n: number) => new PublicKey(Buffer.alloc(32, n));
const SIG = "2".repeat(87);

function distributeLog(fields: { distributed: bigint; shareholders: [PublicKey, number][]; sharingConfig: PublicKey; mint: PublicKey }): string {
  const ev = pumpIdl.events!.find((e) => e.name === "DistributeCreatorFeesEvent")!;
  const body = coder.types.encode("DistributeCreatorFeesEvent", {
    timestamp: new BN(1_759_560_000),
    mint: fields.mint,
    bonding_curve: key(9),
    sharing_config: fields.sharingConfig,
    admin: key(8),
    shareholders: fields.shareholders.map(([address, share_bps]) => ({ address, share_bps })),
    distributed: new BN(fields.distributed.toString()),
    quote_mint: PublicKey.default,
  });
  return `Program data: ${Buffer.concat([Buffer.from(ev.discriminator), body]).toString("base64")}`;
}

describe("copierMemoTarget", () => {
  test("reads `copier:<sig>` from the memo program's log line", () => {
    const logs = [
      "Program ComputeBudget111111111111111111111111111111 invoke [1]",
      "Program ComputeBudget111111111111111111111111111111 success",
      "Program MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr invoke [1]",
      `Program log: Memo (len 94): "copier:${SIG}"`,
      "Program MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr consumed 7290 of 200000 compute units",
      "Program MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr success",
    ];
    assert.equal(copierMemoTarget(logs), SIG);
  });

  test("ignores other memos and memo-looking logs printed by other programs", () => {
    assert.equal(
      copierMemoTarget([
        "Program MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr invoke [1]",
        'Program log: Memo (len 5): "hello"',
        "Program MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr success",
        "Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P invoke [1]",
        `Program log: Memo (len 94): "copier:${SIG}"`,
      ]),
      null,
    );
  });
});

describe("parseDistributeEvents", () => {
  const mint = key(1);
  const sc = key(2);
  const target = key(3);
  const vault = key(4);

  test("decodes pump's DistributeCreatorFeesEvent inside a distribute_creator_fees_v2 frame", () => {
    const logs = [
      `Program ${PUMP_PROGRAM} invoke [1]`,
      "Program log: Instruction: DistributeCreatorFeesV2",
      "Program 11111111111111111111111111111111 invoke [2]",
      "Program 11111111111111111111111111111111 success",
      "Program 11111111111111111111111111111111 invoke [2]",
      "Program 11111111111111111111111111111111 success",
      distributeLog({ mint, sharingConfig: sc, distributed: 123_456_789n, shareholders: [[target, 1_500], [vault, 8_500]] }),
      `Program ${PUMP_PROGRAM} consumed 31210 of 400000 compute units`,
      `Program ${PUMP_PROGRAM} success`,
    ];
    const [ev, ...rest] = parseDistributeEvents(logs);
    assert.equal(rest.length, 0);
    assert.equal(ev?.mint, mint.toBase58());
    assert.equal(ev?.sharingConfig, sc.toBase58());
    assert.equal(ev?.distributed, 123_456_789n);
    assert.equal(ev?.timestamp, 1_759_560_000);
    assert.deepEqual(ev?.shareholders, [
      { address: target.toBase58(), shareBps: 1_500 },
      { address: vault.toBase58(), shareBps: 8_500 },
    ]);
  });

  test("only pump frames count", () => {
    const line = distributeLog({ mint, sharingConfig: sc, distributed: 1n, shareholders: [[vault, 10_000]] });
    assert.deepEqual(parseDistributeEvents(["Program 9R8g8JtEqRAh5yZ4aXbf1mWcfgLq9kAo6fmx93MSK9k7 invoke [1]", line]), []);
  });
});

describe("walletDeltas (classify port)", () => {
  test("folds wSOL into SOL and adds back the fee the wallet paid", () => {
    const wallet = key(5).toBase58();
    const tokenMint = key(6).toBase58();
    const tx: RawTx = {
      slot: 1,
      blockTime: 2,
      err: null,
      fee: 5_000n,
      logs: [],
      keys: [wallet, key(7).toBase58()],
      signers: [wallet],
      preBalances: [10_000_000_000, 0],
      postBalances: [9_000_000_000 - 5_000, 0],
      preTokenBalances: [{ accountIndex: 1, mint: "So11111111111111111111111111111111111111112", owner: wallet, amount: 500_000_000n }],
      postTokenBalances: [
        { accountIndex: 1, mint: "So11111111111111111111111111111111111111112", owner: wallet, amount: 0n },
        { accountIndex: 2, mint: tokenMint, owner: wallet, amount: 42_000_000n },
      ],
    };
    assert.deepEqual(walletDeltas(tx, wallet, tokenMint), { tokenDelta: 42_000_000n, solDelta: -1_500_000_000n, solBefore: 10_000_000_000n });
  });
});
