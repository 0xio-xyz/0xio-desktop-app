// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "src/lib/query";

const m = vi.hoisted(() => ({
  auth: vi.fn(),
  read: vi.fn(),
  preview: vi.fn(),
  deploy: vi.fn(),
  call: vi.fn(),
}));

const SCOPE = { address: `oct${"A".repeat(44)}`, networkId: "devnet" };

vi.mock("src/contexts/useWallet", () => ({ useWallet: () => ({ networkId: "devnet" }) }));
vi.mock("src/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("src/services/network/networkService", () => ({
  getRecommendedFeeStrict: (...a: unknown[]) => m.read(...a),
  captureScope: () => SCOPE,
  FeeUnavailableError: class extends Error {
    name = "FeeUnavailable";
  },
}));
vi.mock("src/services/contracts/contractService", () => ({
  previewDeploy: (...a: unknown[]) => m.preview(...a),
  deployContract: (...a: unknown[]) => m.deploy(...a),
  callContract: (...a: unknown[]) => m.call(...a),
}));
vi.mock("src/services/pvac/pvacBridge", () => ({ pvacBridge: { isInitialized: () => false } }));
vi.mock("src/hooks/transactions/useTransactionAuth", () => ({
  useTransactionAuth: () => ({
    isOpen: false,
    title: "",
    requestAuth: m.auth,
    handleResult: () => {},
  }),
}));

import {
  chosenDeployOu,
  deployQuote,
  ideDeployOu,
  useDeployReview,
} from "src/features/contracts/hooks/useDeployReview";
import { useContractInteraction } from "src/features/contracts/hooks/useContractInteraction";
import { FEE_CHANGED } from "src/services/transactions/feeCopy";

const LIVE = { minimum: "200000", recommended: "260000", fast: "520000" };
const CALL_LIVE = { minimum: "1000", recommended: "1700", fast: "3400" };
const CODE = btoa("x".repeat(3000));
const CONTRACT = `oct${"D".repeat(44)}`;

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

beforeEach(() => {
  m.auth.mockReset().mockResolvedValue(true);
  vi.clearAllMocks();
  localStorage.clear();
  m.preview.mockResolvedValue({ nonce: 4, contractAddress: CONTRACT });
  m.deploy.mockResolvedValue({ txHash: "h", contractAddress: CONTRACT });
  m.call.mockResolvedValue("callhash");
});
afterEach(cleanup);

describe("ideDeployOu", () => {
  it("has no fee without a live read", () => {
    expect(ideDeployOu(CODE, null)).toBe("");
  });

  it("takes the node's minimum only at 1, 2 or 5 times the size rule", () => {
    expect(ideDeployOu(CODE, LIVE)).toBe("204000");
    expect(ideDeployOu(CODE, { ...LIVE, minimum: "408000", recommended: "408000" })).toBe("408000");
    expect(ideDeployOu(CODE, { ...LIVE, minimum: "1020000", recommended: "1020000" })).toBe(
      "1020000",
    );
    expect(ideDeployOu(CODE, { ...LIVE, minimum: "300000" })).toBe("204000");
  });
});

describe("deploy fee choice", () => {
  it("signs a custom fee at or above the required fee, never less", () => {
    expect(chosenDeployOu("204000", "")).toBe("204000");
    expect(chosenDeployOu("204000", "300000")).toBe("300000");
    expect(chosenDeployOu("204000", "100000")).toBe("204000");
    expect(chosenDeployOu("204000", "99999999999")).toBe("204000");
    expect(chosenDeployOu("", "300000")).toBe("");
  });

  it("offers the required fee as Default", () => {
    const q = deployQuote(
      {
        status: "ok",
        fee: { minimum: "200000", recommended: "260000", fast: "520000" },
        last: null,
        retry: () => {},
      },
      "204000",
    );
    expect(q.fee).toEqual({ minimum: "204000", recommended: "204000" });
  });

  it("signs a custom fee on a v2 program", async () => {
    const PAYLOAD = btoa("p".repeat(9000));
    m.read.mockResolvedValue(LIVE);
    const { result } = renderHook(() => useDeployReview(SCOPE.address, "w1", PAYLOAD, true), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.quote.status).toBe("ok"));
    act(() => result.current.setOU("400000"));
    await act(() => result.current.open({ bytecodeB64: CODE, deployPayload: PAYLOAD }));
    await act(async () => {
      await result.current.confirm();
    });
    expect(m.deploy).toHaveBeenCalledWith(
      expect.objectContaining({ deployPayload: PAYLOAD, ou: "400000" }),
    );
  });

  it("signs the chosen v1 fee after review", async () => {
    m.read.mockResolvedValue(LIVE);
    const { result } = renderHook(() => useDeployReview(SCOPE.address, "w1", CODE), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.quote.status).toBe("ok"));
    act(() => result.current.setOU("300000"));
    await act(() => result.current.open({ bytecodeB64: CODE }));
    await act(async () => {
      await result.current.confirm();
    });
    expect(m.deploy).toHaveBeenCalledWith(expect.objectContaining({ ou: "300000" }));
  });
});

describe("editor deploy", () => {
  it("cannot sign while the fee is being read", async () => {
    m.read.mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useDeployReview(SCOPE.address, "w1", CODE), {
      wrapper: wrapper(),
    });
    await act(() => result.current.open({ bytecodeB64: CODE }));
    expect(result.current.review).not.toBeNull();
    expect(result.current.quote.status).toBe("loading");
    expect(result.current.ou).toBe("");
    await act(async () => {
      expect(await result.current.confirm()).toBeNull();
    });
    expect(m.deploy).not.toHaveBeenCalled();
  });

  it("signs the live fee the review showed, with the reviewed address", async () => {
    m.read.mockResolvedValue(LIVE);
    const { result } = renderHook(() => useDeployReview(SCOPE.address, "w1", CODE), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.quote.status).toBe("ok"));
    await act(() => result.current.open({ bytecodeB64: CODE, constructorParams: "[1]" }));
    await act(async () => {
      await result.current.confirm();
    });
    expect(m.read).toHaveBeenCalledWith("program_deploy", "devnet", {
      encrypted_data_len: CODE.length,
    });
    expect(m.deploy).toHaveBeenCalledWith(
      expect.objectContaining({
        ou: "204000",
        constructorParams: "[1]",
        reviewed: { nonce: 4, contractAddress: CONTRACT },
      }),
    );
    expect(m.deploy.mock.calls[0][0].ou).not.toBe("50000000");
  });

  it("prices and signs a v2 program package as its payload", async () => {
    const PAYLOAD = btoa("p".repeat(9000));
    m.read.mockResolvedValue(LIVE);
    const { result } = renderHook(() => useDeployReview(SCOPE.address, "w1", PAYLOAD), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.quote.status).toBe("ok"));
    await act(() => result.current.open({ bytecodeB64: CODE, deployPayload: PAYLOAD }));
    await act(async () => {
      await result.current.confirm();
    });
    expect(m.read).toHaveBeenCalledWith("program_deploy", "devnet", {
      encrypted_data_len: PAYLOAD.length,
    });
    expect(m.deploy).toHaveBeenCalledWith(
      expect.objectContaining({ bytecodeB64: CODE, deployPayload: PAYLOAD, ou: "212000" }),
    );
  });

  it("signs nothing when the Touch ID or password step is refused", async () => {
    m.read.mockResolvedValue(LIVE);
    m.auth.mockResolvedValue(false);
    const { result } = renderHook(() => useDeployReview(SCOPE.address, "w1", CODE), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.quote.status).toBe("ok"));
    await act(() => result.current.open({ bytecodeB64: CODE, constructorParams: "[1]" }));
    await act(async () => {
      await result.current.confirm();
    });
    expect(m.auth).toHaveBeenCalledTimes(1);
    expect(m.deploy).not.toHaveBeenCalled();
  });

  it("asks again when the live minimum moved above the reviewed fee", async () => {
    m.read
      .mockResolvedValueOnce(LIVE)
      .mockResolvedValue({ ...LIVE, minimum: "300000", recommended: "320000" });
    const { result } = renderHook(() => useDeployReview(SCOPE.address, "w1", CODE), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.quote.status).toBe("ok"));
    await act(() => result.current.open({ bytecodeB64: CODE }));
    await act(async () => {
      await result.current.confirm();
    });
    expect(result.current.error).toBe(FEE_CHANGED);
    expect(result.current.review).not.toBeNull();
    expect(m.deploy).not.toHaveBeenCalled();
  });
});

describe("editor contract call", () => {
  const setup = () =>
    renderHook(
      () =>
        useContractInteraction({
          address: SCOPE.address,
          ensurePvac: async () => {},
          walletId: "w1",
          showMessage: vi.fn(),
        }),
      { wrapper: wrapper() },
    );

  it("shows a review first and signs nothing while the fee is unknown", async () => {
    m.read.mockResolvedValue(null);
    const { result } = setup();
    act(() => {
      result.current.setContractAddr(CONTRACT);
      result.current.setMethodName("bump");
    });
    await act(() => result.current.openCallReview());
    expect(result.current.callReview).toMatchObject({ contract: CONTRACT, method: "bump" });
    await waitFor(() => expect(result.current.feeQuote.status).toBe("error"));
    expect(result.current.ou).toBe("");
    await act(() => result.current.confirmCall());
    expect(m.call).not.toHaveBeenCalled();
  });

  it("signs the live call fee, not a constant", async () => {
    m.read.mockResolvedValue(CALL_LIVE);
    const { result } = setup();
    act(() => {
      result.current.setContractAddr(CONTRACT);
      result.current.setMethodName("bump");
    });
    await waitFor(() => expect(result.current.feeQuote.status).toBe("ok"));
    await act(() => result.current.openCallReview());
    await act(() => result.current.confirmCall());
    expect(m.read).toHaveBeenCalledWith("call", "devnet", undefined);
    expect(m.call).toHaveBeenCalledWith(
      expect.objectContaining({ contract: CONTRACT, method: "bump", ou: "1700" }),
    );
    expect(result.current.callReview).toBeNull();
  });
});
