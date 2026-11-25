import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("src/services/network/networkService", async (orig) => ({
  ...(await orig<typeof import("src/services/network/networkService")>()),
  jsonRpcCallOn: (...a: unknown[]) => m.rpc(...a),
}));

import {
  checkProofPolicy,
  policyFromRuntime,
  policyFromStatus,
  proofPolicyFor,
  resolveProofPolicy,
  ProofPolicyError,
} from "src/features/privacy/services/proofPolicy";
import { cipherProofRoute } from "src/features/privacy/services/pvacUpgradePolicy";
import { PROOF_POLICY_CHANGED, PROOF_POLICY_UNAVAILABLE } from "src/services/transactions/feeCopy";

const ADDR = `oct${"A".repeat(44)}`;
const DEVNET = {
  schema: "octra-runtime-release-v1",
  chain_id: "octra-devnet-9871-cluster",
  consensus_rules_id: "finalized_rejection_commitment",
  consensus_profile: 16,
  runtime_profile_hash: "86a3e354b18cad2cd2ec35c63a61924aa78363fef2e93e1b5f5b37badd7d0c0c",
};

async function refusal(p: Promise<unknown>): Promise<ProofPolicyError> {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(ProofPolicyError);
  return e as ProofPolicyError;
}

const noRuntime = () => Promise.reject(new Error("runtime must not be read"));

describe("proof_math and proof_key", () => {
  it("wide sets bit 0 and prior clears it", () => {
    expect(policyFromStatus({ proof_math: "wide" })).toBe(1);
    expect(policyFromStatus({ proof_math: "prior" })).toBe(0);
  });

  it.each([["narrow"], [""], [null], [1], [true]])("refuses proof_math %j", (math) => {
    expect(() => policyFromStatus({ proof_math: math })).toThrow(PROOF_POLICY_UNAVAILABLE);
  });

  it("proof_key true sets bit 1 and false or absent leaves it clear", () => {
    expect(policyFromStatus({ proof_math: "wide", proof_key: true })).toBe(3);
    expect(policyFromStatus({ proof_math: "prior", proof_key: true })).toBe(2);
    expect(policyFromStatus({ proof_math: "wide", proof_key: false })).toBe(1);
  });

  it.each([["true"], [1], [null], [{}]])("refuses a non boolean proof_key %j", (key) => {
    let error: unknown;
    try {
      policyFromStatus({ proof_math: "wide", proof_key: key });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ProofPolicyError);
    expect((error as ProofPolicyError).detail).toBe("network proof key policy is unavailable");
  });
});

describe("resolveProofPolicy", () => {
  it("reads the policy from a status for the queried address", async () => {
    await expect(
      resolveProofPolicy(ADDR, { address: ADDR, proof_math: "wide", proof_key: true }, noRuntime),
    ).resolves.toBe(3);
  });

  it.each([
    [{ address: `oct${"B".repeat(44)}`, proof_math: "wide" }],
    [{ proof_math: "wide" }],
    [null],
    [[]],
    ["wide"],
  ])("refuses a status for another address or of another shape %#", async (status) => {
    const e = await refusal(resolveProofPolicy(ADDR, status, noRuntime));
    expect(e.message).toBe(PROOF_POLICY_UNAVAILABLE);
  });

  it("without proof_math takes policy 1 only from the listed devnet runtimes", async () => {
    const status = { address: ADDR };
    await expect(resolveProofPolicy(ADDR, status, async () => DEVNET)).resolves.toBe(1);
    const other = {
      ...DEVNET,
      runtime_profile_hash: "1d46b19e336be6978b7a27b3fc04eda930cd58114858fd8a822c29c2e96ff13a",
    };
    await expect(resolveProofPolicy(ADDR, status, async () => other)).resolves.toBe(1);
  });

  it.each([
    [{ ...DEVNET, runtime_profile_hash: "00" }],
    [{ ...DEVNET, chain_id: "octra-mainnet" }],
    [{ ...DEVNET, schema: "octra-runtime-release-v2" }],
    [{ ...DEVNET, consensus_rules_id: "other" }],
    [{ ...DEVNET, consensus_profile: "16" }],
    [{ ...DEVNET, consensus_profile: 15 }],
    [null],
  ])("without proof_math refuses any other runtime %#", async (runtime) => {
    await refusal(resolveProofPolicy(ADDR, { address: ADDR }, async () => runtime));
    expect(() => policyFromRuntime(runtime)).toThrow(PROOF_POLICY_UNAVAILABLE);
  });

  it("refuses when the runtime cannot be read", async () => {
    await refusal(resolveProofPolicy(ADDR, { address: ADDR }, noRuntime));
  });
});

describe("reading and checking against the node", () => {
  beforeEach(() => {
    m.rpc.mockReset();
  });

  const answer = (...statuses: Record<string, unknown>[]) => {
    let i = 0;
    m.rpc.mockImplementation(async (_net: string, method: string, params: unknown[]) => {
      if (method !== "octra_pvacMigrationStatus") throw new Error(`unexpected ${method}`);
      return { address: params[0], ...statuses[Math.min(i++, statuses.length - 1)] };
    });
  };

  it("reuses a recent read per network and address", async () => {
    const addr = `oct${"C".repeat(44)}`;
    answer({ proof_math: "wide" });
    await expect(proofPolicyFor(addr, "devnet")).resolves.toBe(1);
    await expect(proofPolicyFor(addr, "devnet")).resolves.toBe(1);
    expect(m.rpc).toHaveBeenCalledTimes(1);
    await proofPolicyFor(addr, "mainnet");
    expect(m.rpc).toHaveBeenCalledTimes(2);
    expect(m.rpc.mock.calls[1].slice(0, 3)).toEqual([
      "mainnet",
      "octra_pvacMigrationStatus",
      [addr],
    ]);
  });

  it("refuses when the node does not answer the status", async () => {
    m.rpc.mockRejectedValue(new Error("Method not found"));
    const e = await refusal(proofPolicyFor(`oct${"D".repeat(44)}`, "mainnet"));
    expect(e.message).toBe(PROOF_POLICY_UNAVAILABLE);
  });

  it("the check before submit reads again and passes an unchanged policy", async () => {
    const addr = `oct${"E".repeat(44)}`;
    answer({ proof_math: "wide", proof_key: true });
    const policy = await proofPolicyFor(addr, "devnet");
    await expect(checkProofPolicy(addr, "devnet", policy)).resolves.toBeUndefined();
    expect(m.rpc).toHaveBeenCalledTimes(2);
  });

  it("the check refuses when the policy changed since the op was built", async () => {
    const addr = `oct${"F".repeat(44)}`;
    answer({ proof_math: "wide" }, { proof_math: "wide", proof_key: true });
    const policy = await proofPolicyFor(addr, "devnet");
    const e = await refusal(checkProofPolicy(addr, "devnet", policy));
    expect(e.message).toBe(PROOF_POLICY_CHANGED);
  });

  it("the check refuses when the policy can no longer be read", async () => {
    const addr = `oct${"G".repeat(44)}`;
    answer({ proof_math: "wide" }, { proof_math: "broken" });
    const policy = await proofPolicyFor(addr, "devnet");
    const e = await refusal(checkProofPolicy(addr, "devnet", policy));
    expect(e.message).toBe(PROOF_POLICY_UNAVAILABLE);
  });
});

describe("cipherProofRoute", () => {
  const route = {
    cipher_proof_rule: "active",
    can_cipher_proof_migrate: true,
    cipher_format: "proven",
    key_class: "historical",
  };

  it("takes a proven cipher, or a v3 class when the format is absent", () => {
    expect(cipherProofRoute(route)).toBe(true);
    const { cipher_format: _, ...noFormat } = route;
    expect(cipherProofRoute({ ...noFormat, cipher_class: "v3" })).toBe(true);
  });

  it.each([
    [{ cipher_proof_rule: "pending" }],
    [{ can_cipher_proof_migrate: "true" }],
    [{ cipher_format: "legacy" }],
    [{ cipher_format: null, cipher_class: "v3" }],
    [{ key_class: "current" }],
  ])("refuses any other status %#", (change) => {
    expect(cipherProofRoute({ ...route, ...change })).toBe(false);
    expect(cipherProofRoute(null)).toBe(false);
  });
});
