import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const http = vi.hoisted(() => ({
  stall: true,
  aborted: 0,
  sent: 0,
}));

vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: async (_url: string, init: { signal: AbortSignal }) => {
    http.sent++;
    init.signal.addEventListener("abort", () => http.aborted++);
    const stalled = http.stall;
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: () =>
        stalled
          ? new Promise(() => {})
          : Promise.resolve({ jsonrpc: "2.0", id: 1, result: { ok: true } }),
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

import { jsonRpcCallOn, pingNetwork, setNetwork } from "src/services/network/networkService";
import { isNetworkSlow } from "src/services/network/networkHealth";

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  http.stall = true;
  http.aborted = 0;
  http.sent = 0;
  setNetwork("devnet");
});
afterEach(() => vi.useRealTimers());

describe("a response whose body never arrives", () => {
  it("times out like a silent node and aborts the request", async () => {
    const call = jsonRpcCallOn("devnet", "octra_balance", ["octA"]);
    const failed = expect(call).rejects.toThrow(/Network timed out/);
    await vi.dynamicImportSettled();
    await vi.advanceTimersByTimeAsync(30_000);
    await failed;
    expect(http.aborted).toBe(1);
    expect(isNetworkSlow()).toBe(true);
  });

  it("gives its slot back, so later calls still run", async () => {
    const stalled = Array.from({ length: 8 }, () =>
      jsonRpcCallOn("devnet", "octra_balance", ["octA"]).then(
        () => "",
        (e: Error) => e.message,
      ),
    );
    await vi.dynamicImportSettled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(http.sent).toBe(4);
    await vi.advanceTimersByTimeAsync(60_000);
    const messages = await Promise.all(stalled);
    expect(messages.filter((m) => /Network timed out/.test(m))).toHaveLength(4);
    expect(messages.filter((m) => m === "wallet rpc slots busy")).toHaveLength(4);
    expect(http.sent).toBe(4);

    http.stall = false;
    const answers = await Promise.all(
      Array.from({ length: 7 }, () => jsonRpcCallOn("devnet", "octra_balance", ["octA"])),
    );
    expect(answers).toHaveLength(7);
    expect(http.sent).toBe(11);
  });

  it("ends a ping instead of hanging it", async () => {
    const ping = pingNetwork("devnet", 2_000);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await ping).toBeNull();
  });

  it("leaves a body that arrives in time alone", async () => {
    http.stall = false;
    expect(await jsonRpcCallOn("devnet", "octra_balance", ["octA"])).toEqual({ ok: true });
    expect(http.aborted).toBe(0);
  });
});
