// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";

const m = vi.hoisted(() => ({
  invoke: vi.fn(async () => undefined),
  wallet: {} as Record<string, unknown>,
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => m.invoke(...(a as [])) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ setFocus: async () => {} }),
}));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
vi.mock("src/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("src/services/wallet/walletBridge", () => ({
  walletBridge: { getPublicKey: vi.fn(async () => "pub"), signMessage: vi.fn() },
}));
vi.mock("src/contexts/useWallet", () => ({ useWallet: () => m.wallet }));

import * as dappService from "src/features/dapp/services/dappService";
import { useDappBridge } from "src/features/dapp/hooks/useDappBridge";

const MAIN = { id: "w1", name: "Main", address: `oct${"A".repeat(44)}`, wallet_type: "mnemonic" };
const SPEND = {
  id: "w2",
  name: "Spending",
  address: `oct${"B".repeat(44)}`,
  wallet_type: "private_key",
};
const S1 = "https://one.example";
const S2 = "https://two.example";

function setWallet(patch: Record<string, unknown>) {
  m.wallet = { ...m.wallet, ...patch };
}

const emitted = () =>
  m.invoke.mock.calls
    .filter((c) => (c as unknown[])[0] === "dapp_emit_event")
    .map((c) => (c as unknown as [string, { event: string; origins: string[] }])[1]);

beforeEach(() => {
  localStorage.clear();
  m.invoke.mockClear();
  m.wallet = {
    activeWallet: MAIN,
    wallets: [MAIN, SPEND],
    networkId: "mainnet",
    isLocked: false,
    setNetworkId: vi.fn(),
    showMessage: vi.fn(),
  };
  dappService.connectWallet("mainnet", S1, SPEND, MAIN.address);
  dappService.connectWallet("mainnet", S1, MAIN, MAIN.address);
  dappService.connectWallet("mainnet", S2, MAIN, MAIN.address);
});

describe("dapp events reach only the sites they are about", () => {
  it("a wallet switch moves and tells only the sites connected with that wallet", async () => {
    const { rerender } = renderHook(() => useDappBridge(undefined, { ownsGlobalBridges: true }));
    setWallet({ activeWallet: SPEND });
    rerender();
    await waitFor(() => expect(emitted().length).toBeGreaterThan(0));
    expect(emitted()).toEqual([
      expect.objectContaining({ event: "accountChanged", origins: [S1] }),
    ]);
    expect(dappService.getSite("mainnet", S1)!.inUse).toBe(SPEND.address);
    expect(dappService.getSite("mainnet", S2)!.inUse).toBe(MAIN.address);
  });

  it("a network switch tells sites there, and the ones left behind that they are not connected", async () => {
    dappService.carrySite("mainnet", "devnet", S1);
    const { rerender } = renderHook(() => useDappBridge(undefined, { ownsGlobalBridges: true }));
    setWallet({ networkId: "devnet" });
    rerender();
    await waitFor(() => expect(emitted().length).toBeGreaterThan(0));
    const events = emitted();
    expect(events).toContainEqual(
      expect.objectContaining({ event: "networkChanged", origins: [S1, S2] }),
    );
    expect(events).toContainEqual(expect.objectContaining({ event: "disconnect", origins: [S2] }));
    expect(events.some((e) => e.event === "disconnect" && e.origins.includes(S1))).toBe(false);
    expect(dappService.isConnected("mainnet", S2)).toBe(true);
  });

  it("lock events go to the sites connected on this network only", async () => {
    dappService.connectWallet("devnet", "https://dev.example", MAIN, MAIN.address);
    const { rerender } = renderHook(() => useDappBridge(undefined, { ownsGlobalBridges: true }));
    setWallet({ isLocked: true });
    rerender();
    await waitFor(() => expect(emitted().length).toBeGreaterThan(0));
    const lock = emitted().find((e) => e.event === "extensionLocked")!;
    expect(lock.origins.sort()).toEqual([S1, S2].sort());
  });

  it("no event is ever sent without the sites it is for", async () => {
    const { rerender } = renderHook(() => useDappBridge(undefined, { ownsGlobalBridges: true }));
    setWallet({ activeWallet: SPEND });
    rerender();
    setWallet({ networkId: "devnet" });
    rerender();
    await act(async () => {});
    for (const e of emitted()) {
      expect(Array.isArray(e.origins)).toBe(true);
      expect(e.origins.length).toBeGreaterThan(0);
    }
  });

  it("an instance that does not own the windows never pushes to them", async () => {
    const { rerender } = renderHook(() => useDappBridge(undefined));
    setWallet({ activeWallet: SPEND });
    rerender();
    await act(async () => {});
    expect(emitted()).toEqual([]);
  });
});

describe("a circle asks through the connect review sites use", () => {
  it("opens the connect review for the circle's origin and resolves with the answer", async () => {
    const { result } = renderHook(() => useDappBridge(undefined));
    const origin = "oct://octBqsZH2c1GBnBrYhUJPJHdmLuT8YMPXFpEKsPKqEYYYfi";
    let answered: Promise<{ approved: boolean }>;
    act(() => {
      answered = result.current.askConnect(origin, MAIN);
    });
    await waitFor(() => expect(result.current.pendingApproval).not.toBeNull());
    expect(result.current.pendingApproval).toMatchObject({
      type: "connect",
      origin,
      networkId: "mainnet",
      connect: { open: MAIN, choices: [MAIN], permissions: [] },
    });
    let second: unknown;
    await act(async () => {
      second = await result.current.askConnect(origin, MAIN).catch((e) => e);
    });
    expect(second).toMatchObject({ code: "RATE_LIMIT_EXCEEDED" });
    act(() => result.current.approveRequest(MAIN.address));
    await expect(answered!).resolves.toMatchObject({ approved: true });
    expect(result.current.pendingApproval).toBeNull();
  });
});
