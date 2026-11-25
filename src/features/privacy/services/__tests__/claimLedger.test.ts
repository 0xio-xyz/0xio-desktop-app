import { beforeEach, describe, expect, it, vi } from "vitest";

const node = vi.hoisted(() => ({
  call: vi.fn(),
  nonce: vi.fn(),
}));

vi.mock("src/services/network/networkService", () => ({
  jsonRpcCallOn: (net: string, method: string, params: unknown[], opts: unknown) =>
    node.call(net, method, params, opts),
  nonceState: (address: string, net: string) => node.nonce(address, net),
}));
vi.mock("src/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  ClaimRefusedError,
  STAGING_LIFETIME_MS,
  claimErrorCode,
  claimResend,
  claimResendFor,
  claimRows,
  claimSlot,
  outputRefusal,
  forgetSavedClaims,
  observeClaim,
  readOutputState,
  recordClaim,
  watchClaims,
} from "src/features/privacy/services/claimLedger";
import { RpcError } from "src/services/network/submitErrors";
import type { SignedTransaction } from "src/types/transaction";

const A = { networkId: "devnet", address: `oct${"A".repeat(44)}` };
const B = { networkId: "mainnet", address: A.address };
const tx = (nonce: number) => ({ from: A.address, nonce }) as unknown as SignedTransaction;
const T0 = 1_700_000_000_000;

beforeEach(() => {
  localStorage.clear();
  forgetSavedClaims();
  node.call.mockReset();
  node.nonce.mockReset();
});

function confirm(hash: string, at = T0) {
  observeClaim(A, hash, { status: "confirmed", missing: false }, "unknown", null, at);
}

describe("claim slot", () => {
  it("is fresh with no saved claim, previous while pending or confirmed", () => {
    expect(claimSlot(A, 7)).toEqual({ kind: "fresh" });
    recordClaim(A, 7, "h1", tx(3), T0);
    expect(claimSlot(A, 7)).toEqual({ kind: "previous", hash: "h1" });
    confirm("h1");
    expect(claimSlot(A, 7)).toEqual({ kind: "previous", hash: "h1" });
    expect(claimSlot(A, 8)).toEqual({ kind: "fresh" });
  });

  it("is scoped by network and address", () => {
    recordClaim(A, 7, "h1", tx(3), T0);
    expect(claimSlot(B, 7)).toEqual({ kind: "fresh" });
    expect(claimSlot({ ...A, address: `oct${"B".repeat(44)}` }, 7)).toEqual({ kind: "fresh" });
  });

  it("recovers a dropped or unknown claim only while its signed bytes are held", () => {
    const signed = tx(3);
    recordClaim(A, 7, "h1", signed, T0);
    observeClaim(A, "h1", { status: "dropped", missing: false }, "unknown", null, T0 + 1);
    expect(claimSlot(A, 7)).toEqual({ kind: "recovery", hash: "h1", tx: signed });
    forgetSavedClaims();
    expect(claimSlot(A, 7)).toEqual({ kind: "fresh" });
  });

  it("a rejected claim leaves the output free", () => {
    recordClaim(A, 7, "h1", tx(3), T0);
    observeClaim(A, "h1", { status: "rejected", missing: false }, "unknown", null, T0 + 1);
    expect(claimSlot(A, 7)).toEqual({ kind: "fresh" });
  });
});

describe("conflict then missing", () => {
  const gone = { missing: true };

  it("blocks a confirmed claim the node lost while the output reads unspent, then frees it after the staging lifetime", () => {
    recordClaim(A, 7, "h1", tx(3), T0);
    confirm("h1");
    observeClaim(A, "h1", gone, "unspent", null, T0 + 1000);
    expect(claimRows(A)[0].conflictAt).toBe(T0 + 1000);
    expect(claimSlot(A, 7)).toEqual({ kind: "blocked" });

    observeClaim(A, "h1", gone, "unspent", null, T0 + 1000 + STAGING_LIFETIME_MS);
    expect(claimRows(A)[0].conflictAt).toBe(T0 + 1000);
    expect(claimSlot(A, 7)).toEqual({ kind: "blocked" });

    observeClaim(A, "h1", gone, "unspent", null, T0 + 1001 + STAGING_LIFETIME_MS);
    expect(claimRows(A)[0].missing).toBe(true);
    expect(claimSlot(A, 7)).toEqual({ kind: "fresh" });
  });

  it("an unknown output changes nothing, a spent one settles, a found claim clears the conflict", () => {
    recordClaim(A, 7, "h1", tx(3), T0);
    confirm("h1");
    observeClaim(A, "h1", gone, "unknown", null, T0 + 1000);
    expect(claimRows(A)[0].conflictAt).toBeUndefined();
    observeClaim(A, "h1", gone, "unspent", null, T0 + 2000);
    observeClaim(A, "h1", gone, "spent", null, T0 + 3000);
    expect(claimRows(A)[0].conflictAt).toBeUndefined();
    observeClaim(A, "h1", gone, "unspent", null, T0 + 4000);
    confirm("h1", T0 + 5000);
    expect(claimRows(A)[0].conflictAt).toBeUndefined();
    expect(claimSlot(A, 7)).toEqual({ kind: "previous", hash: "h1" });
  });

  it("a pending claim the node cannot find turns unknown once its nonce is past or its staging note expired", () => {
    recordClaim(A, 7, "h1", tx(5), T0);
    observeClaim(A, "h1", gone, "unspent", { confirmed: 4, taken: 5 }, T0 + 1000);
    expect(claimRows(A)[0].status).toBe("pending");
    observeClaim(A, "h1", gone, "unspent", { confirmed: 4, taken: 4 }, T0 + 1000);
    expect(claimRows(A)[0].status).toBe("pending");
    observeClaim(
      A,
      "h1",
      gone,
      "unspent",
      { confirmed: 4, taken: 4 },
      T0 + STAGING_LIFETIME_MS + 1,
    );
    expect(claimRows(A)[0].status).toBe("unknown");

    recordClaim(A, 8, "h2", tx(6), T0);
    observeClaim(A, "h2", gone, "unspent", { confirmed: 6, taken: 6 }, T0 + 1);
    expect(claimRows(A).find((r) => r.hash === "h2")?.status).toBe("unknown");
  });
});

describe("output state read", () => {
  it("reads by id, and falls back to the one-shot list where the node has no by-id method", async () => {
    node.call.mockImplementation(async (net: string, method: string) => {
      if (method === "octra_stealthOutputsById") {
        if (net === "mainnet") throw new RpcError("Method not found", { code: -32601 });
        return { outputs: [{ id: 7, claimed: 0 }], complete: true };
      }
      if (method === "octra_stealthOutputs") return { outputs: [{ id: 7, claimed: 1 }] };
      throw new Error(method);
    });
    expect(await readOutputState(7, "devnet")).toBe("unspent");
    expect(await readOutputState(9, "devnet")).toBe("unknown");
    expect(await readOutputState(7, "mainnet", 120)).toBe("spent");
    expect(await readOutputState(9, "mainnet", 120)).toBe("unknown");
    expect(await readOutputState(7, "mainnet")).toBe("unknown");
    const byId = node.call.mock.calls.filter(
      ([n, m]) => n === "mainnet" && m === "octra_stealthOutputsById",
    );
    expect(byId).toHaveLength(1);
    expect(node.call.mock.calls[0][2]).toEqual([[7]]);
    expect(node.call.mock.calls[0][3]).toMatchObject({ timeoutMs: 5000 });
  });

  it("an RPC failure is unknown", async () => {
    node.call.mockRejectedValue(new Error("network unreachable"));
    expect(await readOutputState(7, "devnet")).toBe("unknown");
  });
});

describe("watching saved claims", () => {
  it("drives conflict to missing on an injected clock", async () => {
    let now = T0;
    recordClaim(A, 7, "h1", tx(3), T0);
    confirm("h1");
    node.call.mockImplementation(async (_net: string, method: string) => {
      if (method === "octra_transaction")
        throw new RpcError("transaction not found", { code: 112 });
      if (method === "octra_stealthOutputsById") return { outputs: [{ id: 7, claimed: 0 }] };
      throw new Error(method);
    });
    await watchClaims(A, new Map(), () => now);
    expect(claimSlot(A, 7)).toEqual({ kind: "blocked" });
    now += STAGING_LIFETIME_MS + 1;
    await watchClaims(A, new Map(), () => now);
    expect(claimSlot(A, 7)).toEqual({ kind: "fresh" });
    expect(node.call.mock.calls.every(([, , , o]) => (o as { lane: string }).lane === "poll")).toBe(
      true,
    );
  });

  it("leaves a row alone when the lookup itself fails", async () => {
    recordClaim(A, 7, "h1", tx(3), T0);
    node.call.mockRejectedValue(new Error("network unreachable"));
    await watchClaims(A, new Map(), () => T0 + STAGING_LIFETIME_MS * 2);
    expect(claimRows(A)[0].status).toBe("pending");
  });
});

describe("resend guard", () => {
  const saved = { from: A.address, nonce: 5, ou: "1000" } as unknown as SignedTransaction;

  it("resends only when the output is unspent, the nonce is next and the fee is the reviewed one", () => {
    expect(claimResend(saved, "unspent", 5, "1000")).toBe("resend");
  });

  it("builds fresh when the nonce moved, the fee changed or no fee was reviewed", () => {
    expect(claimResend(saved, "unspent", 6, "1000")).toBe("fresh");
    expect(claimResend(saved, "unspent", 4, "1000")).toBe("fresh");
    expect(claimResend(saved, "unspent", null, "1000")).toBe("fresh");
    expect(claimResend(saved, "unspent", 5, "2000")).toBe("fresh");
    expect(claimResend(saved, "unspent", 5)).toBe("fresh");
  });

  it("sends nothing when the output is spent or unreadable", () => {
    expect(claimResend(saved, "spent", 5, "1000")).toBe("spent");
    expect(claimResend(saved, "unknown", 5, "1000")).toBe("unreadable");
  });

  it("reads the output and the node nonce before a resend", async () => {
    let claimed: unknown = 0;
    node.call.mockImplementation(async () => ({ outputs: [{ id: 7, claimed }] }));
    node.nonce.mockResolvedValue({ confirmed: 4, taken: 4 });
    expect(await claimResendFor(A, { id: 7 }, saved, "1000")).toBe("resend");
    node.nonce.mockResolvedValue({ confirmed: 4, taken: 5 });
    expect(await claimResendFor(A, { id: 7 }, saved, "1000")).toBe("fresh");
    node.nonce.mockRejectedValue(new Error("network unreachable"));
    expect(await claimResendFor(A, { id: 7 }, saved, "1000")).toBe("fresh");
    claimed = 9;
    expect(await claimResendFor(A, { id: 7 }, saved, "1000")).toBe("spent");
    claimed = "x";
    expect(await claimResendFor(A, { id: 7 }, saved, "1000")).toBe("unreadable");
  });
});

describe("site claim codes", () => {
  it("splits spent from unreadable", () => {
    expect(outputRefusal("spent").code).toBe("CLAIM_OUTPUT_SPENT");
    expect(outputRefusal("unknown").code).toBe("CLAIM_OUTPUT_UNREADABLE");
  });

  it("maps faults after the retry window", () => {
    expect(claimErrorCode(new ClaimRefusedError("CLAIM_CONFLICT", "c"))).toBe("CLAIM_CONFLICT");
    expect(claimErrorCode(new RpcError("rpc capacity reached; nothing was sent"))).toBe(
      "RATE_LIMIT_EXCEEDED",
    );
    expect(claimErrorCode(new Error("wallet rpc slots busy"))).toBe("RATE_LIMIT_EXCEEDED");
    expect(claimErrorCode(new Error("network unreachable; nothing was sent"))).toBe(
      "NETWORK_ERROR",
    );
    expect(claimErrorCode(new Error("Network timed out: node did not respond"))).toBe(
      "NETWORK_ERROR",
    );
    expect(claimErrorCode(new Error("Transaction rejected"))).toBeNull();
  });

  it("an unclear claim stays the earlier claim until the staging rule releases it", () => {
    recordClaim(A, 7, "h1", tx(5), T0);
    observeClaim(A, "h1", { missing: true }, "unspent", { confirmed: 4, taken: 4 }, T0 + 1000);
    expect(claimSlot(A, 7)).toEqual({ kind: "previous", hash: "h1" });
    observeClaim(
      A,
      "h1",
      { missing: true },
      "unspent",
      { confirmed: 4, taken: 4 },
      T0 + STAGING_LIFETIME_MS + 1,
    );
    expect(claimSlot(A, 7)).toMatchObject({ kind: "recovery", hash: "h1" });
  });
});
