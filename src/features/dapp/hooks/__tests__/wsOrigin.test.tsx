// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

const m = vi.hoisted(() => ({
  invoke: vi.fn(async (..._a: unknown[]) => undefined),
  handler: vi.fn(),
  listeners: new Map<string, (e: { payload: unknown }) => void>(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => m.invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, cb: (e: { payload: unknown }) => void) => {
    m.listeners.set(name, cb);
    return () => m.listeners.delete(name);
  }),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ setFocus: async () => {} }),
}));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
vi.mock("src/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("src/services/wallet/walletBridge", () => ({
  walletBridge: { getPublicKey: vi.fn(async () => "pub") },
}));
vi.mock("src/contexts/useWallet", () => ({
  useWallet: () => ({
    activeWallet: null,
    wallets: [],
    networkId: "mainnet",
    isLocked: false,
    setNetworkId: vi.fn(),
    showMessage: vi.fn(),
  }),
}));
vi.mock("src/features/dapp/services/dappRequest", async (importOriginal) => ({
  ...(await importOriginal<typeof import("src/features/dapp/services/dappRequest")>()),
  createDappRequestHandler: () => m.handler,
}));

import { useDappBridge, wsRequestOrigin } from "src/features/dapp/hooks/useDappBridge";

const fire = async (payload: Record<string, unknown>) => {
  const cb = m.listeners.get("wallet-rpc-request");
  if (!cb) throw new Error("no listener");
  await act(async () => cb({ payload: JSON.stringify(payload) }));
};

beforeEach(() => {
  m.invoke.mockClear();
  m.handler.mockReset();
  m.handler.mockResolvedValue({ id: "1", success: true, data: {}, timestamp: 0 });
});

describe("the local WebSocket names each site by its handshake", () => {
  it("accepts only the origins Rust can name", () => {
    expect(wsRequestOrigin({ origin: "native://my-bot-abc123" })).toBe("native://my-bot-abc123");
    expect(wsRequestOrigin({ origin: "chrome-extension://anknhjilldkeelailocijnfibefmepcc" })).toBe(
      "chrome-extension://anknhjilldkeelailocijnfibefmepcc",
    );
    for (const bad of [
      undefined,
      "",
      "ws://localhost",
      "null",
      "https://app.example.com",
      "http://localhost:5173",
      "file://",
      42,
    ]) {
      expect(wsRequestOrigin({ origin: bad })).toBeNull();
    }
  });

  it("hands each client's request to the handler under its own origin", async () => {
    renderHook(() => useDappBridge(undefined, { ownsGlobalBridges: true }));
    await waitFor(() => expect(m.listeners.has("wallet-rpc-request")).toBe(true));
    const request = { id: "1", method: "connect", params: {}, timestamp: 0 };
    const ext = "chrome-extension://anknhjilldkeelailocijnfibefmepcc";
    await fire({ rpc_id: "r1", request, origin: ext });
    await fire({ rpc_id: "r2", request, origin: "native://my-bot-abc123" });
    await fire({ rpc_id: "r4", request, origin: "https://evil.example" });
    expect(m.handler.mock.calls.map((c) => c[1])).toEqual([ext, "native://my-bot-abc123"]);
    expect(m.handler.mock.calls.map((c) => c[1])).not.toContain("ws://localhost");
  });

  it("refuses a request that carries no site instead of sharing one", async () => {
    renderHook(() => useDappBridge(undefined, { ownsGlobalBridges: true }));
    await waitFor(() => expect(m.listeners.has("wallet-rpc-request")).toBe(true));
    await fire({ rpc_id: "r3", request: { id: "9", method: "connect", params: {} } });
    expect(m.handler).not.toHaveBeenCalled();
    const reply = m.invoke.mock.calls.find((c) => c[0] === "wallet_rpc_respond");
    expect(reply?.[1]).toMatchObject({
      rpcId: "r3",
      response: { success: false, error: { code: "UNAUTHORIZED" } },
    });
  });
});
