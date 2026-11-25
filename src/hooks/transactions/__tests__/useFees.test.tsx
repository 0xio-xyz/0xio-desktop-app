// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "src/lib/query";

const m = vi.hoisted(() => ({ read: vi.fn(), network: "mainnet" }));

vi.mock("src/contexts/useWallet", () => ({ useWallet: () => ({ networkId: m.network }) }));
vi.mock("src/services/network/networkService", () => ({
  getRecommendedFeeStrict: (...a: unknown[]) => m.read(...a),
  FeeUnavailableError: class extends Error {
    name = "FeeUnavailable";
  },
}));

import { feeQueryOptions, recheckReviewedFee, useFee } from "src/hooks/transactions/useFees";
import { FEE_CHANGED, FEE_UNAVAILABLE } from "src/services/transactions/feeCopy";

const LIVE = { minimum: "900000", recommended: "1200000", fast: "1500000" };

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

beforeEach(() => {
  m.read.mockReset();
  m.network = "mainnet";
});
afterEach(cleanup);

describe("useFee", () => {
  it("has no fee at all while the read runs", () => {
    m.read.mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useFee("claim"), { wrapper: wrapper() });
    expect(result.current).toMatchObject({ status: "loading", fee: null, last: null });
  });

  it("reports an error, never a made-up fee, when the read fails", async () => {
    m.read.mockResolvedValue(null);
    const { result } = renderHook(() => useFee("stealth"), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.fee).toBeNull();
    expect(result.current.last).toBeNull();
  });

  it("gives the live fee once read, and retry reads again", async () => {
    m.read.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValue(LIVE);
    const { result } = renderHook(() => useFee("standard"), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.status).toBe("error"));
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.status).toBe("ok"));
    expect(result.current.fee).toEqual(LIVE);
    expect(m.read).toHaveBeenLastCalledWith("standard", "mainnet", undefined);
  });

  it("reads a size-priced op with its payload length, and only once it is known", async () => {
    m.read.mockResolvedValue(LIVE);
    const { result, rerender } = renderHook(
      ({ len }: { len: number }) =>
        useFee("circle_asset_put", {
          hint: { encrypted_data_len: len },
          enabled: len > 0,
        }),
      { wrapper: wrapper(), initialProps: { len: 0 } },
    );
    expect(m.read).not.toHaveBeenCalled();
    rerender({ len: 4096 });
    await waitFor(() => expect(result.current.status).toBe("ok"));
    expect(m.read).toHaveBeenCalledWith("circle_asset_put", "mainnet", {
      encrypted_data_len: 4096,
    });
  });
});

describe("shared fee cache", () => {
  it("reads once for every reader of the same network and op", async () => {
    m.read.mockResolvedValue(LIVE);
    const w = wrapper();
    const a = renderHook(() => useFee("standard"), { wrapper: w });
    const b = renderHook(() => useFee("standard"), { wrapper: w });
    await waitFor(() => expect(b.result.current.status).toBe("ok"));
    expect(a.result.current.fee).toEqual(LIVE);
    expect(m.read).toHaveBeenCalledTimes(1);

    renderHook(() => useFee("stealth"), { wrapper: w });
    m.network = "devnet";
    renderHook(() => useFee("standard"), { wrapper: w });
    await waitFor(() => expect(m.read).toHaveBeenCalledTimes(3));
  });

  it("keys by network, op and payload length", () => {
    expect(feeQueryOptions("standard", "mainnet").queryKey).toEqual([
      "fee",
      "mainnet",
      "standard",
      null,
    ]);
    expect(feeQueryOptions("deploy", "devnet", { encrypted_data_len: 9 }).queryKey).toEqual([
      "fee",
      "devnet",
      "deploy",
      9,
    ]);
  });

  it("rechecks against the node, never the cached quote", async () => {
    m.read.mockResolvedValue(LIVE);
    const { result } = renderHook(() => useFee("claim"), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.status).toBe("ok"));
    expect(m.read).toHaveBeenCalledTimes(1);

    m.read.mockResolvedValue({ ...LIVE, minimum: "1300000", recommended: "1400000" });
    const r = await recheckReviewedFee("claim", "mainnet", LIVE.recommended);
    expect(m.read).toHaveBeenCalledTimes(2);
    expect(r.error).toBe(FEE_CHANGED);
    expect(r.live?.ou).toBe(1_400_000);
  });
});

describe("recheckReviewedFee", () => {
  it("keeps the reviewed fee while the live minimum is not above it", async () => {
    m.read.mockResolvedValue(LIVE);
    expect((await recheckReviewedFee("claim", "mainnet", "1000000")).error).toBeNull();
  });

  it("asks again when the live minimum moved above the reviewed fee", async () => {
    m.read.mockResolvedValue({ ...LIVE, minimum: "1100000" });
    const r = await recheckReviewedFee("claim", "mainnet", "1000000");
    expect(r.error).toBe(FEE_CHANGED);
    expect(r.live?.ou).toBe(1_200_000);
  });

  it("refuses when the fee cannot be read", async () => {
    m.read.mockResolvedValue(null);
    expect((await recheckReviewedFee("claim", "mainnet", "1000000")).error).toBe(FEE_UNAVAILABLE);
  });
});
