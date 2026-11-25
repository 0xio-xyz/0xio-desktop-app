// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "src/lib/router";
import { QueryClient, QueryClientProvider } from "src/lib/query";

const m = vi.hoisted(() => ({
  calls: [] as string[],
  oracle: 0,
  serialized: 0,
  update: { update: { phase: "idle" } },
  listeners: new Map<string, (e: { payload: unknown }) => void>(),
  wallet: {
    id: "w1",
    name: "One",
    address: "oct" + "A".repeat(44),
    wallet_type: "hd",
    is_active: true,
  },
}));

const later = <T,>(value: T, ms: number) =>
  new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

const OUTPUTS = 1011;
const NODE_PAGE_MAX = 256;

function answer(method: string, params: unknown[]): { result?: unknown; error?: unknown } {
  switch (method) {
    case "octra_balance":
      return { result: { balance_raw: "5000000", nonce: 1, pending_nonce: 1 } };
    case "octra_recommendedFee":
      return { result: { minimum: "1000", recommended: "2000", fast: "3000" } };
    case "octra_pvacPubkey":
      return { result: { pvac_pubkey: "remote-key" } };
    case "octra_encryptedBalance":
      return { result: { cipher: `hfhe_v1|${"a".repeat(400)}` } };
    case "octra_pvacMigrationStatus":
      return {
        result: { address: m.wallet.address, cipher_class: "v3", can_key_switch: true },
      };
    case "octra_transactionsByAddress":
      return { result: { transactions: [], total: 0, has_more: false } };
    case "staging_view":
      return { result: { transactions: [] } };
    case "node_status":
      return { result: { current_epoch: 5000 } };
    case "octra_stealthOutputsPage": {
      const [from, before, limit] = params as [number, number, number];
      if (limit > NODE_PAGE_MAX) return { error: { code: -32013, message: "byte limit" } };
      if (from > 1) return { result: { outputs: [], has_more: false } };
      const top = Math.min(before, OUTPUTS);
      const outputs = Array.from({ length: Math.min(limit, top) }, (_, i) => ({
        id: top - 1 - i,
        eph_pub: "e",
        stealth_tag: "t",
        enc_amount: "a",
        claimed: 1,
        epoch_id: 1,
      }));
      const next = top - outputs.length;
      return { result: { outputs, has_more: next > 0, next_before_id: next } };
    }
    default:
      return { result: {} };
  }
}

vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (_url: string, init: { body: string }) => {
    const { method, params } = JSON.parse(init.body);
    m.calls.push(method);
    return later(
      {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ jsonrpc: "2.0", id: 1, ...answer(method, params) }),
      },
      50,
    );
  },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => ({})) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, fn: (e: { payload: unknown }) => void) => {
    m.listeners.set(name, fn);
    return () => {
      if (m.listeners.get(name) === fn) m.listeners.delete(name);
    };
  }),
}));
vi.mock("@tauri-apps/api/window", () => ({
  UserAttentionType: {},
  getCurrentWindow: () => ({
    onFocusChanged: async () => () => {},
    isVisible: async () => true,
    isMinimized: async () => false,
  }),
}));
vi.mock("src/lib/logger", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    pvacOp: vi.fn(),
    timed: vi.fn(async (_tag: string, _label: string, fn: () => Promise<unknown>) => fn()),
  },
  isDevMode: () => false,
}));
vi.mock("src/shared/dev/debugLogs", () => ({
  logRpc: vi.fn(),
  updateRpcLog: vi.fn(),
  getNextRpcLogId: () => 1,
  logPvacTiming: vi.fn(),
}));
vi.mock("src/services/app/updater", () => ({
  getUpdateSnapshot: () => m.update,
  subscribeUpdates: () => () => {},
}));
vi.mock("src/services/notices/noticeNative", () => ({ announce: vi.fn() }));
vi.mock("src/services/wallet/biometricService", () => ({
  biometricService: { isEnabled: async () => false, unlock: async () => {} },
}));
vi.mock("src/services/wallet/walletBridge", () => ({
  walletBridge: {
    hasPassword: async () => true,
    signMessage: async () => "sig",
    getPublicKey: async () => "pub",
    matchStealthOutputs: async () => [],
    setActive: async () => {},
    lock: async () => {},
  },
}));
vi.mock("src/services/pvac/pvacBridge", () => ({
  pvacBridge: {
    isInitialized: () => true,
    isInitializedFor: () => true,
    contextId: () => "ctx",
    requireContext: () => "ctx",
    ensureInit: async () => {},
    destroy: async () => {},
    serializePubkey: () => {
      m.serialized++;
      return later({ pubkey: "local-key" }, 600);
    },
    decrypt: async () => ({ value: 7, corrupted: false }),
    checkBoundProvable: async () => ({ provable: true, base_layers: 1, canonical_r_com: true }),
    matchesSecretProfile: async () => ({ matches: true }),
  },
}));
vi.mock("src/contexts/useWallet", () => {
  const noop = () => {};
  const wallets = [m.wallet];
  const value = {
    isLocked: false,
    isInitialized: true,
    wallets,
    activeWallet: m.wallet,
    networkId: "devnet",
    setNetworkId: noop,
    refreshWallets: noop,
    setWallets: noop,
    setActiveWallet: noop,
    setIsLocked: noop,
    pvacForeign: false,
    setPvacForeign: noop,
    pvacLegacy: false,
    setPvacLegacy: noop,
    showMessage: noop,
  };
  return { useWallet: () => value };
});

import { useTrayBridge } from "src/hooks/app/useTrayBridge";
import { useNoticeSources } from "src/hooks/app/useNoticeSources";
import { useBalance } from "src/hooks/wallet/useBalance";
import { useTransactionHistory } from "src/hooks/transactions/useTransactionHistory";
import { useClaimableCount } from "src/hooks/privacy/useClaimableCount";
import { usePrivateSetupTag } from "src/hooks/privacy/usePrivateSetupTag";
import { useTokenPrice } from "src/hooks/wallet/useTokenPrice";
import { jsonRpcCall, setActiveAddress, setNetwork } from "src/services/network/networkService";
import { destroyPvac, resetStealthScanCache } from "src/features/privacy/services/privacyService";

function Shell() {
  useTrayBridge();
  useNoticeSources();
  useClaimableCount();
  return null;
}

function Home() {
  const { publicBalance, isLoading, isPvacLoading } = useBalance();
  useTransactionHistory();
  useClaimableCount();
  useTokenPrice();
  usePrivateSetupTag(publicBalance, !isLoading, !isPvacLoading);
  return null;
}

function mountHome() {
  const qc = new QueryClient({
    defaultOptions: { queries: { refetchOnWindowFocus: true, staleTime: 30_000 } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Shell />
        <Home />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function setHidden(hidden: boolean) {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => (hidden ? "hidden" : "visible"),
  });
  document.dispatchEvent(new Event("visibilitychange"));
  window.dispatchEvent(new Event("visibilitychange"));
}

const realTimeout = globalThis.setTimeout;
const turn = () => new Promise<void>((resolve) => realTimeout(resolve, 0));

async function run(ms: number) {
  const step = ms > 60_000 ? 5_000 : 100;
  for (let at = 0; at < ms; at += step) {
    await act(async () => {
      await turn();
      await vi.advanceTimersByTimeAsync(step);
      await turn();
    });
  }
}

function tally(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const method of m.calls) out[method] = (out[method] ?? 0) + 1;
  return out;
}

const MINUTES = 10;

beforeEach(async () => {
  await jsonRpcCall("node_status");
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"],
  });
  localStorage.clear();
  m.calls = [];
  m.oracle = 0;
  m.serialized = 0;
  vi.stubGlobal("fetch", async () => {
    m.oracle++;
    return { ok: true, json: async () => ({ OCT: 1 }) };
  });
  setNetwork("devnet");
  setActiveAddress(m.wallet.address);
  await destroyPvac();
  resetStealthScanCache();
  const path = "src/lib/query/queryVisibility";
  const mod = await import(/* @vite-ignore */ path).catch(() => null);
  mod?.pauseQueriesWhileHidden();
  setHidden(false);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const emit = (name: string) => act(async () => m.listeners.get(name)?.({ payload: null }));

describe("node calls on Home", () => {
  it("stays inside the budget at unlock, idle and hidden", async () => {
    mountHome();
    await run(15_000);
    const unlock = tally();
    const unlockTotal = m.calls.length;

    m.calls = [];
    await run(MINUTES * 60_000);
    const idle = tally();
    const idlePerMinute = m.calls.length / MINUTES;

    setHidden(true);
    await run(2_000);
    m.calls = [];
    await run(MINUTES * 60_000);
    const hidden = tally();
    const hiddenPerMinute = m.calls.length / MINUTES;

    m.calls = [];
    setHidden(false);
    await run(15_000);
    const back = tally();

    expect(m.serialized).toBe(1);
    expect(unlock).toEqual({
      octra_balance: 1,
      octra_pvacPubkey: 1,
      octra_encryptedBalance: 1,
      octra_transactionsByAddress: 1,
      node_status: 1,
      octra_stealthOutputsPage: 4,
    });
    expect(unlockTotal).toBe(9);
    expect(idle.octra_balance).toBe(2 * MINUTES);
    expect(idle.octra_recommendedFee).toBeUndefined();
    expect(idlePerMinute).toBeLessThanOrEqual(5);
    expect(hidden).toEqual({});
    expect(hiddenPerMinute).toBe(0);
    expect(back).toEqual({ ...unlock, octra_stealthOutputsPage: 1 });
  });

  it("reads fees for the menu bar panel only while it is open, and polls for it while hidden", async () => {
    mountHome();
    await run(15_000);
    expect(tally().octra_recommendedFee).toBeUndefined();

    setHidden(true);
    await run(2_000);
    m.calls = [];
    await emit("tray-opened");
    await run(65_000);
    const open = tally();
    expect(open.octra_recommendedFee).toBe(4);
    expect(open.octra_balance).toBe(3);

    await emit("tray-closed");
    m.calls = [];
    await run(5 * 60_000);
    expect(m.calls).toEqual([]);

    await emit("tray-opened");
    await run(5_000);
    expect(tally().octra_recommendedFee).toBe(4);
    await emit("tray-closed");
    m.calls = [];
    await emit("tray-opened");
    await run(5_000);
    expect(tally().octra_recommendedFee).toBeUndefined();
  });
});
