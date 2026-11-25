// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "src/lib/query";
import { MemoryRouter } from "src/lib/router";

const m = vi.hoisted(() => ({
  lock: vi.fn(),
  setIsLocked: vi.fn(),
  hasPassword: true,
}));

vi.mock("src/i18n/react", () => ({
  useTranslation: () => ({
    t: (k: string, o?: { count?: unknown }) => (o?.count != null ? `${k}:${o.count}` : k),
  }),
}));
vi.mock("src/contexts/useWallet", () => ({
  useWallet: () => ({
    showBalanceValues: true,
    toggleBalanceVisibility: () => {},
    setIsLocked: m.setIsLocked,
  }),
}));
vi.mock("src/services/wallet/walletBridge", () => ({
  walletBridge: { hasPassword: () => Promise.resolve(m.hasPassword), lock: m.lock },
}));
vi.mock("src/services/pvac/pvacBridge", () => ({
  pvacBridge: { destroy: () => Promise.resolve() },
}));
vi.mock("src/shared/layout/NotificationBell", () => ({ default: () => null }));

import TopBar, { updatedText } from "src/shared/layout/TopBar";

const t = (k: string, o?: Record<string, unknown>) => (o?.count != null ? `${k}:${o.count}` : k);

function Reads({ fail }: { fail?: boolean }) {
  useQuery({
    queryKey: ["balance", "devnet", "a"],
    queryFn: () => (fail ? Promise.reject(new Error("down")) : Promise.resolve(1)),
    retry: false,
  });
  return null;
}

function show(onRefresh = vi.fn(), qc = new QueryClient()) {
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Reads />
        <TopBar onRefresh={onRefresh} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { onRefresh, qc };
}

beforeEach(() => {
  m.lock.mockReset().mockResolvedValue(undefined);
  m.setIsLocked.mockReset();
  m.hasPassword = true;
});
afterEach(cleanup);

describe("updatedText", () => {
  it("counts in the coarsest unit that still moves", () => {
    const now = 1_000_000_000;
    expect(updatedText(t, now - 2_000, now)).toBe("topBar.updatedNow");
    expect(updatedText(t, now - 12_000, now)).toBe("topBar.updatedSeconds:12");
    expect(updatedText(t, now - 180_000, now)).toBe("topBar.updatedMinutes:3");
    expect(updatedText(t, now - 7_300_000, now)).toBe("topBar.updatedHours:2");
  });
});

describe("Live status", () => {
  it("shows when the reads came back and refreshes on press", async () => {
    const { onRefresh } = show();
    const status = await screen.findByRole("button", { name: /topBar\.updatedNow/ });
    fireEvent.click(status);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("ticks as time passes", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      show();
      await screen.findByRole("button", { name: /topBar\.updatedNow/ });
      await act(async () => {
        vi.advanceTimersByTime(12_000);
      });
      expect(screen.getByRole("button", { name: /topBar\.updatedSeconds:1[23]/ })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("says a read failed after it had worked, with Retry", async () => {
    const qc = new QueryClient();
    show(vi.fn(), qc);
    await screen.findByRole("button", { name: /topBar\.updatedNow/ });
    await act(async () => {
      await qc
        .fetchQuery({
          queryKey: ["balance", "devnet", "a"],
          queryFn: () => Promise.reject(new Error("down")),
          retry: false,
        })
        .catch(() => {});
    });
    expect(await screen.findByRole("button", { name: "topBar.failed. topBar.retry" })).toBeTruthy();
  });
});

describe("Lock", () => {
  it("locks with Cmd+L", async () => {
    show();
    await screen.findByRole("button", { name: "topBar.lock" });
    fireEvent.keyDown(window, { key: "l", metaKey: true });
    await waitFor(() => expect(m.lock).toHaveBeenCalledTimes(1));
    expect(m.setIsLocked).toHaveBeenCalledWith(true);
  });

  it("has no Lock and ignores Cmd+L without a password", async () => {
    m.hasPassword = false;
    show();
    await screen.findByRole("button", { name: /topBar\.updatedNow/ });
    expect(screen.queryByRole("button", { name: "topBar.lock" })).toBeNull();
    fireEvent.keyDown(window, { key: "l", metaKey: true });
    expect(m.lock).not.toHaveBeenCalled();
  });
});

describe("a stale read", () => {
  it("says when the figures were last read and offers Retry", () => {
    const onRefresh = vi.fn();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <TopBar onRefresh={onRefresh} stale={{ at: Date.now() - 240_000 }} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(screen.getByText("topBar.lastUpdatedMinutes:4")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "topBar.retry" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("says the read failed when nothing was ever read", () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <TopBar onRefresh={vi.fn()} stale={{ at: null }} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(screen.getByText("topBar.failed")).toBeTruthy();
    expect(screen.getByRole("button", { name: "topBar.retry" })).toBeTruthy();
  });
});
