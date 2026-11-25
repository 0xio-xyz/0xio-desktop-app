import { describe, expect, it } from "vitest";
import { QueryClient, dehydrate } from "src/lib/query";
import { PERSIST_BUSTER, retryQuery, shouldPersistQuery } from "src/lib/query/queryDefaults";
import { RpcError } from "src/services/network/submitErrors";

describe("persisted query cache", () => {
  it("leaves the private balance and claim secrets out of the saved blob", () => {
    const qc = new QueryClient();
    qc.setQueryData(["balance", "octA", "devnet"], { balance: 5, nonce: 1 });
    qc.setQueryData(["privateBalance", "octA", "devnet"], 777_000_123);
    qc.setQueryData(["claimOutputs", "w1", "devnet"], [{ id: 1, claimSecret: "cs-secret" }]);
    const blob = JSON.stringify(
      dehydrate(qc, { shouldDehydrateQuery: (q) => shouldPersistQuery(q) }),
    );
    expect(blob).toContain('"balance"');
    expect(blob).not.toContain("privateBalance");
    expect(blob).not.toContain("777000123");
    expect(blob).not.toContain("cs-secret");
  });

  it("drops blobs saved while the private balance was persisted", () => {
    expect(PERSIST_BUSTER).not.toBe("scope-v1");
  });
});

describe("query retry", () => {
  it("retries once", () => {
    expect(retryQuery(0, new Error("offline"))).toBe(true);
    expect(retryQuery(1, new Error("offline"))).toBe(false);
    expect(retryQuery(0, new RpcError("RPC HTTP error: 503", { httpStatus: 503 }))).toBe(true);
  });

  it("never retries a rate limited read", () => {
    expect(retryQuery(0, new RpcError("RPC HTTP error: 429", { httpStatus: 429 }))).toBe(false);
  });
});
