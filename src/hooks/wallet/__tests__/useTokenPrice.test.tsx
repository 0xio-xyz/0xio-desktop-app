// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider, focusManager } from "src/lib/query";

vi.mock("src/lib/logger", () => ({ logger: { debug: vi.fn() } }));

import { useTokenPrice } from "src/hooks/wallet/useTokenPrice";

const m = { urls: [] as string[], ok: true, price: 2 };
const reads = (part: string) => m.urls.filter((u) => u.includes(part)).length;

function wrapper() {
  const qc = new QueryClient();
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

const run = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  m.urls = [];
  m.ok = true;
  m.price = 2;
  focusManager.setFocused(true);
  vi.stubGlobal("fetch", async (url: string) => {
    m.urls.push(url);
    if (url.includes("/chart/history"))
      return {
        ok: m.ok,
        json: async () => [
          { time: 1, value: 1 },
          { time: 2, value: 2 },
        ],
      };
    if (url.includes("/details")) return { ok: m.ok, json: async () => ({ priceChange24h: 5 }) };
    return { ok: m.ok, json: async () => ({ OCT: m.price }) };
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  focusManager.setFocused(undefined);
});

describe("useTokenPrice", () => {
  it("reads the price once for every instance and the curve only where it is asked for", async () => {
    const w = wrapper();
    const a = renderHook(() => useTokenPrice(), { wrapper: w });
    renderHook(() => useTokenPrice(), { wrapper: w });
    renderHook(() => useTokenPrice(), { wrapper: w });
    renderHook(() => useTokenPrice(), { wrapper: w });
    await run(100);
    expect(reads("/api/prices")).toBe(1);
    expect(reads("/chart/history")).toBe(0);
    expect(a.result.current.getPrice("oct")).toBe(2);
    expect(a.result.current.getPrice("OCT_24H_CHANGE")).toBe(5);
    expect(a.result.current.priceHistory).toEqual([]);

    const h = renderHook(() => useTokenPrice({ history: true }), { wrapper: w });
    renderHook(() => useTokenPrice({ history: true }), { wrapper: w });
    await run(100);
    expect(reads("/chart/history")).toBe(1);
    expect(h.result.current.priceHistory).toHaveLength(2);

    await run(60_000);
    expect(reads("/api/prices")).toBe(3);
  });

  it("stops while the window is hidden and reads once when it is back", async () => {
    renderHook(() => useTokenPrice(), { wrapper: wrapper() });
    await run(100);
    focusManager.setFocused(false);
    await run(10 * 60_000);
    expect(reads("/api/prices")).toBe(1);
    focusManager.setFocused(true);
    await run(100);
    expect(reads("/api/prices")).toBe(2);
  });

  it("reads every 5 min on the lock screen", async () => {
    renderHook(() => useTokenPrice({ slow: true }), { wrapper: wrapper() });
    await run(100);
    await run(10 * 60_000);
    expect(reads("/api/prices")).toBe(3);
  });

  it("keeps the last price and its time when a read fails", async () => {
    const { result } = renderHook(() => useTokenPrice(), { wrapper: wrapper() });
    await run(100);
    const at = result.current.updatedAt;
    expect(result.current.checked).toBe(true);
    m.ok = false;
    await run(30_000);
    expect(result.current.failed).toBe(true);
    expect(result.current.getPrice("OCT")).toBe(2);
    expect(result.current.updatedAt).toBe(at);
  });
});
