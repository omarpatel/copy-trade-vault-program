import assert from "node:assert/strict";
import { test } from "node:test";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { loadConfig } from "./config";

const BASE = { RPC_URL: "https://rpc.example.com", INDEXER_URL: "http://indexer.internal:8790" };
const kp = Keypair.generate();
const json = JSON.stringify([...kp.secretKey]);
const base58 = bs58.encode(kp.secretKey);

function keyOf(env: Record<string, string>) {
  const { key } = loadConfig({ ...BASE, ...env });
  assert.equal(key.kind, "env");
  return key.kind === "env" ? key.keypair : null;
}

test("KEEPER_SECRET_KEY accepts a JSON byte array and base58 (whitespace tolerated)", () => {
  assert.equal(keyOf({ KEEPER_SECRET_KEY: json })?.publicKey.toBase58(), kp.publicKey.toBase58());
  assert.equal(keyOf({ KEEPER_SECRET_KEY: `\n ${base58} \n` })?.publicKey.toBase58(), kp.publicKey.toBase58());
});

test("KEEPER_SECRET_KEY rejects garbage without echoing it", () => {
  const tampered = Uint8Array.from(kp.secretKey);
  tampered[40] ^= 0xff; // public half no longer matches the seed
  const cases: [string, RegExp][] = [
    ["[1,2,3", /not valid JSON/],
    [JSON.stringify([...kp.secretKey.slice(0, 32)]), /JSON array of 64 bytes/],
    [JSON.stringify([...kp.secretKey.slice(0, 63), 256]), /JSON array of 64 bytes/],
    ["not-base58-0OIl", /base58/],
    [bs58.encode(kp.secretKey.slice(0, 32)), /64 bytes \(base58\), got 32/],
    [bs58.encode(tampered), /not a valid ed25519 secret key/],
  ];
  for (const [secret, message] of cases) {
    assert.throws(
      () => loadConfig({ ...BASE, KEEPER_SECRET_KEY: secret }),
      (err: Error) => message.test(err.message) && !err.message.includes(secret),
      secret,
    );
  }
});

test("off localnet a key source is required, and only one", () => {
  assert.throws(() => loadConfig(BASE), /KEEPER_SECRET_KEY .* or KEEPER_KEYPAIR/);
  assert.throws(() => loadConfig({ ...BASE, KEEPER_SECRET_KEY: json, KEEPER_KEYPAIR: "keeper.json" }), /only one of/);
  assert.equal(loadConfig({ ...BASE, KEEPER_KEYPAIR: "keeper.json" }).key.kind, "file");
});
