import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFetch = vi.fn();
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (...args: unknown[]) => mockFetch(...args),
}));

vi.mock("src/lib/logger", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    timed: vi.fn(async (_tag: string, _label: string, fn: () => Promise<unknown>) => fn()),
  },
}));

vi.mock("src/services/wallet/walletBridge", () => ({
  walletBridge: {
    signMessage: vi.fn(async () => "sig"),
    getPublicKey: vi.fn(async () => "pub"),
  },
}));

import * as networkService from "src/services/network/networkService";
import { buildTransferTx, broadcastSignedTx } from "src/services/network/transactionBuilder";

type Handler = (url: string, method: string, params: unknown[]) => unknown;

function routeRpc(handler: Handler) {
  mockFetch.mockImplementation(async (url: string, init: { body: string }) => {
    const body = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({
        jsonrpc: "2.0",
        id: body.id,
        result: handler(url, body.method, body.params),
      }),
    };
  });
}

function submitCalls(): string[] {
  return mockFetch.mock.calls
    .filter(([, init]) => JSON.parse(init.body).method === "octra_submit")
    .map(([url]) => url as string);
}

beforeEach(() => {
  mockFetch.mockReset();
  networkService.setNetwork("devnet");
  networkService.setActiveAddress("octA");
});

describe("broadcast pin", () => {
  beforeEach(() => {
    routeRpc((_url, method) =>
      method === "octra_balance" ? { nonce: 1, pending_nonce: 1 } : { hash: "0xhash" },
    );
  });

  async function signedOnDevnet() {
    const scope = networkService.captureScope("octA");
    const tx = await buildTransferTx({
      from: "octA",
      to: "octB",
      amount: 1_000_000,
      walletId: "w1",
      ou: "3000",
      scope,
    });
    return { scope, tx };
  }

  it("submits to the pinned network when nothing changed", async () => {
    const { scope, tx } = await signedOnDevnet();
    await expect(broadcastSignedTx(tx, scope)).resolves.toMatch(/^[0-9a-f]{64}$/);
    expect(submitCalls()).toEqual([networkService.rpcUrlFor("devnet")]);
  });

  it("refuses after a network switch and sends nothing", async () => {
    const { scope, tx } = await signedOnDevnet();
    networkService.setNetwork("mainnet");
    await expect(broadcastSignedTx(tx, scope)).rejects.toMatchObject({
      name: "ScopeChanged",
    });
    expect(submitCalls()).toEqual([]);
  });

  it("refuses after a wallet switch and sends nothing", async () => {
    const { scope, tx } = await signedOnDevnet();
    networkService.setActiveAddress("octB");
    await expect(broadcastSignedTx(tx, scope)).rejects.toMatchObject({
      name: "ScopeChanged",
    });
    expect(submitCalls()).toEqual([]);
  });

  it("refuses to sign once the network moved during the flow", async () => {
    const scope = networkService.captureScope("octA");
    networkService.setNetwork("mainnet");
    await expect(
      buildTransferTx({ from: "octA", to: "octB", amount: 1, walletId: "w1", scope }),
    ).rejects.toMatchObject({ name: "ScopeChanged" });
  });

  it("refuses a tx whose sender is not the pinned wallet", async () => {
    const scope = networkService.captureScope("octA");
    const tx = { from: "octB", to_: "octC", amount: "1", nonce: 1, ou: "1000", timestamp: 1 };
    await expect(networkService.submitTransaction(tx, scope)).rejects.toMatchObject({
      name: "ScopeChanged",
    });
    expect(submitCalls()).toEqual([]);
  });
});

describe("nonce tracking", () => {
  it("is kept per network for the same address", async () => {
    const devnetUrl = networkService.rpcUrlFor("devnet");
    routeRpc((url) =>
      url === devnetUrl ? { nonce: 10, pending_nonce: 12 } : { nonce: 2, pending_nonce: 3 },
    );
    expect(await networkService.getNextNonce("octA", "devnet")).toBe(13);
    expect(await networkService.getNextNonce("octA", "mainnet")).toBe(4);
    expect(await networkService.getNextNonce("octA", "devnet")).toBe(14);
  });

  it("does not carry a local nonce across a network switch", async () => {
    const devnetUrl = networkService.rpcUrlFor("devnet");
    routeRpc((url) =>
      url === devnetUrl ? { nonce: 10, pending_nonce: 12 } : { nonce: 2, pending_nonce: 3 },
    );
    expect(await networkService.getNextNonce("octA")).toBe(13);
    networkService.setNetwork("mainnet");
    expect(await networkService.getNextNonce("octA")).toBe(4);
  });
});

describe("fee cache", () => {
  it("is kept per network", async () => {
    const devnetUrl = networkService.rpcUrlFor("devnet");
    routeRpc((url) =>
      url === devnetUrl
        ? { minimum: "1", recommended: "1", fast: "1" }
        : { minimum: "9", recommended: "9", fast: "9" },
    );
    expect((await networkService.getRecommendedFeeStrict("call", "devnet"))?.recommended).toBe("1");
    expect((await networkService.getRecommendedFeeStrict("call", "mainnet"))?.recommended).toBe(
      "9",
    );
  });
});

describe("strict fee reads", () => {
  it("returns null, never a default, when the node fails", async () => {
    mockFetch.mockRejectedValue(new Error("offline"));
    vi.useFakeTimers();
    const fee = networkService.getRecommendedFeeStrict("stealth", "devnet");
    await vi.runAllTimersAsync();
    vi.useRealTimers();
    expect(await fee).toBeNull();
  });

  it("returns null for an answer without a usable fee", async () => {
    routeRpc(() => ({ recommended: "0" }));
    expect(await networkService.getRecommendedFeeStrict("encrypt", "devnet")).toBeNull();
    routeRpc(() => null);
    expect(await networkService.getRecommendedFeeStrict("encrypt", "devnet")).toBeNull();
  });

  it("reads the network it is asked for", async () => {
    const mainnetUrl = networkService.rpcUrlFor("mainnet");
    routeRpc((url) =>
      url === mainnetUrl
        ? { minimum: "1200000", recommended: "1200000", fast: "1200000" }
        : { minimum: "1000000", recommended: "1000000", fast: "1000000" },
    );
    expect(await networkService.getRecommendedFeeStrict("stealth", "mainnet")).toEqual({
      minimum: "1200000",
      recommended: "1200000",
      fast: "1200000",
    });
  });

  it("never answers a failed fee read with a made-up fee", async () => {
    mockFetch.mockImplementation(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body);
      if (body.params[0] === "claim") throw new Error("busy");
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({
          jsonrpc: "2.0",
          id: body.id,
          result: { minimum: "5000", recommended: "5000", fast: "5000" },
        }),
      };
    });
    vi.useFakeTimers();
    const strict = networkService.getRecommendedFeeStrict("claim", "devnet2");
    const live = expect(networkService.liveRecommendedOu("claim", "devnet2")).rejects.toMatchObject(
      {
        name: "FeeUnavailable",
      },
    );
    await vi.runAllTimersAsync();
    vi.useRealTimers();
    expect(await strict).toBeNull();
    await live;
    expect(await networkService.liveRecommendedOu("standard", "devnet2")).toBe("5000");
  });
});
