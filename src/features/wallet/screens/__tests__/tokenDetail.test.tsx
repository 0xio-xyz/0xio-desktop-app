// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "src/lib/router";
import { QueryClient, QueryClientProvider } from "src/lib/query";
import "src/i18n";
import type { Transaction } from "src/types/transaction";

const ME = `oct${"A".repeat(44)}`;
const FRIEND = `octkj7UC${"b".repeat(33)}o5kcRF`;
const DUSD = `octBs4zPq9w${"c".repeat(27)}kN4hTQ9xy`;
const OTHER = `octOther${"d".repeat(39)}`;
const NOW = Date.now();

const m = vi.hoisted(() => ({
  navigate: vi.fn(),
  wallet: {} as Record<string, unknown>,
  networkId: "mainnet",
  balance: {} as Record<string, unknown>,
  tokens: {} as Record<string, unknown>,
  price: {} as Record<string, unknown>,
  history: {} as Record<string, unknown>,
  topBar: {} as { onRefresh?: () => void; stale?: { at: number | null } | null },
  copied: [] as string[],
}));

vi.mock("src/lib/router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("src/lib/router")>()),
  useNavigate: () => m.navigate,
}));
vi.mock("src/contexts/useWallet", () => ({
  useWallet: () => ({ activeWallet: m.wallet, networkId: m.networkId, showBalanceValues: true }),
}));
vi.mock("src/hooks/wallet/useBalance", () => ({ useBalance: () => m.balance }));
vi.mock("src/hooks/wallet/useTokens", () => ({
  useTokens: () => m.tokens,
  peekTokenList: () => null,
}));
vi.mock("src/hooks/wallet/useTokenPrice", () => ({ useTokenPrice: () => m.price }));
vi.mock("src/hooks/transactions/useTransactionHistory", () => ({
  useTransactionHistory: () => m.history,
}));
vi.mock("src/hooks/wallet/useOns", () => ({
  useSeen: () => true,
  usePrimaryName: (address: string) => (address === FRIEND ? "0xio.oct" : null),
}));
vi.mock("src/shared/ui/WalletAvatar", () => ({ default: () => null }));
vi.mock("src/shared/layout/TopBar", () => ({
  default: (props: typeof m.topBar) => {
    m.topBar = props;
    return null;
  },
}));

import TokenDetailScreen from "src/features/wallet/screens/TokenDetailScreen";

const tx = (over: Partial<Transaction>): Transaction => ({
  hash: "h",
  type: "send",
  amount: 1_000_000,
  fee: 1000,
  from: ME,
  to: FRIEND,
  timestamp: NOW - 60_000,
  status: "confirmed",
  network: m.networkId,
  ...over,
});

const transfer = (hash: string, contract: string, ago: number): Transaction =>
  tx({
    hash,
    type: "contract_call",
    amount: 0,
    to: contract,
    timestamp: NOW - ago,
    token_transfer: {
      recipient: FRIEND,
      raw_amount: "42500000",
      contract_address: contract,
      symbol: "dUSD",
      decimals: 6,
    },
  });

const points = Array.from({ length: 11 }, (_, i) => ({
  value: 0.3 + i * 0.001,
  time: NOW - (10 - i) * 60_000,
}));

function page(url: string) {
  return (
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MemoryRouter initialEntries={[url]}>
        <TokenDetailScreen />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

const show = async (url: string) => {
  const view = render(page(url));
  await act(() => new Promise((r) => setTimeout(r, 10)));
  return view;
};

const button = (name: string) => screen.queryByRole("button", { name });

beforeEach(() => {
  m.navigate.mockReset();
  m.networkId = "mainnet";
  m.wallet = { id: "w1", name: "Wallet 1", address: ME, wallet_type: "hd" };
  m.balance = {
    publicBalance: 12_480_352_000,
    privateBalance: 3_250_500_000,
    isLoading: false,
    isRefetching: false,
    isPvacLoading: false,
    isPrivateLoading: false,
    failed: false,
    updatedAt: NOW,
    refetch: vi.fn(),
  };
  m.tokens = {
    tokens: [],
    isLoading: false,
    failed: false,
    updatedAt: NOW,
    refetch: vi.fn(),
    removeImportedToken: vi.fn(),
  };
  m.price = {
    prices: { OCT: 0.31 },
    priceHistory: points,
    getPrice: (s: string) => (s === "OCT" ? 0.31 : undefined),
    fetchHistoryRange: vi.fn(async () => points),
    checked: true,
    failed: false,
    updatedAt: NOW,
    refresh: vi.fn(async () => {}),
  };
  m.history = {
    transactions: [],
    isLoading: false,
    isRefetching: false,
    failed: false,
    updatedAt: NOW,
    refetch: vi.fn(),
  };
  m.topBar = {};
  m.copied = [];
  Object.assign(navigator, {
    clipboard: { writeText: (text: string) => (m.copied.push(text), Promise.resolve()) },
  });
});
afterEach(cleanup);

describe("OCT", () => {
  it("shows public and encrypted under one total with every action", async () => {
    await show("/token?symbol=OCT");
    expect(screen.getByTestId("token-total").textContent).toBe("15,730.852OCT");
    expect(screen.getByTestId("row-public").textContent).toContain("12,480.352");
    expect(screen.getByTestId("row-public").textContent).toContain("$3,868.91");
    expect(screen.getByTestId("row-encrypted").textContent).toContain("Encrypted");
    expect(screen.getByTestId("row-encrypted").textContent).toContain("3,250.5");

    fireEvent.click(button("Send")!);
    fireEvent.click(button("Receive")!);
    fireEvent.click(button("Encrypt")!);
    fireEvent.click(button("Decrypt")!);
    expect(m.navigate.mock.calls).toEqual([
      ["/send"],
      ["/receive"],
      ["/privacy?tab=encrypt"],
      ["/privacy?tab=decrypt"],
    ]);
  });

  it("opens both old pages as this view with the matching row filled", async () => {
    await show("/token?symbol=OCT&balance=1&logo=x");
    expect(screen.getByTestId("row-public").getAttribute("aria-current")).toBe("true");
    expect(screen.getByTestId("row-encrypted").getAttribute("aria-current")).toBeNull();
    cleanup();

    await show("/token?symbol=OCT&private=1&balance=1");
    expect(screen.getByTestId("row-public").getAttribute("aria-current")).toBeNull();
    expect(screen.getByTestId("row-encrypted").getAttribute("aria-current")).toBe("true");
    expect(button("Encrypt")).toBeTruthy();
    expect(button("Decrypt")).toBeTruthy();
    fireEvent.click(button("Send")!);
    expect(m.navigate).toHaveBeenCalledWith("/send", { state: { mode: "private" } });
  });

  it("writes the price to 6 decimals and reads the pointer in place", async () => {
    await show("/token?symbol=OCT");
    expect(screen.getByTestId("token-price").textContent).toBe("$0.310000");
    expect(screen.getByTestId("token-change").textContent).toBe("+3.3% today");
    const chart = screen.getByTestId("price-chart");
    expect(chart.parentElement!.textContent).toBe("$0.310000$0.300000");

    chart.getBoundingClientRect = () => ({ left: 0, width: 1000, top: 0, height: 400 }) as DOMRect;
    fireEvent.mouseMove(chart, { clientX: 500 });
    expect(screen.getByTestId("token-price").textContent).toBe("$0.305000");
    expect(screen.getByTestId("token-change").textContent).toMatch(/^\+1\.7%.*\d{2}:\d{2}$/);
    expect(chart.contains(screen.getByTestId("price-chart-dot"))).toBe(true);
    expect(chart.contains(screen.getByTestId("token-price"))).toBe(false);

    fireEvent.mouseLeave(chart);
    expect(screen.getByTestId("token-price").textContent).toBe("$0.310000");
  });

  it("lists OCT activity only, newest first, with names and the details link", async () => {
    m.history.transactions = [
      tx({ hash: "old", type: "receive", from: FRIEND, to: ME, timestamp: NOW - 7_200_000 }),
      transfer("tok", DUSD, 1000),
      tx({ hash: "call", type: "contract_call", amount: 0, to: OTHER }),
      tx({ hash: "enc", type: "encrypt", amount: 500_000_000, to: ME, timestamp: NOW - 60_000 }),
    ];
    await show("/token?symbol=OCT");
    const list = screen.getByTestId("token-activity");
    expect(screen.getByTestId("holdings-panel").contains(list)).toBe(true);
    const rows = within(list).getAllByTestId("activity-row");
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringMatching(/^Encrypted.*500 OCTPublic to encrypted$/),
      expect.stringMatching(/^Received.*\+1 OCT0xio\.octoctkj7UC\.\.\.o5kcRF$/),
    ]);
    expect(within(list).queryByText("Testnet")).toBeNull();
    fireEvent.click(rows[1]);
    expect(m.navigate).toHaveBeenCalledWith("/history?hash=old&net=mainnet");
  });

  it("tags testnet activity", async () => {
    m.networkId = "devnet";
    m.history.transactions = [tx({ hash: "a", network: "devnet" })];
    await show("/token?symbol=OCT");
    const row = within(screen.getByTestId("token-activity")).getByTestId("activity-row");
    expect(within(row).getByText("Testnet")).toBeTruthy();
    expect(row.textContent).toContain(`${FRIEND.slice(0, 6)}...${FRIEND.slice(-4)}`);
  });

  it("follows the balance read", async () => {
    const view = await show("/token?symbol=OCT&balance=999");
    expect(screen.getByTestId("row-public").textContent).toContain("12,480.352");
    m.balance = { ...m.balance, publicBalance: 20_000_000 };
    view.rerender(page("/token?symbol=OCT&balance=999"));
    expect(screen.getByTestId("row-public").textContent).toContain("20");
    expect(screen.getByTestId("token-total").textContent).toBe("3,270.5OCT");
  });

  it("keeps every slot while loading", async () => {
    m.balance = { ...m.balance, publicBalance: 0, privateBalance: null, isLoading: true };
    m.balance.isPvacLoading = true;
    m.price = { ...m.price, prices: {}, priceHistory: [], getPrice: () => undefined };
    m.price.checked = false;
    m.history = { ...m.history, isLoading: true };
    await show("/token?symbol=OCT");
    expect(screen.getByTestId("token-total").textContent).toBe("");
    expect(within(screen.getByTestId("token-total")).getAllByTestId("skeleton")).toHaveLength(1);
    expect(screen.queryByTestId("token-price")).toBeNull();
    expect(screen.getByTestId("chart-skeleton")).toBeTruthy();
    expect(screen.getByTestId("row-public").textContent).toBe("OCT");
    expect(screen.getByTestId("row-encrypted").textContent).toBe("OCTEncrypted");
    expect(
      within(screen.getByTestId("token-activity")).getAllByTestId("skeleton").length,
    ).toBeGreaterThan(0);
    expect(button("Send")).toBeTruthy();
    expect(button("Receive")).toBeTruthy();
    expect(button("Encrypt")).toBeTruthy();
    expect(button("Decrypt")).toBeTruthy();
    expect(m.topBar.stale).toBeNull();
  });

  it("keeps the last figures dimmed with Retry when a read fails", async () => {
    m.balance = { ...m.balance, failed: true, updatedAt: NOW - 240_000 };
    m.price = { ...m.price, failed: true, updatedAt: NOW - 120_000 };
    await show("/token?symbol=OCT");
    expect(m.topBar.stale).toEqual({ at: NOW - 240_000 });
    const total = screen.getByTestId("token-total");
    expect(total.textContent).toBe("15,730.852OCT");
    expect(total.querySelector(".opacity-40")).toBeTruthy();
    expect(screen.getByTestId("token-price").textContent).toBe("$0.310000");
    expect(screen.getByTestId("token-price").className).toContain("opacity-40");
    expect(screen.getByTestId("price-chart").closest(".opacity-40")).toBeTruthy();
    expect(button("Send")).toBeTruthy();

    m.topBar.onRefresh!();
    expect(m.balance.refetch).toHaveBeenCalled();
    expect(m.history.refetch).toHaveBeenCalled();
    expect(m.price.refresh).toHaveBeenCalled();
  });

  it("gives a watch-only wallet Receive alone", async () => {
    m.wallet = { ...m.wallet, wallet_type: "watch" };
    m.balance = { ...m.balance, privateBalance: null };
    await show("/token?symbol=OCT&private=1");
    expect(button("Send")).toBeNull();
    expect(button("Encrypt")).toBeNull();
    expect(button("Decrypt")).toBeNull();
    expect(button("Receive")).toBeTruthy();
    expect(screen.getByTestId("row-encrypted").textContent).toBe("OCTEncrypted--");
  });
});

describe("a token with no price", () => {
  const held = {
    contractAddress: DUSD,
    symbol: "dUSD",
    name: "Devnet Dollar",
    decimals: 6,
    balance: "2337500000",
    source: "imported",
  };
  const url = `/token?symbol=dUSD&contract=${DUSD}&balance=1`;

  beforeEach(() => {
    m.networkId = "devnet";
    m.tokens = { ...m.tokens, tokens: [held] };
    m.history.transactions = [
      transfer("older", DUSD, 7_200_000),
      transfer("other", OTHER, 1000),
      tx({ hash: "native", network: "devnet" }),
      transfer("newer", DUSD, 60_000),
    ].map((row) => ({ ...row, network: "devnet" }));
  });

  it("has no chart and puts its activity on the left", async () => {
    await show(url);
    expect(screen.queryByTestId("price-chart")).toBeNull();
    expect(screen.queryByTestId("chart-skeleton")).toBeNull();
    expect(screen.queryByTestId("token-price")).toBeNull();
    expect(screen.queryByRole("button", { name: "1D" })).toBeNull();
    expect(screen.getByText("No price yet")).toBeTruthy();
    const list = screen.getByTestId("token-activity");
    expect(screen.getByTestId("holdings-panel").contains(list)).toBe(false);
    expect(screen.getByRole("heading").textContent).toBe("Devnet Dollar");
  });

  it("lists this contract only, newest first, tagged Testnet", async () => {
    await show(url);
    const rows = within(screen.getByTestId("token-activity")).getAllByTestId("activity-row");
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toMatch(/^Sent−42\.5 dUSD0xio\.octoctkj7UC\.\.\.o5kcRF.*Testnet$/);
    fireEvent.click(rows[0]);
    expect(m.navigate).toHaveBeenCalledWith("/history?hash=newer&net=devnet");
    fireEvent.click(rows[1]);
    expect(m.navigate).toHaveBeenCalledWith("/history?hash=older&net=devnet");
  });

  it("reads the balance from the token read, not the link, and follows it", async () => {
    const view = await show(url);
    expect(screen.getByTestId("token-total").textContent).toBe("2,337.5dUSD");
    m.tokens = { ...m.tokens, tokens: [{ ...held, balance: "5000000" }] };
    view.rerender(page(url));
    expect(screen.getByTestId("token-total").textContent).toBe("5dUSD");
  });

  it("offers Send and Receive only and sends this token", async () => {
    await show(url);
    expect(button("Encrypt")).toBeNull();
    expect(button("Decrypt")).toBeNull();
    expect(button("Receive")).toBeTruthy();
    fireEvent.click(button("Send")!);
    expect(m.navigate).toHaveBeenCalledWith("/send", { state: { token: held } });
  });

  it("cuts the contract in the middle and copies it whole", async () => {
    await show(url);
    expect(screen.getByTestId("token-contract").textContent).toBe(
      `${DUSD.slice(0, 8)}...${DUSD.slice(-6)}`,
    );
    expect(screen.getByText("Decimals").parentElement!.textContent).toBe("Decimals6");
    expect(screen.queryByText("Standard")).toBeNull();
    fireEvent.click(button("Copy")!);
    expect(m.copied).toEqual([DUSD]);
  });

  it("removes a token the user added and no other", async () => {
    await show(url);
    fireEvent.click(button("Remove token")!);
    expect(m.tokens.removeImportedToken).toHaveBeenCalledWith(DUSD);
    expect(m.navigate).toHaveBeenCalledWith("/");
    cleanup();

    m.tokens = { ...m.tokens, tokens: [{ ...held, source: "listed" }] };
    await show(url);
    expect(button("Remove token")).toBeNull();
  });

  it("holds the balance slot while the token read loads", async () => {
    m.tokens = { ...m.tokens, tokens: [], isLoading: true };
    await show(url);
    expect(screen.getByTestId("token-total").textContent).toBe("");
    expect(button("Send")).toBeTruthy();
  });
});
