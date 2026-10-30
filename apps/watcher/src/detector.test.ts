import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Keypair } from "@solana/web3.js";
import { loadConfig } from "./config";
import { Detector, type DetectorOptions, type TxHandler } from "./detector";
import { RpcError, type RawTx, type SignatureInfo } from "./rpc";
import { State } from "./state";

/** In-memory `getSignaturesForAddress` / `getTransaction` with the RPC's paging semantics (newest first). */
class FakeRpc {
  private readonly lists = new Map<string, SignatureInfo[]>();
  private slot = 1;
  readonly delays = new Map<string, number>();
  readonly down = new Set<string>();

  /** Appends new successful signatures to `address` (oldest of the batch first); returns them oldest first. */
  add(address: string, names: string[]): string[] {
    const list = this.lists.get(address) ?? [];
    for (const name of names) list.unshift({ signature: name, slot: this.slot++, err: null, blockTime: Math.floor(Date.now() / 1000) });
    this.lists.set(address, list);
    return names;
  }

  async getSignaturesForAddress(address: string, opts: { limit?: number; until?: string; before?: string } = {}): Promise<SignatureInfo[]> {
    const list = this.lists.get(address) ?? [];
    const start = opts.before ? list.findIndex((s) => s.signature === opts.before) + 1 : 0;
    let end = list.length;
    if (opts.until) {
      end = list.findIndex((s) => s.signature === opts.until);
      if (end < 0) throw new RpcError("getSignaturesForAddress", -32020, `Transaction ${opts.until} not found`);
    }
    return list.slice(start, Math.min(end, start + (opts.limit ?? 1_000)));
  }

  async getTransaction(signature: string): Promise<RawTx | null> {
    if (this.down.has(signature)) throw new RpcError("getTransaction", 503, "HTTP 503");
    await sleep(this.delays.get(signature) ?? 0);
    return {
      slot: 1,
      blockTime: null,
      transaction: { signatures: [signature], message: { accountKeys: [], header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 0 }, instructions: [] } },
      meta: { err: null, fee: 5_000, preBalances: [], postBalances: [] },
    };
  }
}

/** Token account data whose `amount` (u64 at offset 64) is `amount`. */
function tokenAccount(amount: bigint): Buffer {
  const data = Buffer.alloc(165);
  data.writeBigUInt64LE(amount, 64);
  return data;
}

const cfg = { ...loadConfig({ RPC_URL: "http://127.0.0.1:8899", KEEPER_KEYPAIR: "unused.json", INDEXER_URL: "http://127.0.0.1:1" }), fetchConcurrency: 4 };
const WALLET = Keypair.generate().publicKey.toBase58();
const OTHER = Keypair.generate().publicKey.toBase58();
const ATA = Keypair.generate().publicKey.toBase58();

const running: Detector[] = [];
function detector(rpc: FakeRpc, state: State, onTx: TxHandler, opts: Partial<DetectorOptions> = {}, accounts = new Map<string, bigint>()): Detector {
  const connection = {
    getMultipleAccountsInfo: async (keys: { toBase58(): string }[]) =>
      keys.map((k) => {
        const amount = accounts.get(k.toBase58());
        return amount === undefined ? null : { data: tokenAccount(amount), lamports: 2_039_280, owner: Keypair.generate().publicKey, executable: false, rentEpoch: 0 };
      }),
  };
  // The fake implements only what the detector calls on the connection.
  const d = new Detector(cfg, connection as never, rpc, state, onTx, { websocket: false, ...opts });
  running.push(d);
  return d;
}

const recorder = () => {
  const handled: string[] = [];
  const onTx: TxHandler = async (tx) => {
    handled.push(tx.transaction.signatures[0]!);
  };
  return { handled, onTx };
};

afterEach(() => {
  for (const d of running.splice(0)) d.stop();
});

describe("Detector durability and order", () => {
  it("a crash mid-batch loses nothing: the cursor only passes handled signatures", async () => {
    const rpc = new FakeRpc();
    const state = new State(":memory:");
    rpc.add(WALLET, ["s0"]);
    const first = recorder();
    const reachedS3 = Promise.withResolvers<void>();
    const d1 = detector(rpc, state, async (tx, source, at) => {
      const sig = tx.transaction.signatures[0]!;
      if (sig === "s3") {
        reachedS3.resolve();
        await Promise.withResolvers<never>().promise; // the process dies while deciding s3
      }
      await first.onTx(tx, source, at);
    });
    d1.setTargets([WALLET]);
    await d1.poll();
    assert.equal(state.cursor(`wallet:${WALLET}`)?.signature, "s0", "first sight primes at the newest signature");

    rpc.add(WALLET, ["s1", "s2", "s3", "s4", "s5"]);
    void d1.poll();
    await reachedS3.promise;
    assert.deepEqual(first.handled, ["s1", "s2"]);
    assert.equal(state.cursor(`wallet:${WALLET}`)?.signature, "s2", "cursor must not pass s3 before it is handled");
    d1.stop();

    const second = recorder();
    const d2 = detector(rpc, state, second.onTx);
    d2.setTargets([WALLET]);
    await d2.poll();
    assert.deepEqual(second.handled, ["s3", "s4", "s5"]);
    assert.equal(state.cursor(`wallet:${WALLET}`)?.signature, "s5");
  });

  it("a gap longer than one drain is walked across polls and never skipped", async () => {
    const rpc = new FakeRpc();
    const state = new State(":memory:");
    rpc.add(WALLET, ["s0"]);
    const r = recorder();
    const d = detector(rpc, state, r.onTx, { pageSize: 2, maxPagesPerDrain: 2 });
    d.setTargets([WALLET]);
    await d.poll();
    const gap = rpc.add(WALLET, ["s1", "s2", "s3", "s4", "s5", "s6", "s7"]);

    await d.poll();
    assert.deepEqual(r.handled, [], "4 of 7 collected: nothing handled until the walk reaches the cursor");
    assert.equal(state.cursor(`wallet:${WALLET}`)?.signature, "s0");
    assert.equal(d.stats().walking, 1);

    await d.poll();
    assert.deepEqual(r.handled, gap);
    assert.equal(state.cursor(`wallet:${WALLET}`)?.signature, "s7");
    assert.equal(d.stats().walking, 0);
  });

  it("one wallet's signatures are handled in order even when the older fetch is slower; other wallets run in parallel", async () => {
    const rpc = new FakeRpc();
    const state = new State(":memory:");
    rpc.add(WALLET, ["w0"]);
    rpc.add(OTHER, ["o0"]);
    const r = recorder();
    const d = detector(rpc, state, r.onTx);
    d.setTargets([WALLET, OTHER]);
    await d.poll();

    rpc.add(WALLET, ["buy", "sell"]);
    rpc.add(OTHER, ["other"]);
    rpc.delays.set("buy", 150);
    await d.poll();
    assert.deepEqual(r.handled, ["other", "buy", "sell"]);
  });

  it("an RPC outage stops the drain before the failed signature and resumes there", async () => {
    const rpc = new FakeRpc();
    const state = new State(":memory:");
    rpc.add(WALLET, ["s0"]);
    const r = recorder();
    const d = detector(rpc, state, r.onTx);
    d.setTargets([WALLET]);
    await d.poll();
    rpc.add(WALLET, ["s1", "s2", "s3"]);
    rpc.down.add("s2");

    await d.poll();
    assert.deepEqual(r.handled, ["s1"]);
    assert.equal(state.cursor(`wallet:${WALLET}`)?.signature, "s1");
    assert.equal(state.hasSeen("s2"), false);

    rpc.down.clear();
    await d.poll();
    assert.deepEqual(r.handled, ["s1", "s2", "s3"]);
  });

  it("token-account confirmation pages back to its cursor instead of jumping past a 10-signature window", async () => {
    const rpc = new FakeRpc();
    const state = new State(":memory:");
    const accounts = new Map([[ATA, 100n]]);
    rpc.add(ATA, ["a0"]);
    const r = recorder();
    const d = detector(rpc, state, r.onTx, { pageSize: 2, maxPagesPerDrain: 10 }, accounts);
    d.setTargets([WALLET]);
    d.setTracked([{ target: WALLET, tokenAccount: ATA }]);
    await d.poll(); // balance baseline
    state.setCursor(`ata:${ATA}`, "a0", 1);

    const batch = rpc.add(ATA, Array.from({ length: 13 }, (_, i) => `a${i + 1}`));
    accounts.set(ATA, 50n);
    await d.poll();
    assert.deepEqual(r.handled, batch);
    assert.equal(state.cursor(`ata:${ATA}`)?.signature, "a13");
  });
});
