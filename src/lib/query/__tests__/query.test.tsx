// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { act, cleanup, render, renderHook, waitFor } from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
  dehydrate,
  focusManager,
  hashKey,
  persistQueryClient,
  skipToken,
  useIsFetching,
  useQueries,
  useQuery,
  useQueryClient,
} from "src/lib/query";
import { partialMatchKey, replaceEqualDeep } from "src/lib/query/core";
import { keepWithinScope } from "src/lib/query/queryScope";
import { withoutOldestQuery } from "src/lib/query/persist";

function setup(defaults: ConstructorParameters<typeof QueryClient>[0] = {}) {
  const client = new QueryClient(defaults);
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}

const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  focusManager.setFocused(undefined);
});

describe("keys", () => {
  it("hashes object keys in a stable order", () => {
    expect(hashKey(["a", { y: 1, x: 2 }])).toBe(hashKey(["a", { x: 2, y: 1 }]));
    expect(hashKey(["a", 1])).not.toBe(hashKey(["a", "1"]));
  });

  it("matches a key prefix, objects by the fields named", () => {
    expect(partialMatchKey(["balance", "octA", "devnet"], ["balance"])).toBe(true);
    expect(partialMatchKey(["balance", "octA", "devnet"], ["balance", "octB"])).toBe(false);
    expect(partialMatchKey(["fee", { op: "x", n: 1 }], ["fee", { op: "x" }])).toBe(true);
  });

  it("keeps the identity of unchanged parts", () => {
    const prev = { a: [1, 2], b: { c: 1 } };
    const same = replaceEqualDeep(prev, { a: [1, 2], b: { c: 1 } });
    expect(same).toBe(prev);
    const next = replaceEqualDeep(prev, { a: [1, 2], b: { c: 2 } });
    expect(next).not.toBe(prev);
    expect(next.a).toBe(prev.a);
  });
});

describe("useQuery", () => {
  it("shares one read between readers of the same key", async () => {
    const { wrapper } = setup();
    const read = deferred<number>();
    const fn = vi.fn(() => read.promise);
    const a = renderHook(() => useQuery({ queryKey: ["n"], queryFn: fn }), { wrapper });
    const b = renderHook(() => useQuery({ queryKey: ["n"], queryFn: fn }), { wrapper });
    expect(a.result.current.isLoading).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
    await act(async () => read.resolve(7));
    expect(a.result.current.data).toBe(7);
    expect(b.result.current.data).toBe(7);
    expect(b.result.current.status).toBe("success");
  });

  it("does not read again while fresh and reads again once stale", async () => {
    vi.useFakeTimers();
    const { wrapper } = setup();
    const fn = vi.fn(async () => 1);
    const first = renderHook(() => useQuery({ queryKey: ["s"], queryFn: fn, staleTime: 1000 }), {
      wrapper,
    });
    await act(() => vi.advanceTimersByTimeAsync(10));
    first.unmount();
    renderHook(() => useQuery({ queryKey: ["s"], queryFn: fn, staleTime: 1000 }), { wrapper });
    await act(() => vi.advanceTimersByTimeAsync(10));
    expect(fn).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(2000));
    renderHook(() => useQuery({ queryKey: ["s"], queryFn: fn, staleTime: 1000 }), { wrapper });
    await act(() => vi.advanceTimersByTimeAsync(10));
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("follows enabled: no read while off, one read when turned on", async () => {
    const { wrapper } = setup();
    const fn = vi.fn(async () => "x");
    const { result, rerender } = renderHook(
      ({ on }: { on: boolean }) => useQuery({ queryKey: ["e"], queryFn: fn, enabled: on }),
      { wrapper, initialProps: { on: false } },
    );
    expect(result.current.isPending).toBe(true);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.fetchStatus).toBe("idle");
    expect(fn).not.toHaveBeenCalled();
    rerender({ on: true });
    await waitFor(() => expect(result.current.data).toBe("x"));
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("never reads a skipToken query and still shows data another reader wrote", async () => {
    const { client, wrapper } = setup();
    const { result } = renderHook(() => useQuery({ queryKey: ["k"], queryFn: skipToken }), {
      wrapper,
    });
    expect(result.current.fetchStatus).toBe("idle");
    act(() => void client.setQueryData(["k"], [1]));
    await waitFor(() => expect(result.current.data).toEqual([1]));
  });

  it("retries as told, then reports the error and keeps the last data", async () => {
    const { client, wrapper } = setup({ defaultOptions: { queries: { retryDelay: 0 } } });
    client.setQueryData(["r"], "old");
    const fn = vi.fn(async () => {
      throw new Error("offline");
    });
    const { result } = renderHook(
      () => useQuery({ queryKey: ["r"], queryFn: fn, retry: (n) => n < 1 }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(fn).toHaveBeenCalledTimes(2);
    expect(result.current.data).toBe("old");
    expect((result.current.error as Error).message).toBe("offline");
    expect(result.current.failureCount).toBe(2);
    expect(result.current.isFetching).toBe(false);
  });

  it("treats a read that returns nothing as an error", async () => {
    const { wrapper } = setup();
    const { result } = renderHook(
      () => useQuery({ queryKey: ["u"], queryFn: async () => undefined, retry: false }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.isError).toBe(true));
  });

  it("keeps the last content within one scope while the next key loads", async () => {
    const { wrapper } = setup();
    const reads: Record<string, ReturnType<typeof deferred<number>>> = {};
    const fn = ({ queryKey }: { queryKey: readonly unknown[] }) => {
      reads[hashKey(queryKey)] = deferred<number>();
      return reads[hashKey(queryKey)].promise;
    };
    const { result, rerender } = renderHook(
      ({ addr, net, page }: { addr: string; net: string; page: number }) =>
        useQuery({
          queryKey: ["history", addr, net, page],
          queryFn: fn,
          placeholderData: keepWithinScope(addr, net),
        }),
      { wrapper, initialProps: { addr: "octA", net: "mainnet", page: 1 } },
    );
    await act(async () => reads[hashKey(["history", "octA", "mainnet", 1])].resolve(10));
    expect(result.current.data).toBe(10);

    rerender({ addr: "octA", net: "mainnet", page: 2 });
    expect(result.current.data).toBe(10);
    expect(result.current.isPlaceholderData).toBe(true);

    rerender({ addr: "octB", net: "mainnet", page: 1 });
    expect(result.current.data).toBeUndefined();
    rerender({ addr: "octA", net: "devnet", page: 1 });
    expect(result.current.data).toBeUndefined();
  });

  it("selects from the data and keeps the selection stable", async () => {
    const { client, wrapper } = setup();
    client.setQueryData(["sel"], { a: 1, b: [1, 2] });
    const { result, rerender } = renderHook(
      () =>
        useQuery({
          queryKey: ["sel"],
          queryFn: async () => ({ a: 1, b: [1, 2] }),
          staleTime: Infinity,
          select: (d) => ({ list: d.b }),
        }),
      { wrapper },
    );
    const first = result.current.data;
    rerender();
    expect(result.current.data).toBe(first);
    expect(first).toEqual({ list: [1, 2] });
  });

  it("starts from initial data and reads again when it is marked old", async () => {
    const { wrapper } = setup();
    const fn = vi.fn(async () => 2);
    const { result } = renderHook(
      () =>
        useQuery({
          queryKey: ["init"],
          queryFn: fn,
          initialData: () => 1,
          initialDataUpdatedAt: 0,
          staleTime: 60_000,
        }),
      { wrapper },
    );
    expect(result.current.data).toBe(1);
    await waitFor(() => expect(result.current.data).toBe(2));
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("refetch reads again even while fresh", async () => {
    const { wrapper } = setup();
    let n = 0;
    const { result } = renderHook(
      () => useQuery({ queryKey: ["rf"], queryFn: async () => ++n, staleTime: Infinity }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.data).toBe(1));
    await act(async () => void (await result.current.refetch()));
    expect(result.current.data).toBe(2);
  });

  it("is safe when the reader leaves before the read ends", async () => {
    const { client, wrapper } = setup();
    const read = deferred<string>();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { unmount } = renderHook(
      () => useQuery({ queryKey: ["gone"], queryFn: () => read.promise }),
      {
        wrapper,
      },
    );
    unmount();
    await act(async () => read.resolve("late"));
    expect(client.getQueryData(["gone"])).toBe("late");
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });
});

describe("window focus and intervals", () => {
  beforeEach(() => vi.useFakeTimers());

  it("reads a stale query again when the window comes back", async () => {
    const { wrapper } = setup();
    const fn = vi.fn(async () => 1);
    renderHook(() => useQuery({ queryKey: ["f"], queryFn: fn, staleTime: 1000 }), { wrapper });
    await act(() => vi.advanceTimersByTimeAsync(10));
    act(() => focusManager.setFocused(false));
    act(() => focusManager.setFocused(true));
    await act(() => vi.advanceTimersByTimeAsync(10));
    expect(fn).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(2000));
    act(() => focusManager.setFocused(false));
    act(() => focusManager.setFocused(true));
    await act(() => vi.advanceTimersByTimeAsync(10));
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does not read on focus when told not to", async () => {
    const { wrapper } = setup();
    const fn = vi.fn(async () => 1);
    renderHook(() => useQuery({ queryKey: ["nf"], queryFn: fn, refetchOnWindowFocus: false }), {
      wrapper,
    });
    await act(() => vi.advanceTimersByTimeAsync(10));
    act(() => focusManager.setFocused(false));
    act(() => focusManager.setFocused(true));
    await act(() => vi.advanceTimersByTimeAsync(10));
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("polls only while the window is shown unless told otherwise", async () => {
    const { wrapper } = setup();
    const fg = vi.fn(async () => 1);
    const bg = vi.fn(async () => 1);
    renderHook(() => useQuery({ queryKey: ["fg"], queryFn: fg, refetchInterval: 1000 }), {
      wrapper,
    });
    renderHook(
      () =>
        useQuery({
          queryKey: ["bg"],
          queryFn: bg,
          refetchInterval: 1000,
          refetchIntervalInBackground: true,
        }),
      { wrapper },
    );
    await act(() => vi.advanceTimersByTimeAsync(10));
    act(() => focusManager.setFocused(false));
    await act(() => vi.advanceTimersByTimeAsync(3500));
    expect(fg).toHaveBeenCalledTimes(1);
    expect(bg).toHaveBeenCalledTimes(4);
  });

  it("readers of one query share each poll", async () => {
    const { wrapper } = setup();
    const fn = vi.fn(async () => 1);
    const opts = { queryKey: ["poll"], queryFn: fn, refetchInterval: 1000 };
    renderHook(() => useQuery(opts), { wrapper });
    renderHook(() => useQuery(opts), { wrapper });
    await act(() => vi.advanceTimersByTimeAsync(3100));
    expect(fn).toHaveBeenCalledTimes(4);
  });
});

describe("QueryClient", () => {
  it("setQueryData takes a value or an updater, and skips undefined", () => {
    const client = new QueryClient();
    client.setQueryData(["c"], 1);
    client.setQueryData<number>(["c"], (old) => (old ?? 0) + 1);
    expect(client.getQueryData(["c"])).toBe(2);
    client.setQueryData(["c"], () => undefined);
    expect(client.getQueryData(["c"])).toBe(2);
  });

  it("reads every query under a prefix and removes them", () => {
    const client = new QueryClient();
    client.setQueryData(["tokens", "octA", "mainnet"], ["a"]);
    client.setQueryData(["tokens", "octA", "devnet"], ["b"]);
    client.setQueryData(["balance", "octA", "mainnet"], 1);
    expect(client.getQueriesData({ queryKey: ["tokens", "octA"] })).toHaveLength(2);
    client.removeQueries({ queryKey: ["tokens"] });
    expect(client.getQueryData(["tokens", "octA", "mainnet"])).toBeUndefined();
    expect(client.getQueryData(["balance", "octA", "mainnet"])).toBe(1);
  });

  it("invalidates every match and reads again only the ones on screen", async () => {
    const { client, wrapper } = setup();
    const shown = vi.fn(async () => 1);
    const hidden = vi.fn(async () => 1);
    renderHook(() => useQuery({ queryKey: ["bal", "a"], queryFn: shown, staleTime: Infinity }), {
      wrapper,
    });
    await waitFor(() => expect(shown).toHaveBeenCalledTimes(1));
    await client.fetchQuery({ queryKey: ["bal", "b"], queryFn: hidden });
    await act(() => client.invalidateQueries({ queryKey: ["bal"] }));
    expect(shown).toHaveBeenCalledTimes(2);
    expect(hidden).toHaveBeenCalledTimes(1);
    expect(client.getQueryCache().find({ queryKey: ["bal", "b"] })?.state.isInvalidated).toBe(true);
  });

  it("refetches by exact key and by predicate", async () => {
    const { client, wrapper } = setup();
    const one = vi.fn(async () => 1);
    const two = vi.fn(async () => 2);
    renderHook(() => useQuery({ queryKey: ["x", 1], queryFn: one, staleTime: Infinity }), {
      wrapper,
    });
    renderHook(() => useQuery({ queryKey: ["x", 1, "more"], queryFn: two, staleTime: Infinity }), {
      wrapper,
    });
    await waitFor(() => expect(two).toHaveBeenCalledTimes(1));
    await act(() => client.refetchQueries({ queryKey: ["x", 1], exact: true }));
    expect(one).toHaveBeenCalledTimes(2);
    expect(two).toHaveBeenCalledTimes(1);
    await act(() => client.refetchQueries({ predicate: (q) => q.queryKey.length === 3 }));
    expect(two).toHaveBeenCalledTimes(2);
  });

  it("does not refetch a disabled query", async () => {
    const { client, wrapper } = setup();
    const fn = vi.fn(async () => 1);
    renderHook(() => useQuery({ queryKey: ["off"], queryFn: fn, enabled: false }), { wrapper });
    await act(() => client.refetchQueries({ queryKey: ["off"] }));
    expect(fn).not.toHaveBeenCalled();
  });

  it("drops a query nobody reads once its gc time passes", async () => {
    vi.useFakeTimers();
    const { client, wrapper } = setup();
    const { unmount } = renderHook(
      () => useQuery({ queryKey: ["gc"], queryFn: async () => 1, gcTime: 1000 }),
      { wrapper },
    );
    await act(() => vi.advanceTimersByTimeAsync(10));
    expect(client.getQueryData(["gc"])).toBe(1);
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(client.getQueryData(["gc"])).toBe(1);
    unmount();
    await act(() => vi.advanceTimersByTimeAsync(999));
    expect(client.getQueryData(["gc"])).toBe(1);
    await act(() => vi.advanceTimersByTimeAsync(2));
    expect(client.getQueryData(["gc"])).toBeUndefined();
  });

  it("tells cache subscribers about updates", async () => {
    const client = new QueryClient();
    const events: string[] = [];
    client.getQueryCache().subscribe((e) => events.push(`${e.type}:${e.query.queryKey[0]}`));
    client.setQueryData(["w"], 1);
    await Promise.resolve();
    expect(events).toEqual(["added:w", "updated:w"]);
  });
});

describe("useQueries and useIsFetching", () => {
  it("reads a list of queries and counts what is loading", async () => {
    const { wrapper } = setup();
    const reads = [deferred<number>(), deferred<number>()];
    function Probe() {
      const results = useQueries({
        queries: [0, 1].map((i) => ({ queryKey: ["q", i], queryFn: () => reads[i].promise })),
      });
      const loading = useIsFetching({ predicate: (q) => q.queryKey[0] === "q" });
      return (
        <p data-testid="out">
          {results.map((r) => r.data ?? "-").join(",")}|{loading}
        </p>
      );
    }
    const view = render(<Probe />, { wrapper });
    await waitFor(() => expect(view.getByTestId("out").textContent).toBe("-,-|2"));
    await act(async () => reads[0].resolve(5));
    await waitFor(() => expect(view.getByTestId("out").textContent).toBe("5,-|1"));
    await act(async () => reads[1].resolve(6));
    await waitFor(() => expect(view.getByTestId("out").textContent).toBe("5,6|0"));
  });

  it("useQueryClient needs a provider", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => renderHook(() => useQueryClient())).toThrow(/QueryClientProvider/);
    errors.mockRestore();
  });
});

describe("persistence", () => {
  const options = (storage: Storage) => ({
    storage,
    key: "cache",
    buster: "v2",
    maxAge: 60_000,
    shouldPersist: (q: { queryKey: readonly unknown[]; state: { status: string } }) =>
      q.state.status === "success" && q.queryKey[0] !== "secret",
    throttleMs: 10,
  });

  beforeEach(() => localStorage.clear());

  it("saves successful queries, leaves the excluded ones out, and restores them", async () => {
    vi.useFakeTimers();
    const a = new QueryClient();
    persistQueryClient(a, options(localStorage));
    a.setQueryData(["balance", "octA", "mainnet"], { balance: 5 });
    a.setQueryData(["secret", "octA"], "cs-secret");
    await vi.advanceTimersByTimeAsync(20);
    const raw = localStorage.getItem("cache")!;
    expect(raw).toContain('"balance"');
    expect(raw).not.toContain("cs-secret");

    const b = new QueryClient();
    persistQueryClient(b, options(localStorage));
    expect(b.getQueryData(["balance", "octA", "mainnet"])).toEqual({ balance: 5 });
    expect(
      b.getQueryCache().find({ queryKey: ["balance", "octA", "mainnet"] })?.state.fetchStatus,
    ).toBe("idle");
  });

  it("drops a blob from another buster or older than max age", () => {
    const client = new QueryClient();
    client.setQueryData(["x"], 1);
    const blob = (buster: string, timestamp: number) =>
      JSON.stringify({ buster, timestamp, clientState: dehydrate(client) });

    localStorage.setItem("cache", blob("v1", Date.now()));
    const a = new QueryClient();
    persistQueryClient(a, options(localStorage));
    expect(a.getQueryData(["x"])).toBeUndefined();
    expect(localStorage.getItem("cache")).toBeNull();

    localStorage.setItem("cache", blob("v2", Date.now() - 120_000));
    const b = new QueryClient();
    persistQueryClient(b, options(localStorage));
    expect(b.getQueryData(["x"])).toBeUndefined();
  });

  it("drops the oldest query until the save fits", async () => {
    vi.useFakeTimers();
    let limit = Infinity;
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        if (v.length > limit) throw new Error("QuotaExceededError");
        store.set(k, v);
      },
      removeItem: (k: string) => void store.delete(k),
    } as unknown as Storage;
    const client = new QueryClient();
    persistQueryClient(client, options(storage));
    client.setQueryData(["old"], "x".repeat(2000), { updatedAt: 1 });
    client.setQueryData(["new"], "y", { updatedAt: 2 });
    limit = 1500;
    await vi.advanceTimersByTimeAsync(20);
    const saved = JSON.parse(store.get("cache")!);
    expect(saved.clientState.queries.map((q: { queryKey: string[] }) => q.queryKey[0])).toEqual([
      "new",
    ]);
    expect(
      withoutOldestQuery({ buster: "", timestamp: 0, clientState: { mutations: [], queries: [] } }),
    ).toBeUndefined();
  });
});
