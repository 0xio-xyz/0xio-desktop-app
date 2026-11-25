import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ADDR = `oct${"A".repeat(44)}`;
const SCOPE = { networkId: "devnet", address: ADDR };

const m = vi.hoisted(() => ({
  strictFee: vi.fn(),
  build: vi.fn(),
  broadcast: vi.fn(),
  txDetails: vi.fn(),
  cipher: vi.fn(),
  status: vi.fn(),
  rpc: vi.fn(),
  owner: vi.fn(),
}));
vi.mock("src/services/pvac/pvacBridge", () => ({
  pvacBridge: {
    requireContext: () => "ctx1",
    serializePubkey: async () => ({ pubkey: "AAAA" }),
    aesKat: async () => "kat",
    makeKeyOwnerProof: (...a: unknown[]) => m.owner(...a),
  },
}));
vi.mock("src/services/network/networkService", async (orig) => ({
  ...(await orig<typeof import("src/services/network/networkService")>()),
  assertScope: () => {},
  getRecommendedFeeStrict: (...a: unknown[]) => m.strictFee(...a),
  getPvacMigrationStatus: (...a: unknown[]) => m.status(...a),
  getEncryptedBalance: (...a: unknown[]) => m.cipher(...a),
  getTransactionDetails: (...a: unknown[]) => m.txDetails(...a),
  jsonRpcCallOn: (...a: unknown[]) => m.rpc(...a),
}));
vi.mock("src/services/network/transactionBuilder", () => ({
  buildHfheTx: (...a: unknown[]) => m.build(...a),
  broadcastSignedTx: (...a: unknown[]) => m.broadcast(...a),
}));
vi.mock("src/features/privacy/services/keySwitchService", () => ({
  recordPendingKeySwitch: vi.fn(),
  getPendingKeySwitch: () => null,
  clearPendingKeySwitch: vi.fn(),
}));

import {
  keySwitchBalance,
  migrateKeyBound,
  submitKeyBoundMigration,
} from "src/features/privacy/services/privacyService";
import { FEE_UNAVAILABLE, PROOF_POLICY_CHANGED } from "src/services/transactions/feeCopy";

function policyStatus(...answers: Record<string, unknown>[]) {
  let i = 0;
  m.rpc.mockImplementation(async (_net: string, method: string, params: unknown[]) => {
    if (method !== "octra_pvacMigrationStatus") throw new Error(`unexpected ${method}`);
    const answer = answers[Math.min(i++, answers.length - 1)];
    return { address: params[0], ...answer };
  });
}

beforeEach(() => {
  m.strictFee.mockReset().mockResolvedValue({ fee: "9900000" });
  m.build.mockReset().mockResolvedValue({ signed: true });
  m.broadcast.mockReset().mockResolvedValue("hash1");
  m.txDetails.mockReset().mockResolvedValue({ status: "confirmed" });
  m.cipher.mockReset().mockResolvedValue(null);
  m.status.mockReset().mockResolvedValue({ cipher_class: "empty" });
  m.rpc.mockReset();
  policyStatus({ proof_math: "wide" });
  m.owner.mockReset().mockResolvedValue({ owner_cipher: "hfhe_v1|oc", owner_proof: "zkzp_v2|op" });
});

async function settle<T>(p: Promise<T>): Promise<T> {
  let done = false;
  void p.finally(() => (done = true)).catch(() => {});
  for (let i = 0; i < 5_000 && !done; i++) {
    await new Promise((r) => setImmediate(r));
    await vi.advanceTimersByTimeAsync(1_000);
  }
  return p;
}
afterEach(() => vi.useRealTimers());

describe("key_switch signers pay only the reviewed fee", () => {
  it("migrateKeyBound signs the fee the Migrate review showed, never a live re-quote", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const done = migrateKeyBound(SCOPE, "w1", {
      ou: "1200000",
      expect: { mode: "empty_key_switch", amountMicro: 0 },
    });
    await expect(settle(done)).resolves.toEqual({ txHash: "hash1", status: "confirmed" });
    expect(m.build).toHaveBeenCalledTimes(1);
    expect(m.build.mock.calls[0][0]).toMatchObject({ opType: "key_switch", ou: "1200000" });
    expect(m.strictFee).not.toHaveBeenCalled();
  });

  it("migrateKeyBound refuses before signing when the node resolves another mode", async () => {
    m.cipher.mockResolvedValue("hfhe_v1|abc");
    m.status.mockResolvedValue({ cipher_class: "v3", key_class: "current", can_v3_migrate: false });
    await expect(
      migrateKeyBound(SCOPE, "w1", {
        ou: "1200000",
        expect: { mode: "empty_key_switch", amountMicro: 0 },
      }),
    ).rejects.toThrow("Review again");
    expect(m.build).not.toHaveBeenCalled();
  });

  it("keySwitchBalance signs the reviewed fee", async () => {
    await keySwitchBalance(SCOPE, "w1", { ou: "1300000" });
    expect(m.build.mock.calls[0][0]).toMatchObject({ ou: "1300000" });
    expect(m.strictFee).not.toHaveBeenCalled();
  });

  it("keySwitchBalance refuses to sign without a reviewed fee", async () => {
    await expect(keySwitchBalance(SCOPE, "w1", { ou: "" })).rejects.toThrow(FEE_UNAVAILABLE);
    expect(m.build).not.toHaveBeenCalled();
    expect(m.strictFee).not.toHaveBeenCalled();
  });

  it("submitKeyBoundMigration signs the reviewed fee and nothing without one", async () => {
    await submitKeyBoundMigration(SCOPE, "w1", { new_cipher: "c" }, { ou: "1400000", policy: 1 });
    expect(m.build.mock.calls[0][0]).toMatchObject({ opType: "key_switch", ou: "1400000" });
    await expect(submitKeyBoundMigration(SCOPE, "w1", {}, { ou: "", policy: 1 })).rejects.toThrow(
      FEE_UNAVAILABLE,
    );
    expect(m.build).toHaveBeenCalledTimes(1);
    expect(m.strictFee).not.toHaveBeenCalled();
  });
});

describe("key_switch follows the network proof policy", () => {
  const scopeFor = (c: string) => ({ networkId: "devnet", address: `oct${c.repeat(44)}` });
  const sentData = () => JSON.parse(m.build.mock.calls[0][0].encryptedData);

  it("adds the key owner proof when the policy binds proofs to the key", async () => {
    const scope = scopeFor("B");
    policyStatus({ proof_math: "wide", proof_key: true });
    await keySwitchBalance(scope, "w1", { ou: "1300000" });
    expect(m.owner).toHaveBeenCalledWith(scope.address, 3);
    expect(sentData()).toMatchObject({ owner_cipher: "hfhe_v1|oc", owner_proof: "zkzp_v2|op" });
    expect(m.broadcast).toHaveBeenCalledTimes(1);
  });

  it("sends no owner fields when the policy leaves the key unbound", async () => {
    await keySwitchBalance(scopeFor("C"), "w1", { ou: "1300000" });
    expect(m.owner).not.toHaveBeenCalled();
    expect(sentData()).not.toHaveProperty("owner_proof");
  });

  it("sends nothing when the policy changes between building and submit", async () => {
    policyStatus({ proof_math: "wide" }, { proof_math: "prior" });
    await expect(keySwitchBalance(scopeFor("D"), "w1", { ou: "1300000" })).rejects.toThrow(
      PROOF_POLICY_CHANGED,
    );
    expect(m.broadcast).not.toHaveBeenCalled();
  });

  it("submitKeyBoundMigration refuses a payload built under another policy", async () => {
    policyStatus({ proof_math: "prior" });
    await expect(
      submitKeyBoundMigration(scopeFor("E"), "w1", { new_cipher: "c" }, { ou: "1", policy: 1 }),
    ).rejects.toThrow(PROOF_POLICY_CHANGED);
    expect(m.broadcast).not.toHaveBeenCalled();
  });
});
