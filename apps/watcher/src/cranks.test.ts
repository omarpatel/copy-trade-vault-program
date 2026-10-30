import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { burnPlatformBudget, Cranks } from "./cranks";
import { SendError, SimulationError, type Executor } from "./executor";
import type { Keeper } from "./keeper";
import type { RawRpc } from "./rpc";

/**
 * A copier with one position whose max-hold exit keeps failing: the exit crank must back off per position instead
 * of re-sending every round.
 */
function setup() {
  const mint = Keypair.generate().publicKey;
  const target = Keypair.generate().publicKey;
  const tokenMint = Keypair.generate().publicKey;
  const position = { mint, tokenMint, target, tokens: 1_000n, cost: 10n, targetSnapshot: 5n, targetPeak: 5n, vaultPeak: 1_000n, openedAt: 0n, lastTradeTs: 0n, bump: 255 };
  const copier = {
    mint,
    kind: "single" as const,
    targets: [target],
    buybackPool: 0n,
    platformPending: 0n,
    lastBuybackTs: 0n,
    accountedLamports: 0n,
    openCost: 10n,
  };
  const config = { platformMint: PublicKey.default, keeper: PublicKey.default, params: { minTradeLamports: 10_000_000n, maxImpactBps: 300, slippageBps: 500 }, descriptors: [] };
  const sellIx = new TransactionInstruction({ programId: PublicKey.default, keys: [], data: Buffer.alloc(0) });
  const keeper = {
    mode: "live",
    keeper: Keypair.generate(),
    cfg: { distributeMinLamports: 1_000_000n, buybackMinLamports: 50_000_000n, commitment: "confirmed" },
    registry: { config, copiers: new Map([[mint.toBase58(), { account: copier, positions: new Map([[tokenMint.toBase58(), position]]) }]]), followers: new Map() },
    withCopier: <T>(_: string, fn: () => Promise<T>) => fn(),
    readCopier: async () => ({ copier, vaultLamports: 1_000_000_000n, vaultWsol: 0n, position, freeSol: 0n, equity: 0n }),
    venue: async (m: PublicKey) => (m.equals(tokenMint) ? { kind: "curve", accounts: {}, reserves: {}, feeBps: {} } : { kind: "unsupported", code: "no_venue" }),
    prepareSell: async () => ({ action: "sell", tokensIn: 1_000n, forced: true, ixs: [sellIx] }),
    rent: async () => 890_880n,
  };
  const sends: TransactionInstruction[][] = [];
  const executor = {
    simulate: async () => {
      throw new SimulationError("no fees to distribute", []);
    },
    send: async (_: Keypair, ixs: TransactionInstruction[]) => {
      sends.push(ixs);
      throw new SendError("landed but failed: Slippage", "sig");
    },
  };
  // The fakes implement only what a crank round touches.
  const cranks = new Cranks(keeper as unknown as Keeper, executor as unknown as Executor, {} as RawRpc, 60_000);
  return { cranks, sends, sellIx };
}

describe("Cranks exit back-off", () => {
  it("a failed exit is not re-sent on the next round", async () => {
    const { cranks, sends, sellIx } = setup();
    await cranks.round();
    assert.equal(sends.length, 1);
    assert.equal(sends[0]![0], sellIx);
    const failed = cranks.attempts.find((a) => a.kind === "exit");
    assert.ok(failed?.error);

    await cranks.round();
    assert.equal(sends.length, 1, "the exit is backing off");
  });
});

describe("Cranks heartbeat", () => {
  it("sends keeper_heartbeat only when no keeper-signed instruction landed within the interval", async () => {
    const keeperKey = Keypair.generate();
    const keeper = { mode: "live", keeper: keeperKey, lastKeeperIxAt: Date.now() };
    const sent: TransactionInstruction[][] = [];
    const executor = {
      send: async (_: Keypair, ixs: TransactionInstruction[]) => {
        sent.push(ixs);
        return { signature: "hb", logs: [] };
      },
    };
    // The fakes implement only what a heartbeat touches.
    const cranks = new Cranks(keeper as unknown as Keeper, executor as unknown as Executor, {} as RawRpc, 60_000);

    await cranks.heartbeat();
    assert.equal(sent.length, 0, "a trade just refreshed the on-chain heartbeat");

    keeper.lastKeeperIxAt = Date.now() - 61_000;
    await cranks.heartbeat();
    assert.equal(sent.length, 1);
    const ix = sent[0]![0]!;
    assert.ok(ix.keys[0]!.pubkey.equals(keeperKey.publicKey) && ix.keys[0]!.isSigner, "keeper signs");
    assert.equal(cranks.heartbeatStatus.signature, "hb");
    assert.ok(Date.now() - keeper.lastKeeperIxAt < 1_000, "the heartbeat itself resets the interval");

    keeper.mode = "paused";
    keeper.lastKeeperIxAt = 0;
    await cranks.heartbeat();
    assert.equal(sent.length, 1, "a paused keeper sends nothing");
  });
});

describe("burn_platform budget", () => {
  it("keeps one-time venue rent out of the spend on the curve too (localnet: 3.03M lamports short at full spend)", () => {
    const pool = 91_245_251n;
    const rent = 890_880n;
    const budget = burnPlatformBudget(pool, rent);
    assert.ok(pool - rent - budget >= 3_030_000n, "leaves the measured curve shortfall in the pool");
    assert.ok(budget >= 50_000_000n, "still above the burn threshold");
  });
  it("never goes negative on a nearly empty pool", () => {
    assert.equal(burnPlatformBudget(5_000_000n, 890_880n), 0n);
  });
});
