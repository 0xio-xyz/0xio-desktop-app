// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "src/lib/query";
import { MemoryRouter, Route, Routes, useLocation } from "src/lib/router";

const ME = `oct${"A".repeat(44)}`;
const MIRA = `oct${"M".repeat(44)}`;
const JONAS = `oct${"J".repeat(44)}`;
const HASH = `7f3a${"1".repeat(60)}`;

const m = vi.hoisted(() => ({
  lock: vi.fn(),
  setActive: vi.fn(),
  hasPassword: vi.fn(),
  clipboard: vi.fn(),
}));

vi.mock("src/i18n/react", () => ({
  useTranslation: () => ({
    t: (k: string, o?: { name?: string; title?: string; count?: number }) =>
      o?.name ? `${o.title} ${k} ${o.name}` : o?.count != null ? `${k}:${o.count}` : k,
  }),
}));
vi.mock("src/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("src/contexts/useWallet", () => ({
  useWallet: () => ({
    activeWallet: { id: "w1", name: "Main", address: ME },
    wallets: [
      { id: "w1", name: "Main", address: ME },
      { id: "w2", name: "Savings", address: `oct${"S".repeat(44)}` },
    ],
    networkId: "devnet",
    setNetworkId: vi.fn(),
    refreshWallets: vi.fn(),
    showMessage: vi.fn(),
    setIsLocked: vi.fn(),
  }),
}));
vi.mock("src/services/network/config", async (orig) => {
  const real = await orig<typeof import("src/services/network/config")>();
  return {
    ...real,
    NETWORKS: { devnet: { ...real.NETWORKS.devnet, supportsPrivacy: true } },
  };
});
vi.mock("src/hooks/transactions/useTransactionHistory", () => ({
  useTransactionHistory: () => ({
    transactions: [
      {
        hash: HASH,
        type: "send",
        amount: 1_200_000_000,
        fee: 1000,
        from: ME,
        to: JONAS,
        timestamp: 1_760_000_000,
        status: "confirmed",
        network: "devnet",
      },
    ],
  }),
}));
vi.mock("src/services/storage/addressBookService", async (orig) => {
  const real = await orig<typeof import("src/services/storage/addressBookService")>();
  return {
    ...real,
    getContacts: () => [
      { id: "c1", label: "Mira", address: MIRA, tags: [], createdAt: 1 },
      { id: "c2", label: "Jonas", address: JONAS, tags: [], createdAt: 1 },
    ],
  };
});
vi.mock("src/services/wallet/walletBridge", () => ({
  walletBridge: { hasPassword: m.hasPassword, lock: m.lock, setActive: m.setActive },
}));
vi.mock("src/services/pvac/pvacBridge", () => ({
  pvacBridge: { destroy: () => Promise.resolve() },
}));
vi.mock("src/shared/ui/WalletAvatar", () => ({ default: () => null }));

import CommandPalette, { OPEN_COMMAND_PALETTE } from "src/shared/layout/CommandPalette";
import {
  looksLikeHash,
  rank,
  readRecent,
  rememberRecent,
  type PaletteItem,
} from "src/shared/layout/paletteSearch";

function Where() {
  const loc = useLocation();
  const state = loc.state as { recipient?: string } | null;
  return (
    <div data-testid="where">
      {loc.pathname}
      {loc.search}
      {state?.recipient ? ` to ${state.recipient}` : ""}
    </div>
  );
}

function show() {
  const qc = new QueryClient();
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/"]}>
        <CommandPalette />
        <Routes>
          <Route path="*" element={<Where />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  act(() => {
    window.dispatchEvent(new CustomEvent(OPEN_COMMAND_PALETTE));
  });
}
const field = () => screen.getByRole("textbox") as HTMLInputElement;
const rows = () => screen.getAllByRole("option");
const selected = () => rows().find((r) => r.getAttribute("aria-selected") === "true")!;

beforeEach(() => {
  localStorage.clear();
  m.hasPassword.mockReset().mockResolvedValue(true);
  m.lock.mockReset().mockResolvedValue(undefined);
  m.setActive.mockReset().mockResolvedValue(undefined);
  m.clipboard.mockReset().mockResolvedValue(undefined);
  Object.assign(navigator, { clipboard: { writeText: m.clipboard } });
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(cleanup);

describe("palette search", () => {
  const item = (id: string, label: string, group: PaletteItem["group"] = "pages") => ({
    id,
    label,
    group,
  });

  it("ranks a label that starts with the query above one that only contains it", () => {
    const out = rank([item("a", "Address book"), item("b", "Send"), item("c", "Settings")], "se");
    expect(out.map((i) => i.id)).toEqual(["b", "c"]);
  });

  it("keeps groups in their order and a pasted hash first", () => {
    const out = rank(
      [item("p", "History"), item("t", "7f3a...", "transaction"), item("c", "Hiro", "contacts")],
      "hi",
    );
    expect(out.map((i) => i.id)).toEqual(["t", "c", "p"]);
  });

  it("tells a hash from a word", () => {
    expect(looksLikeHash("7f3a91c0")).toBe(true);
    expect(looksLikeHash("0x7F3A91C0D2")).toBe(true);
    expect(looksLikeHash("mira")).toBe(false);
    expect(looksLikeHash("7f3a")).toBe(false);
  });

  it("keeps recent items per wallet and network, newest first", () => {
    rememberRecent("devnet", ME, "page:/send");
    rememberRecent("devnet", ME, "contact:x");
    rememberRecent("mainnet", ME, "page:/history");
    expect(readRecent("devnet", ME)).toEqual(["contact:x", "page:/send"]);
    expect(readRecent("mainnet", ME)).toEqual(["page:/history"]);
    expect(readRecent("devnet", MIRA)).toEqual([]);
  });
});

describe("command palette", () => {
  it("opens on Cmd+K and closes on Escape", () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <CommandPalette />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.keyDown(field(), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows actions and suggested pages before anything is typed", async () => {
    show();
    await screen.findByText("palette.lock");
    expect(screen.getByText("palette.switchWallet")).toBeTruthy();
    expect(screen.getByText("nav.send")).toBeTruthy();
    expect(screen.queryByText("nav.nfts")).toBeNull();
  });

  it("finds a contact by name and Enter opens Send with that recipient", () => {
    show();
    fireEvent.change(field(), { target: { value: "mira" } });
    expect(within(selected()).getByText("Mira")).toBeTruthy();
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByTestId("where").textContent).toBe(`/send to ${MIRA}`);
  });

  it("Cmd+Enter runs the second action and keeps the palette open for a copy", () => {
    show();
    fireEvent.change(field(), { target: { value: "mira" } });
    fireEvent.keyDown(field(), { key: "Enter", metaKey: true });
    expect(m.clipboard).toHaveBeenCalledWith(MIRA);
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("moves the selection with the arrow keys", () => {
    show();
    fireEvent.change(field(), { target: { value: "s" } });
    const first = selected().id;
    fireEvent.keyDown(field(), { key: "ArrowDown" });
    expect(selected().id).not.toBe(first);
    fireEvent.keyDown(field(), { key: "ArrowUp" });
    expect(selected().id).toBe(first);
  });

  it("puts a pasted transaction hash first and opens it in History", () => {
    show();
    fireEvent.change(field(), { target: { value: HASH.slice(0, 10) } });
    expect(rows()[0].getAttribute("aria-selected")).toBe("true");
    expect(within(rows()[0]).getByText(/Jonas/)).toBeTruthy();
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(screen.getByTestId("where").textContent).toBe(`/history?hash=${HASH}&net=devnet`);
  });

  it("steps into the wallet list and switches without signing anything", async () => {
    show();
    fireEvent.change(field(), { target: { value: "switch wallet" } });
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.change(field(), { target: { value: "sav" } });
    fireEvent.keyDown(field(), { key: "Enter" });
    await vi.waitFor(() => expect(m.setActive).toHaveBeenCalledWith("w2"));
    expect(m.lock).not.toHaveBeenCalled();
  });
});
