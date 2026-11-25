import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RpcExchange } from "src/services/network/rpcTransport";

const t = vi.hoisted(() => ({
  replies: [] as RpcExchange[],
  sent: [] as { method: string; timeoutMs: number }[],
  hold: null as Promise<void> | null,
}));

vi.mock("src/services/network/rpcTransport", () => ({
  postRpc: async (_url: string, body: string, timeoutMs: number) => {
    t.sent.push({ method: JSON.parse(body).method, timeoutMs });
    if (t.hold) await t.hold;
    return t.replies.shift() ?? ok({});
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

import { jsonRpcCallOn } from "src/services/network/networkService";
import { RpcError } from "src/services/network/submitErrors";

function ok(result: unknown): RpcExchange {
  return {
    link: "answered",
    status: 200,
    data: { jsonrpc: "2.0", id: 1, result },
    retryAfter: null,
  };
}
const http = (status: number, data?: unknown, retryAfter: string | null = null): RpcExchange => ({
  link: "answered",
  status,
  data,
  retryAfter,
});
const failed = (link: RpcExchange["link"]): RpcExchange => ({ link, status: 0, retryAfter: null });
const capacity = {
  jsonrpc: "2.0",
  id: null,
  error: { code: -32005, message: "RPC Capacity reached" },
};

beforeEach(() => {
  vi.useFakeTimers();
  t.replies = [];
  t.sent = [];
  t.hold = null;
});
afterEach(() => vi.useRealTimers());

async function settle<T>(p: Promise<T>): Promise<T> {
  const out = p.then(
    (v) => ({ v }),
    (e) => ({ e }),
  );
  await vi.runAllTimersAsync();
  const r = (await out) as { v?: T; e?: unknown };
  if ("e" in r) throw r.e;
  return r.v as T;
}

describe("one exchange for every node call", () => {
  it("repeats a read on a gateway error and a state change", async () => {
    t.replies = [
      http(502),
      http(200, { jsonrpc: "2.0", id: 1, error: { code: -32012, message: "x" } }),
      ok({ nonce: 1 }),
    ];
    expect(await settle(jsonRpcCallOn("devnet", "octra_balance", ["a"]))).toEqual({ nonce: 1 });
    expect(t.sent).toHaveLength(3);
  });

  it("never repeats a write that may have left", async () => {
    for (const reply of [failed("broken"), failed("expired"), http(502), http(429)]) {
      t.sent = [];
      t.replies = [reply, ok({ hash: "h" })];
      const err = await settle(jsonRpcCallOn("devnet", "octra_submit", [{}])).catch((e) => e);
      expect(err).toBeInstanceOf(RpcError);
      expect((err as RpcError).unsent).toBe(false);
      expect((err as Error).message).not.toMatch(/nothing was sent/);
      expect(t.sent).toHaveLength(1);
    }
  });

  it("repeats a write that provably never left", async () => {
    t.replies = [failed("unopened"), http(429, capacity), ok({ hash: "h" })];
    expect(await settle(jsonRpcCallOn("devnet", "octra_submit", [{}]))).toEqual({ hash: "h" });
    expect(t.sent).toHaveLength(3);
  });

  it("reports an unsent write as nothing sent once the window closes", async () => {
    t.replies = Array.from({ length: 40 }, () => failed("unopened"));
    const err = await settle(jsonRpcCallOn("devnet", "octra_submit", [{}])).catch((e) => e);
    expect((err as Error).message).toBe("network unreachable; nothing was sent");
    expect((err as RpcError).unsent).toBe(true);
    expect(t.sent.length).toBeGreaterThan(3);
    expect(t.sent.length).toBeLessThan(12);
  });

  it("keeps retrying capacity within 25 s, honouring a capped Retry-After", async () => {
    t.replies = Array.from({ length: 40 }, () => http(429, capacity, "30"));
    const start = Date.now();
    const err = await settle(jsonRpcCallOn("devnet", "octra_balance", ["a"])).catch((e) => e);
    expect((err as Error).message).toBe("rpc capacity reached");
    expect(Date.now() - start).toBeLessThanOrEqual(25_000);
    expect(t.sent.length).toBe(5);
  });

  it("a certificate refusal is never retried", async () => {
    t.replies = [failed("untrusted"), ok({})];
    await expect(settle(jsonRpcCallOn("devnet", "octra_balance", ["a"]))).rejects.toThrow(
      /certificate/,
    );
    expect(t.sent).toHaveLength(1);
  });

  it("a 500 and an ordinary node error come back at once", async () => {
    t.replies = [http(500)];
    await expect(settle(jsonRpcCallOn("devnet", "octra_balance", ["a"]))).rejects.toThrow(
      "RPC HTTP error: 500",
    );
    t.replies = [
      http(200, { jsonrpc: "2.0", id: 1, error: { code: -32602, message: "invalid params" } }),
    ];
    await expect(settle(jsonRpcCallOn("devnet", "octra_balance", ["a"]))).rejects.toThrow(
      "invalid params",
    );
    expect(t.sent).toHaveLength(2);
  });

  it("a once call makes one attempt", async () => {
    t.replies = [http(502), ok({})];
    await expect(
      settle(jsonRpcCallOn("devnet", "octra_balance", ["a"], { once: true })),
    ).rejects.toThrow();
    expect(t.sent).toHaveLength(1);
  });

  it("holds polls to two slots while user calls take the rest, and leaves long calls ungated", async () => {
    let release!: () => void;
    t.hold = new Promise<void>((r) => (release = r));
    const calls = [
      ...Array.from({ length: 3 }, () =>
        jsonRpcCallOn("devnet", "staging_view", [], { lane: "poll" }),
      ),
      ...Array.from({ length: 3 }, () => jsonRpcCallOn("devnet", "octra_balance", ["a"])),
      jsonRpcCallOn("devnet", "octra_submit", [{}], 120_000),
    ];
    for (let i = 0; i < 5; i++) {
      await vi.dynamicImportSettled();
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(t.sent.map((s) => s.method).sort()).toEqual(
      ["octra_balance", "octra_balance", "octra_submit", "staging_view", "staging_view"].sort(),
    );
    release();
    t.hold = null;
    await settle(Promise.all(calls));
    expect(t.sent).toHaveLength(7);
  });
});
