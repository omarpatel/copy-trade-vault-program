import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Keypair, PublicKey, type Connection, type SignatureStatus } from "@solana/web3.js";
import { memoIx } from "@copy-trade-vault/sdk";
import { loadConfig } from "./config";
import { Executor, SendError } from "./executor";

const cfg = loadConfig({ RPC_URL: "http://127.0.0.1:8899", KEEPER_KEYPAIR: "unused.json", INDEXER_URL: "http://127.0.0.1:1", PRIORITY_MICROLAMPORTS: "0", MAX_PRIORITY_MICROLAMPORTS: "0" });

/** The connection calls `Executor.send` makes, scripted: block height and signature status per poll. */
function fakeConnection(script: { height: () => number; status: () => Partial<SignatureStatus> | null }) {
  let sends = 0;
  const conn = {
    simulateTransaction: async () => ({ context: { slot: 1 }, value: { err: null, unitsConsumed: 10_000, logs: [], accounts: null } }),
    getRecentPrioritizationFees: async () => [],
    getLatestBlockhash: async () => ({ blockhash: PublicKey.default.toBase58(), lastValidBlockHeight: 100 }),
    sendRawTransaction: async () => {
      sends++;
      return "sig";
    },
    getBlockHeight: async () => script.height(),
    getSignatureStatuses: async () => ({ context: { slot: 1 }, value: [script.status()] }),
    getTransaction: async () => ({ meta: { logMessages: ["Program log: ok"] } }),
  };
  return { conn: conn as unknown as Connection, sends: () => sends };
}

const timing = { statusPollMs: 2, rebroadcastMs: 10 };
const signer = Keypair.generate();

describe("Executor confirmation", () => {
  it("gives up on a transaction stuck at 'processed' (dropped fork) once the blockhash expired", async () => {
    const { conn } = fakeConnection({ height: () => 101, status: () => ({ slot: 5, confirmations: 0, err: null, confirmationStatus: "processed" }) });
    const executor = new Executor(conn, cfg, timing);
    await assert.rejects(executor.send(signer, [memoIx("x")]), (err: unknown) => {
      assert.ok(err instanceof SendError);
      assert.match(err.message, /blockhash expired; the transaction only reached processed/);
      return true;
    });
  });

  it("gives up on a transaction that never landed once the blockhash expired", async () => {
    const { conn, sends } = fakeConnection({ height: () => 101, status: () => null });
    await assert.rejects(new Executor(conn, cfg, timing).send(signer, [memoIx("x")]), /blockhash expired before the transaction landed/);
    assert.equal(sends(), 1);
  });

  it("keeps waiting (and rebroadcasting) while the blockhash is valid, then returns once confirmed", async () => {
    let polls = 0;
    const { conn, sends } = fakeConnection({
      height: () => 99,
      status: () => (++polls < 15 ? { slot: 5, confirmations: 0, err: null, confirmationStatus: "processed" } : { slot: 5, confirmations: 1, err: null, confirmationStatus: "confirmed" }),
    });
    const sent = await new Executor(conn, cfg, timing).send(signer, [memoIx("x")]);
    assert.deepEqual(sent.logs, ["Program log: ok"]);
    assert.ok(sends() > 1, "rebroadcast while unconfirmed");
  });
});
