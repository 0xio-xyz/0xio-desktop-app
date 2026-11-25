import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => ({
  calls: [] as { url: string; method: string; params: unknown[] }[],
  answer: (_method: string, _params: unknown[]): { result?: unknown; error?: unknown } => ({}),
  fail: false,
}));

vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: async (url: string, init: { body: string }) => {
    const { method, params } = JSON.parse(init.body);
    rpc.calls.push({ url, method, params });
    await Promise.resolve();
    if (rpc.fail) throw new Error("offline");
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ jsonrpc: "2.0", id: 1, ...rpc.answer(method, params) }),
    };
  },
}));
vi.mock("src/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("src/shared/dev/debugLogs", () => ({
  logRpc: vi.fn(),
  updateRpcLog: vi.fn(),
  getNextRpcLogId: () => 1,
}));

import {
  clearPvacPubkeyCache,
  getPvacMigrationStatus,
  getPvacPubkey,
  getStealthOutputs,
  getTransactionHistory,
  setActiveAddress,
  setNetwork,
} from "src/services/network/networkService";

const A = "octAAAA";
const B = "octBBBB";
const count = (method: string) => rpc.calls.filter((c) => c.method === method).length;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  localStorage.clear();
  rpc.calls = [];
  rpc.fail = false;
  rpc.answer = () => ({ result: {} });
  setNetwork("devnet");
  setActiveAddress(A);
  clearPvacPubkeyCache();
});
afterEach(() => vi.useRealTimers());

describe("octra_pvacPubkey", () => {
  beforeEach(() => {
    rpc.answer = (_m, params) => ({
      result: { pvac_pubkey: `key-${params[0]}-${rpc.calls.length}` },
    });
  });

  it("shares one read between callers at once and reuses it for 30 s", async () => {
    const all = await Promise.all([
      getPvacPubkey(A, "devnet"),
      getPvacPubkey(A, "devnet"),
      getPvacPubkey(A, "devnet"),
    ]);
    expect(new Set(all).size).toBe(1);
    expect(count("octra_pvacPubkey")).toBe(1);

    vi.advanceTimersByTime(29_000);
    expect(await getPvacPubkey(A, "devnet")).toBe(all[0]);
    expect(count("octra_pvacPubkey")).toBe(1);

    vi.advanceTimersByTime(2_000);
    await getPvacPubkey(A, "devnet");
    expect(count("octra_pvacPubkey")).toBe(2);
  });

  it("keeps the cache to its network and address", async () => {
    await getPvacPubkey(A, "devnet");
    await getPvacPubkey(A, "mainnet");
    await getPvacPubkey(B, "mainnet");
    expect(count("octra_pvacPubkey")).toBe(3);
    expect(new Set(rpc.calls.map((c) => c.url)).size).toBe(2);
  });

  it("always asks the node for a fresh read", async () => {
    await getPvacPubkey(A, "devnet");
    await getPvacPubkey(A, "devnet", { fresh: true });
    await getPvacPubkey(A, "devnet", { fresh: true });
    expect(count("octra_pvacPubkey")).toBe(3);
  });

  it("forgets the key on a key switch, a wallet change, a network change", async () => {
    await getPvacPubkey(A, "devnet");
    clearPvacPubkeyCache();
    await getPvacPubkey(A, "devnet");
    setActiveAddress(B);
    setActiveAddress(A);
    await getPvacPubkey(A, "devnet");
    setNetwork("mainnet");
    setNetwork("devnet");
    await getPvacPubkey(A, "devnet");
    expect(count("octra_pvacPubkey")).toBe(4);
  });

  it("does not let a read from before a key switch fill the cache", async () => {
    const before = getPvacPubkey(A, "devnet");
    clearPvacPubkeyCache();
    await before;
    await getPvacPubkey(A, "devnet");
    expect(count("octra_pvacPubkey")).toBe(2);
  });

  it("never caches a failed read", async () => {
    rpc.fail = true;
    vi.useFakeTimers();
    const failed = expect(getPvacPubkey(A, "devnet")).rejects.toThrow();
    await vi.runAllTimersAsync();
    await failed;
    vi.useRealTimers();
    const tried = count("octra_pvacPubkey");
    expect(tried).toBeGreaterThan(1);
    rpc.fail = false;
    await getPvacPubkey(A, "devnet");
    expect(count("octra_pvacPubkey")).toBe(tried + 1);
  });
});

describe("shared in-flight reads", () => {
  it("asks octra_pvacMigrationStatus once for callers at once, again for a later one", async () => {
    rpc.answer = () => ({ result: { cipher_class: "v3" } });
    await Promise.all([getPvacMigrationStatus(A, "devnet"), getPvacMigrationStatus(A, "devnet")]);
    expect(count("octra_pvacMigrationStatus")).toBe(1);
    await getPvacMigrationStatus(A, "devnet");
    await getPvacMigrationStatus(B, "devnet");
    expect(count("octra_pvacMigrationStatus")).toBe(3);
  });

  it("asks octra_transactionsByAddress once for callers at once, again for a later one", async () => {
    rpc.answer = () => ({ result: { transactions: [], total: 0 } });
    await Promise.all([
      getTransactionHistory(A, 20, 0, "devnet"),
      getTransactionHistory(A, 20, 0, "devnet"),
      getTransactionHistory(A, 20, 0, "devnet"),
    ]);
    expect(count("octra_transactionsByAddress")).toBe(1);
    await getTransactionHistory(A, 20, 0, "devnet");
    await getTransactionHistory(B, 20, 0, "devnet");
    await getTransactionHistory(A, 20, 0, "mainnet");
    expect(count("octra_transactionsByAddress")).toBe(4);
  });
});

describe("stealth output paging", () => {
  const TOTAL = 1011;
  const pages = (max: number) => (_m: string, params: unknown[]) => {
    const [, before, limit] = params as [number, number, number];
    if (limit > max) return { error: { code: -32013, message: "over the byte limit" } };
    const top = Math.min(before, TOTAL);
    const outputs = Array.from({ length: Math.min(limit, top) }, (_, i) => ({ id: top - 1 - i }));
    const next = top - outputs.length;
    return { result: { outputs, has_more: next > 0, next_before_id: next } };
  };
  const limits = () =>
    rpc.calls.filter((c) => c.method === "octra_stealthOutputsPage").map((c) => c.params[2]);

  it("reads 1011 outputs in four pages of 256", async () => {
    rpc.answer = pages(256);
    expect(await getStealthOutputs(0, "mainnet")).toHaveLength(TOTAL);
    expect(limits()).toEqual([256, 256, 256, 256]);
  });

  it("halves on -32013 and starts the next scan at the size the node took", async () => {
    rpc.answer = pages(64);
    expect(await getStealthOutputs(0, "devnet")).toHaveLength(TOTAL);
    expect(limits().slice(0, 3)).toEqual([256, 128, 64]);
    expect(limits()).toHaveLength(2 + 16);

    rpc.calls = [];
    expect(await getStealthOutputs(0, "devnet")).toHaveLength(TOTAL);
    expect(limits()).toEqual(Array(16).fill(64));
  });
});
