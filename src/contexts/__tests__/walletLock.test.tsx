// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "src/lib/query";

const tauri = vi.hoisted(() => ({
  sent: [] as { cmd: string; args?: Record<string, unknown> }[],
  handlers: new Map<string, (e: { payload: unknown }) => void>(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    tauri.sent.push({ cmd, args });
    return cmd === "wallet_is_initialized" ? true : null;
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, cb: (e: { payload: unknown }) => void) => {
    tauri.handlers.set(event, cb);
    return () => tauri.handlers.delete(event);
  }),
}));
vi.mock("src/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), pvacOp: vi.fn() },
}));
vi.mock("src/shared/dev/debugLogs", () => ({ logPvacTiming: vi.fn() }));
vi.mock("src/services/notices/noticeNative", () => ({ announce: vi.fn() }));

import { WalletProvider } from "src/contexts/WalletContext";
import { useWallet } from "src/contexts/useWallet";

let wallet!: ReturnType<typeof useWallet>;
function Probe() {
  wallet = useWallet();
  return null;
}

const names = () => tauri.sent.map((s) => s.cmd);
const reports = () => tauri.sent.filter((s) => s.cmd === "wallet_idle_report").map((s) => s.args);

async function boot(qc = new QueryClient()) {
  render(
    <QueryClientProvider client={qc}>
      <WalletProvider>
        <Probe />
      </WalletProvider>
    </QueryClientProvider>,
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  return qc;
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  tauri.sent = [];
  tauri.handlers.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("wallet lock", () => {
  it("ends the Rust session before the lock screen shows after a reload", async () => {
    await boot();
    expect(wallet.isLocked).toBe(true);
    expect(wallet.isLoading).toBe(false);
    const order = names();
    expect(order.indexOf("wallet_lock")).toBeGreaterThan(order.indexOf("wallet_is_initialized"));
    expect(order).toContain("pvac_destroy");
    expect(order).not.toContain("wallet_idle_report");
  });

  it("drops claim secrets and the private balance on every lock", async () => {
    const qc = await boot();
    await act(async () => wallet.setIsLocked(false));
    qc.setQueryData(["privateBalance", "octA", "devnet"], 9);
    qc.setQueryData(["claimOutputs", "w1", "devnet"], [{ claimSecret: "cs" }]);
    qc.setQueryData(["balance", "octA", "devnet"], { balance: 1, nonce: 0 });
    await act(async () => wallet.setIsLocked(true));
    expect(qc.getQueryData(["privateBalance", "octA", "devnet"])).toBeUndefined();
    expect(qc.getQueryData(["claimOutputs", "w1", "devnet"])).toBeUndefined();
    expect(qc.getQueryData(["balance", "octA", "devnet"])).toBeDefined();
  });

  it("tells Rust the limit on unlock and locks after it", async () => {
    localStorage.setItem("0xio_auto_lock_minutes", "1");
    await boot();
    await act(async () => wallet.setIsLocked(false));
    expect(reports()).toEqual([{ autoLockMinutes: 1, active: true, working: false }]);
    tauri.sent = [];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(wallet.isLocked).toBe(true);
    expect(names()).toContain("wallet_lock");
    expect(names()).toContain("pvac_destroy");
  });

  it("tells Rust auto-lock is off when set to 0", async () => {
    localStorage.setItem("0xio_auto_lock_minutes", "0");
    await boot();
    await act(async () => wallet.setIsLocked(false));
    expect(reports()).toEqual([{ autoLockMinutes: 0, active: true, working: false }]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6 * 60 * 60_000);
    });
    expect(wallet.isLocked).toBe(false);
  });

  it("shows the lock screen when Rust locked on its own deadline", async () => {
    await boot();
    await act(async () => wallet.setIsLocked(false));
    expect(wallet.isLocked).toBe(false);
    await act(async () => tauri.handlers.get("wallet-idle-locked")?.({ payload: null }));
    expect(wallet.isLocked).toBe(true);
  });
});
