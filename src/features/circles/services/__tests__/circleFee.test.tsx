// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "src/lib/query";

const m = vi.hoisted(() => ({ read: vi.fn() }));

vi.mock("src/contexts/useWallet", () => ({ useWallet: () => ({ networkId: "devnet" }) }));
vi.mock("src/services/network/networkService", () => ({
  getRecommendedFeeStrict: (...a: unknown[]) => m.read(...a),
  FeeUnavailableError: class extends Error {
    name = "FeeUnavailable";
  },
}));

import { circleAssetB64Len } from "src/features/circles/services/circleDeploy";
import { useReviewFee } from "src/hooks/transactions/useFees";

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

beforeEach(() => {
  m.read.mockReset();
  localStorage.clear();
});
afterEach(cleanup);

describe("circle asset size", () => {
  it.each([0, 1, 2, 3, 255, 1000, 50_000])("a public asset of %i bytes matches its base64", (n) => {
    expect(circleAssetB64Len(n, false)).toBe(b64(new Uint8Array(n)).length);
  });

  it.each([0, 1, 251, 252, 253, 4096, 50_000])(
    "a sealed asset of %i bytes matches its envelope",
    async (n) => {
      const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
        "encrypt",
      ]);
      const frame = new Uint8Array(Math.ceil((4 + n) / 256) * 256);
      const cipher = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: new Uint8Array(12) },
        key,
        frame,
      );
      const envelope = new Uint8Array(5 + 12 + cipher.byteLength);
      expect(circleAssetB64Len(n, true)).toBe(b64(envelope).length);
    },
  );
});

describe("circle fees are read live", () => {
  it("the create fee is the node's deploy_circle quote", async () => {
    m.read.mockResolvedValue({ minimum: "200000", recommended: "210000", fast: "420000" });
    const { result } = renderHook(() => useReviewFee("deploy_circle", "circle_create_fee"), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.quote.status).toBe("ok"));
    expect(m.read).toHaveBeenCalledWith("deploy_circle", "devnet", undefined);
    expect(result.current.ou).toBe("210000");
  });

  it("the upload fee is priced by the encoded size and waits for a file", async () => {
    m.read.mockResolvedValue({ minimum: "40000", recommended: "40000", fast: "80000" });
    const { result, rerender } = renderHook(
      ({ len }: { len: number }) =>
        useReviewFee("circle_asset_put", "circle_upload_fee", {
          hint: len ? { encrypted_data_len: len } : undefined,
          enabled: len > 0,
        }),
      { wrapper: wrapper(), initialProps: { len: 0 } },
    );
    expect(m.read).not.toHaveBeenCalled();
    expect(result.current.ou).toBe("");
    rerender({ len: circleAssetB64Len(37_500, false) });
    await waitFor(() => expect(result.current.quote.status).toBe("ok"));
    expect(m.read).toHaveBeenCalledWith("circle_asset_put", "devnet", {
      encrypted_data_len: 50_000,
    });
    expect(result.current.ou).toBe("40000");
  });

  it("a failed read leaves no fee to sign", async () => {
    m.read.mockResolvedValue(null);
    const { result } = renderHook(() => useReviewFee("deploy_circle", "circle_create_fee"), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.quote.status).toBe("error"));
    expect(result.current.ou).toBe("");
  });
});
