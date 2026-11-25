import { describe, it, expect } from "vitest";
import { findKeySwitchCandidates } from "src/features/privacy/services/keySwitchService";
import type { Transaction } from "src/types/transaction";

const ADDR = "octE9a1T8eid5RgixPjetcB1yaVvxTsy9ZCDXHuXE9dFu8r";
const OTHER = "oct4Ay2HKoKbVSndUVdDaf1gxtYhdXeRVpkHvv43rhRoxio";
const NOW = 1_800_000_000_000;

function tx(over: Partial<Transaction>): Transaction {
  return {
    hash: "h",
    type: "send",
    amount: 0,
    fee: 0,
    from: ADDR,
    to: ADDR,
    timestamp: NOW,
    status: "confirmed",
    ...over,
  } as Transaction;
}

describe("findKeySwitchCandidates", () => {
  it("returns nothing for empty history", () => {
    expect(findKeySwitchCandidates([], ADDR)).toEqual([]);
  });

  it("keeps only key_switch txs sent by this address", () => {
    const txs = [
      tx({ hash: "mine", op_type: "key_switch" }),
      tx({ hash: "standard", op_type: "standard" }),
      tx({ hash: "encrypt", op_type: "encrypt" }),
      tx({ hash: "theirs", op_type: "key_switch", from: OTHER }),
    ];
    expect(findKeySwitchCandidates(txs, ADDR).map((t) => t.hash)).toEqual(["mine"]);
  });

  it("orders newest first", () => {
    const txs = [
      tx({ hash: "mid", op_type: "key_switch", timestamp: NOW - 5_000 }),
      tx({ hash: "oldest", op_type: "key_switch", timestamp: NOW - 9_000 }),
      tx({ hash: "newest", op_type: "key_switch", timestamp: NOW - 1_000 }),
    ];
    expect(findKeySwitchCandidates(txs, ADDR).map((t) => t.hash)).toEqual([
      "newest",
      "mid",
      "oldest",
    ]);
  });

  it("ignores a tx with no op_type", () => {
    expect(findKeySwitchCandidates([tx({ hash: "bare" })], ADDR)).toEqual([]);
  });

  it("does not rely on message, which the list endpoint omits", () => {
    const txs = [tx({ hash: "nomsg", op_type: "key_switch", message: undefined })];
    expect(findKeySwitchCandidates(txs, ADDR).map((t) => t.hash)).toEqual(["nomsg"]);
  });
});
