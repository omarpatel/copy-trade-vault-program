import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { cursorMissAction } from "./sync";

describe("cursor unknown to the node", () => {
  test("pruned below the node's history: rescan, never wipe", () => {
    assert.equal(cursorMissAction(90, 100, false), "rescan");
    assert.equal(cursorMissAction(90, 100, true), "rescan");
  });

  test("inside retained history on a real cluster: rescan and alert, never wipe (keeper reports live only in the DB)", () => {
    assert.equal(cursorMissAction(453_000_000, 400_000_000, false), "rescan-alert");
  });

  test("inside retained history on localnet: the ledger was rewound or reset, rebuild the index", () => {
    assert.equal(cursorMissAction(100_483, 96_072, true), "reset");
  });
});
