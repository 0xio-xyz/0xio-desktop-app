// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

type Handler = (e: { payload: unknown }) => void;

const m = vi.hoisted(() => ({
  invoke: vi.fn(),
  handlers: new Map<string, Handler>(),
  signed: 0,
  details: vi.fn(),
  progressFails: false,
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => m.invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, fn: Handler) => {
    m.handlers.set(name, fn);
    return () => m.handlers.delete(name);
  }),
}));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
vi.mock("src/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("src/i18n", () => ({ default: { t: (k: string) => k } }));
vi.mock("src/hooks/transactions/useFees", () => ({
  recheckReviewedFee: vi.fn(async () => ({ error: null })),
}));
vi.mock("src/hooks/app/useTrayUnlockRequest", () => ({
  withTrayAuthHold: (run: () => Promise<unknown>) => run(),
}));
vi.mock("src/services/wallet/biometricService", () => ({
  biometricService: { isEnabled: vi.fn(async () => false), unlock: vi.fn() },
}));
vi.mock("src/services/wallet/walletBridge", () => ({
  walletBridge: { hasPassword: vi.fn(async () => false) },
}));
vi.mock("src/features/privacy/services/trayPrivate", () => ({
  approveTrayRequest: async (a: { run: () => void }) => a.run(),
}));
vi.mock("src/services/network/networkService", async (importOriginal) => {
  const real = await importOriginal<typeof import("src/services/network/networkService")>();
  return {
    ...real,
    getTransactionDetails: (...a: unknown[]) => m.details(...a),
    jsonRpcCallOn: vi.fn(async () => null),
  };
});
vi.mock("src/contexts/useWallet", () => ({
  useWallet: () => ({ activeWallet: W, wallets: [W], isLocked: false }),
}));
vi.mock("src/features/dapp/services/dappRequest", () => ({
  createDappRequestHandler:
    (deps: { requestApproval: (a: unknown) => Promise<{ approved: boolean }> }) =>
    async (req: { id: string }, origin: string) => {
      const answer = await deps.requestApproval({
        type: "sign",
        origin,
        request: req,
        signer: { name: W.name, address: W.address },
        details: { message: "hi" },
      });
      if (!answer.approved)
        return { id: req.id, success: false, error: { code: "USER_REJECTED", message: "no" } };
      m.signed++;
      return { id: req.id, success: true, data: { txHash: HASH } };
    },
}));

const W = { id: "w1", name: "Spending", address: `oct${"A".repeat(44)}`, wallet_type: "mnemonic" };
const HASH = "c".repeat(64);
const ID = "1".repeat(32);

import { useSiteRelay } from "src/features/dapp/hooks/useSiteRelay";

const calls = () => m.invoke.mock.calls.map((c) => c as [string, Record<string, unknown>]);
const named = (name: string) => calls().filter(([n]) => n === name);
const fire = (name: string, payload: unknown) => m.handlers.get(name)?.({ payload });

const request = {
  id: ID,
  origin: "https://pool.example",
  topOrigin: null,
  framed: false,
  browser: "web",
  clientId: "direct",
  network: "mainnet",
  method: "send_transaction",
  params: {},
};

beforeEach(() => {
  m.handlers.clear();
  m.signed = 0;
  m.progressFails = false;
  m.details.mockReset();
  m.invoke.mockReset();
  m.invoke.mockImplementation(async (name: string, args?: Record<string, unknown>) => {
    if (name === "site_list") return [];
    if (
      name === "site_progress" &&
      m.progressFails &&
      (args?.progress as { status: string }).status === "signing"
    )
      throw new Error("This request has ended");
    if (name === "site_respond") {
      const res = args?.response as { success: boolean };
      return res.success
        ? { id: ID, method: "send_transaction", hashes: [HASH], network: "mainnet", address: null }
        : null;
    }
    return undefined;
  });
});

async function open() {
  renderHook(() => useSiteRelay());
  await waitFor(() => expect(m.handlers.has("site-request")).toBe(true));
  fire("site-request", request);
  await waitFor(() => expect(named("site_stage")).toHaveLength(1));
}

describe("a site review reports where it stands", () => {
  it("review, then signing before anything runs, then the answer, then the chain", async () => {
    m.details.mockResolvedValue({ status: "confirmed", epoch: 12 });
    await open();
    expect(named("site_stage")[0][1]).toMatchObject({ id: ID, stage: "review" });
    expect(m.signed).toBe(0);
    fire("site-answer", { id: ID });
    await waitFor(() => expect(named("site_respond")).toHaveLength(1));
    const order = calls()
      .map(([n, a]) =>
        n === "site_progress" ? `progress:${(a.progress as { status: string }).status}` : n,
      )
      .filter((n) => n !== "site_list");
    expect(order.slice(0, 3)).toEqual(["site_stage", "progress:signing", "site_respond"]);
    expect(m.signed).toBe(1);
    await waitFor(
      () =>
        expect(named("site_progress").map(([, a]) => a.progress)).toContainEqual({
          status: "confirmed",
          epoch: 12,
          receiptUnavailable: "not_contract",
        }),
      { timeout: 6_000 },
    );
  }, 10_000);

  it("a request that ended before Rust took it as running never signs", async () => {
    m.progressFails = true;
    await open();
    fire("site-answer", { id: ID });
    await waitFor(() => expect(named("site_respond")).toHaveLength(1));
    expect(m.signed).toBe(0);
    expect((named("site_respond")[0][1].response as { error: { code: string } }).error.code).toBe(
      "USER_REJECTED",
    );
  });

  it("a review that closed with its page never reports signing", async () => {
    await open();
    fire("site-dropped", { ids: [ID] });
    await waitFor(() => expect(named("site_respond")).toHaveLength(1));
    fire("site-answer", { id: ID });
    expect(named("site_progress")).toHaveLength(0);
    expect(m.signed).toBe(0);
  });

  it("a request asked about later is read from the chain once", async () => {
    m.details.mockResolvedValue({ status: "rejected", reject_reason: "nonce" });
    renderHook(() => useSiteRelay());
    await waitFor(() => expect(m.handlers.has("site-recheck")).toBe(true));
    fire("site-recheck", {
      id: ID,
      method: "send_transaction",
      hashes: [HASH],
      network: "mainnet",
      address: null,
    });
    await waitFor(() =>
      expect(named("site_progress")[0]?.[1]).toEqual({
        id: ID,
        progress: {
          status: "failed",
          code: "EXECUTION_FAILED",
          message: "Rejected on chain (nonce)",
        },
      }),
    );
    expect(m.details).toHaveBeenCalledTimes(1);
  });
});
