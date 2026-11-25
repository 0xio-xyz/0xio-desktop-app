// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

type Handler = (e: { payload: unknown }) => void;

const m = vi.hoisted(() => ({
  invoke: vi.fn(),
  handlers: new Map<string, Handler>(),
  wallet: {} as Record<string, unknown>,
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => m.invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, fn: Handler) => {
    m.handlers.set(name, fn);
    return () => m.handlers.delete(name);
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
  walletBridge: { getPublicKey: vi.fn(async () => "pub"), signMessage: vi.fn(async () => "sig") },
}));
vi.mock("src/contexts/useWallet", () => ({ useWallet: () => m.wallet }));

import * as dappService from "src/features/dapp/services/dappService";
import { useDappBridge } from "src/features/dapp/hooks/useDappBridge";

const MAIN = { id: "w1", name: "Main", address: `oct${"A".repeat(44)}`, wallet_type: "mnemonic" };
const SITE = "https://pool.example";
const RID = "a".repeat(32);
const WIRE = "f".repeat(32);

const calls = (name: string) =>
  m.invoke.mock.calls.filter((c) => c[0] === name).map((c) => c[1] as Record<string, any>);
const fire = (name: string, payload: unknown) =>
  act(async () => {
    void m.handlers.get(name)?.({ payload });
  });

const request = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  origin: SITE,
  method: "signMessage",
  params: { message: "hi" },
  label: "dapp-pool",
  ...extra,
});

beforeEach(() => {
  localStorage.clear();
  m.handlers.clear();
  m.invoke.mockReset();
  m.invoke.mockImplementation(async (cmd: string, args?: Record<string, any>) => {
    if (cmd === "site_frame_open") return { kind: "new", wire: WIRE };
    if (cmd === "site_frame_update" && args?.update?.kind === "finish")
      return { status: args.update.reply.error ? "rejected" : "completed" };
    return {};
  });
  m.wallet = {
    activeWallet: MAIN,
    wallets: [MAIN],
    networkId: "mainnet",
    isLocked: false,
    setNetworkId: vi.fn(),
    showMessage: vi.fn(),
  };
  dappService.connectWallet("mainnet", SITE, MAIN, MAIN.address);
});

async function mount() {
  const hook = renderHook(() => useDappBridge(undefined, { ownsGlobalBridges: true }));
  await waitFor(() => expect(m.handlers.has("dapp-bridge-request")).toBe(true));
  return hook;
}

describe("dApp windows speak protocol 2", () => {
  it("a request with an id gets a record, review stages, and its id and status in the answer", async () => {
    const hook = await mount();
    await fire("dapp-bridge-request", request("w/1", { rid: RID }));
    await waitFor(() => expect(hook.result.current.pendingApproval).not.toBeNull());
    expect(calls("site_frame_open")[0]).toMatchObject({
      origin: SITE,
      frame: "window:dapp-pool:0",
      network: "mainnet",
      address: MAIN.address,
      rid: RID,
    });
    expect(calls("site_frame_update")[0]).toMatchObject({
      update: { kind: "stage", status: "review_open" },
    });
    act(() => hook.result.current.approveRequest());
    await waitFor(() => expect(calls("dapp_bridge_respond")).toHaveLength(1));
    expect(calls("dapp_bridge_respond")[0].reply).toMatchObject({
      result: { signature: "sig" },
      rid: RID,
      status: "completed",
    });
  });

  it("a circle page in a window of its own gets the tab's review, as its circle", async () => {
    const hook = await mount();
    const circle = "oct://circleA";
    await fire("dapp-bridge-request", {
      id: "dapp-oct-circleA/1",
      origin: circle,
      method: "connect",
      params: {},
      label: "dapp-oct-circleA",
    });
    await waitFor(() => expect(hook.result.current.pendingApproval).not.toBeNull());
    expect(hook.result.current.pendingApproval).toMatchObject({ type: "connect", origin: circle });
    expect(calls("dapp_bridge_respond")).toHaveLength(0);
    expect(dappService.getSite("mainnet", circle)).toBeFalsy();
    act(() => hook.result.current.rejectRequest());
    await waitFor(() => expect(calls("dapp_bridge_respond")).toHaveLength(1));
    const { reply } = calls("dapp_bridge_respond")[0];
    expect(reply.code).toBe("USER_REJECTED");
    expect(reply.error).toBeTruthy();
    expect(dappService.getSite("mainnet", circle)).toBeFalsy();
  });

  it("a request that fails inside the wallet is answered with a code and a message", async () => {
    await mount();
    m.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "site_frame_open") throw new Error("records unavailable");
      return {};
    });
    await fire("dapp-bridge-request", request("w/1", { rid: RID }));
    await waitFor(() => expect(calls("dapp_bridge_respond")).toHaveLength(1));
    expect(calls("dapp_bridge_respond")[0].reply).toEqual({
      error: "records unavailable",
      code: "INTERNAL_ERROR",
    });
  });

  it("a page that goes away closes its unanswered review", async () => {
    const hook = await mount();
    await fire("dapp-bridge-request", request("w/1", { rid: RID }));
    await waitFor(() => expect(hook.result.current.pendingApproval).not.toBeNull());
    await fire("dapp-window-gone", { label: "dapp-pool" });
    await waitFor(() => expect(calls("dapp_bridge_respond")).toHaveLength(1));
    expect(calls("dapp_bridge_respond")[0].reply).toMatchObject({
      error: "The page closed before 0xio Desktop answered.",
      code: "USER_REJECTED",
      rid: RID,
      status: "rejected",
    });
    expect(hook.result.current.pendingApproval).toBeNull();
  });

  it("a second review while one is open is refused as review_pending, naming the open one", async () => {
    const hook = await mount();
    await fire("dapp-bridge-request", request("w/1", { rid: RID }));
    await waitFor(() => expect(hook.result.current.pendingApproval).not.toBeNull());
    await fire("dapp-bridge-request", request("w/2", { rid: "b".repeat(32) }));
    await waitFor(() => expect(calls("dapp_bridge_respond")).toHaveLength(1));
    expect(calls("dapp_bridge_respond")[0].reply).toMatchObject({
      code: "RATE_LIMIT_EXCEEDED",
      details: { reason: "review_pending", status: "review_open", requestId: RID },
    });
  });

  it("protocol 1 requests keep today's path: no record", async () => {
    const hook = await mount();
    await fire("dapp-bridge-request", request("w/1"));
    await waitFor(() => expect(hook.result.current.pendingApproval).not.toBeNull());
    expect(calls("site_frame_open")).toHaveLength(0);
    act(() => hook.result.current.approveRequest());
    await waitFor(() => expect(calls("dapp_bridge_respond")).toHaveLength(1));
    expect(calls("dapp_bridge_respond")[0].reply.rid).toBeUndefined();
  });

  it("status updates go only to the window that asked, masked for an unconnected site", async () => {
    await mount();
    const data = { requestId: RID, status: "locked", network: "mainnet", address: MAIN.address };
    await fire("frame-request-update", { frame: "window:dapp-pool:0", origin: SITE, data });
    expect(calls("dapp_emit_event")).toEqual([
      { event: "requestUpdate", payload: data, origins: [SITE], label: "dapp-pool" },
    ]);
    await fire("frame-request-update", {
      frame: "window:dapp-pool:0",
      origin: "https://new.example",
      data,
    });
    expect(calls("dapp_emit_event")[1].payload).toEqual({ requestId: RID, status: "review_open" });
    await fire("dapp-window-gone", { label: "dapp-pool" });
    await fire("frame-request-update", { frame: "window:dapp-pool:0", origin: SITE, data });
    expect(calls("dapp_emit_event")).toHaveLength(2);
  });

  it("wallet_hello answers protocol 2 to any page", async () => {
    m.invoke.mockImplementation(async (cmd: string) =>
      cmd === "site_wallet_hello" ? { protocol: 2, kind: "desktop", capabilities: [] } : {},
    );
    await mount();
    await fire("dapp-bridge-request", {
      ...request("w/9"),
      method: "wallet_hello",
      origin: "https://new.example",
    });
    await waitFor(() => expect(calls("dapp_bridge_respond")).toHaveLength(1));
    expect(calls("dapp_bridge_respond")[0].reply.result).toMatchObject({
      protocol: 2,
      kind: "desktop",
    });
  });
});
