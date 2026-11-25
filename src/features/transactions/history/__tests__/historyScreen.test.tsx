// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "src/lib/query";
import { MemoryRouter } from "src/lib/router";
import type { Transaction } from "src/types/transaction";

const ME = "oct2qyupyPfAof4kJ8LcTdN7fyQkLxiKhfemLCz94NNoxio";
const MARKET = "octGoeTjaF8MiKTP5ad5FJfWMCZmmEdnrfxTow6UUVmBj6h";
const VAULT = "octHqBuw3TGsgeGpu6GiumRTjQwc8VCRAo1ANhy5zL4ZVPc";
const NOW = Date.now();

const m = vi.hoisted(() => ({
  wallet: {
    activeWallet: { id: "w1", name: "Main", address: "" },
    networkId: "mainnet",
    setNetworkId: vi.fn(),
    showMessage: vi.fn(),
  },
  history: {} as Record<string, unknown[]>,
  staging: {} as Record<string, unknown[]>,
  details: {} as Record<string, unknown>,
  rpc: vi.fn(),
  calls: [] as unknown[][],
}));

vi.mock("src/contexts/useWallet", () => ({ useWallet: () => m.wallet }));
vi.mock("src/shared/layout/TopBar", () => ({ default: () => null }));
vi.mock("src/hooks/wallet/useTokens", () => ({ peekTokenList: () => null }));
vi.mock("src/services/network/networkService", () => ({
  getTransactionHistory: async (_a: string, _l: number, _o: number, net: string) => ({
    transactions: (m.history[net] ?? []).map((tx) => ({ ...(tx as object), network: net })),
    hasMore: false,
  }),
  getStagingView: async (net: string) => m.staging[net] ?? [],
  getContractStorage: async () => null,
  getTransactionDetails: async (hash: string, net: string) => m.details[`${net}:${hash}`] ?? null,
  jsonRpcCallOn: (...args: unknown[]) => {
    m.calls.push(args);
    return m.rpc(...args);
  },
}));

import "src/i18n";
import HistoryScreen from "src/features/transactions/screens/HistoryScreen";
import TxDetailsPanel from "src/features/transactions/components/TxDetailsPanel";
import { resetContractMethods } from "src/features/transactions/history/contractMethods";
import { resetContractFacts } from "src/features/transactions/history/contractFacts";

const tx = (over: Partial<Transaction>): Transaction => ({
  hash: "h",
  type: "send",
  amount: 1_000_000,
  fee: 1000,
  from: ME,
  to: "octB7eFLxweJ1piEVCVDX4qD3BQsNzPmKcQWRcuCvuJZQG",
  timestamp: NOW - 60_000,
  status: "confirmed",
  ...over,
});

function mount(node: React.ReactNode, path = "/history") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>{node}</MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  resetContractMethods();
  resetContractFacts();
  m.wallet.activeWallet.address = ME;
  m.wallet.networkId = "mainnet";
  m.wallet.setNetworkId.mockReset();
  m.calls = [];
  m.rpc.mockReset();
  m.rpc.mockImplementation(async (_net: string, method: string) =>
    method === "contract_receipt" ? { method: "list_nft" } : null,
  );
  m.history = {
    mainnet: [
      tx({
        hash: "m1",
        type: "contract_call",
        amount: 0,
        to: MARKET,
        op_type: "call",
        message: '["octX",13,5000000000]',
      }),
      tx({ hash: "m2", timestamp: NOW - 120_000 }),
    ],
    devnet: [
      tx({
        hash: "d1",
        type: "receive",
        from: "oct6rDvi2ppQkc93ft3ZVkWnRkbqwx2qPg6u2nEgGHRyrpQ",
        to: ME,
      }),
      tx({
        hash: "d2",
        type: "key_switch",
        amount: 0,
        status: "failed",
        chain_status: "dropped",
        reject_reason: "expired",
        drop_detail: "TTL exceeded: transaction was not included",
        timestamp: NOW - 3_600_000,
      }),
    ],
  };
  m.staging = {};
  m.details = {};
});
afterEach(cleanup);

const rows = () => screen.queryAllByTestId("history-row");

describe("History pages", () => {
  it("shows the newest row's receipt beside the list, and a picked row's after a click", async () => {
    mount(<HistoryScreen />);
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(rows()[0].getAttribute("aria-current")).toBe("true");
    fireEvent.click(rows()[1]);
    await waitFor(() => expect(rows()[1].getAttribute("aria-current")).toBe("true"));
    expect(rows()[0].getAttribute("aria-current")).toBeNull();
    expect(screen.queryByTestId("tx-details-scrim")).toBeNull();
  });

  it("filters the page by kind without touching the figures", async () => {
    mount(<HistoryScreen />);
    await waitFor(() => expect(rows()).toHaveLength(2));
    fireEvent.click(screen.getByRole("button", { name: "Contracts" }));
    await waitFor(() => expect(rows()).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Sent" }));
    await waitFor(() => expect(rows()).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    await waitFor(() => expect(rows()).toHaveLength(2));
  });

  it("switching pages never changes the active network", async () => {
    mount(<HistoryScreen />);
    await waitFor(() => expect(rows()).toHaveLength(2));
    fireEvent.click(screen.getByRole("button", { name: "Testnet" }));
    await waitFor(() => expect(rows().map((r) => r.dataset.network)).toEqual(["devnet", "devnet"]));
    fireEvent.click(screen.getByRole("button", { name: "Mainnet" }));
    await waitFor(() =>
      expect(rows().map((r) => r.dataset.network)).toEqual(["mainnet", "mainnet"]),
    );
    expect(m.wallet.setNetworkId).not.toHaveBeenCalled();
    expect(m.wallet.networkId).toBe("mainnet");
  });

  it("labels each row with its network and tags test rows Testnet", async () => {
    mount(<HistoryScreen />);
    await waitFor(() => expect(rows()).toHaveLength(2));
    for (const r of rows()) {
      expect(r.textContent).toContain("Octra Mainnet");
      expect(within(r).queryByText("Testnet")).toBeNull();
    }
    fireEvent.click(screen.getByRole("button", { name: "Testnet" }));
    await waitFor(() => expect(rows()[0]?.dataset.network).toBe("devnet"));
    for (const r of rows()) {
      expect(r.textContent).toContain("Octra Testnet");
      expect(r.textContent).not.toMatch(/Devnet/);
      expect(within(r).getByText("Testnet").dataset.tag).toBe("outline");
    }
  });

  it("names contract calls by their action, read lazily on the row's network", async () => {
    mount(<HistoryScreen />);
    await waitFor(() => expect(rows()).toHaveLength(2));
    await waitFor(() =>
      expect(within(rows()[0]).getByTestId("row-title").textContent).toBe("List"),
    );
    expect(m.calls).toContainEqual(["mainnet", "contract_receipt", ["m1"]]);
    expect(within(rows()[0]).getByTestId("row-other").textContent).toBe("octGoeTj...VmBj6h");
    expect(within(rows()[0]).getByTestId("row-amount").textContent).toBe(" ");
  });

  it("shows dropped and expired rows as failed with the honest outcome in the details", async () => {
    mount(<HistoryScreen />);
    await waitFor(() => expect(rows()).toHaveLength(2));
    fireEvent.click(screen.getByRole("button", { name: "Testnet" }));
    await waitFor(() => expect(rows()).toHaveLength(2));
    const dropped = rows().find((r) => r.textContent?.includes("Key switch"))!;
    expect(within(dropped).getByText("Failed")).toBeTruthy();
    fireEvent.click(dropped);
    const panel = await screen.findByTestId("tx-details");
    expect(panel.textContent).toContain("Replaced or dropped");
    expect(panel.textContent).toContain("TTL exceeded: transaction was not included");
  });

  it("lists the mempool as pending on its page and calls an old one out", async () => {
    m.staging = {
      mainnet: [
        {
          hash: "p1",
          from: ME,
          to: "octB",
          amount: "2000000",
          nonce: 9,
          timestamp: (NOW - 10 * 60_000) / 1000,
        },
        { hash: "p2", from: "octSomeoneElse", to: ME, amount: "1", nonce: 1 },
      ],
    };
    mount(<HistoryScreen />);
    await waitFor(() => expect(rows()).toHaveLength(3));
    const pending = rows()[0];
    expect(pending.textContent).toContain("Pending");
    fireEvent.click(pending);
    const panel = await screen.findByTestId("tx-details");
    expect(panel.textContent).toContain("Still pending");
    expect(panel.textContent).toContain("It may still confirm");
  });

  it("opens the details from a link with the network", async () => {
    m.details["devnet:d1"] = {
      hash: "d1",
      from: "oct6rDvi2ppQkc93ft3ZVkWnRkbqwx2qPg6u2nEgGHRyrpQ",
      to: ME,
      amount_raw: "1000000",
      op_type: "standard",
      status: "confirmed",
      timestamp: NOW / 1000,
      nonce: 4,
      epoch: 1710908,
    };
    mount(<HistoryScreen />, "/history?hash=d1&net=devnet");
    const panel = await screen.findByTestId("tx-details");
    await waitFor(() => expect(panel.textContent).toContain("1710908"));
    expect(panel.textContent).toContain("Octra Testnet");
    expect(rows().every((r) => r.dataset.network === "devnet")).toBe(true);
  });
});

describe("Details panel", () => {
  const lock = tx({
    hash: "lock1",
    type: "contract_call",
    op_type: "call",
    to: VAULT,
    amount: 10_000_000,
    network: "devnet",
    methodName: "lock",
    message:
      '["swap_1b60d87e1e828f45ce7444a122b987de","sepolia","0xc68f177AC0465C51E6Cf37cB4068142802F69a78","1559940","151749169604113","ETH"]',
  });

  it("shows the extension's rows for a SwapVault lock", async () => {
    m.details["devnet:lock1"] = {
      ...lock,
      amount_raw: "10000000",
      ou: "10000",
      nonce: 260,
      epoch: 1554942,
      status: "confirmed",
      op_type: "call",
      timestamp: lock.timestamp / 1000,
    };
    mount(<TxDetailsPanel hash="lock1" network="devnet" tx={lock} onClose={() => {}} />);
    const panel = await screen.findByTestId("tx-details");
    await waitFor(() => expect(panel.textContent).toContain("0.01 OCT"));
    const facts = screen.getAllByTestId("detail-row").map((r) => r.textContent);
    expect(facts).toEqual([
      "StatusConfirmed",
      "TypeSwap",
      "MethodLock",
      "ContractSwapVault",
      "To networkSepolia",
      "Recipient0xc68f177A...02F69a78",
      "Minimum received0.000151 ETH",
      "ExpiresEpoch 1559940",
      "Swap IDswap_1b60d...22b987de",
      "Network fee0.01 OCT",
      "NetworkOctra Testnet",
      "Epoch1554942",
      "Nonce260",
    ]);
    expect(screen.getByTestId("tx-hero").textContent).toBe("-10 OCT");
  });

  it("opens the call data page in the panel and goes back on Escape, then closes", async () => {
    const onClose = vi.fn();
    mount(<TxDetailsPanel hash="lock1" network="devnet" tx={lock} onClose={onClose} />);
    fireEvent.click(await screen.findByRole("button", { name: /View call data/ }));
    const page = screen.getByTestId("call-data-page");
    const blocks = within(page)
      .getAllByTestId("call-block")
      .map((b) => b.textContent);
    expect(blocks[0]).toBe("MethodLock");
    expect(blocks[1]).toBe("Functionlock");
    expect(blocks[2]).toContain("SwapVault");
    expect(blocks[2]).toContain(VAULT);
    expect(blocks).toContain("To networkstringSepoliasepolia");
    expect(blocks).toContain("Swap IDstringswap_1b60d87e1e828f45ce7444a122b987de");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("call-data-page")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on a click outside and has no close button", async () => {
    const onClose = vi.fn();
    mount(<TxDetailsPanel hash="lock1" network="devnet" tx={lock} onClose={onClose} />);
    await screen.findByTestId("tx-details");
    expect(screen.queryByRole("button", { name: /close/i })).toBeNull();
    fireEvent.click(screen.getByTestId("tx-details-scrim"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("lists unnamed arguments as Value n and clamps long values with Show all", async () => {
    const proto = HTMLElement.prototype;
    const sh = Object.getOwnPropertyDescriptor(proto, "scrollHeight");
    const ch = Object.getOwnPropertyDescriptor(proto, "clientHeight");
    Object.defineProperty(proto, "scrollHeight", {
      configurable: true,
      get() {
        return (this as HTMLElement).textContent!.length > 200 &&
          (this as HTMLElement).dataset.clamp !== "none"
          ? 400
          : 20;
      },
    });
    Object.defineProperty(proto, "clientHeight", { configurable: true, get: () => 20 });
    try {
      const call = tx({
        hash: "c1",
        type: "contract_call",
        op_type: "call",
        to: MARKET,
        amount: 0,
        network: "mainnet",
        methodName: "set_blob",
        message: JSON.stringify(["a".repeat(9000), 7]),
      });
      m.rpc.mockResolvedValue(null);
      mount(<TxDetailsPanel hash="c1" network="mainnet" tx={call} onClose={() => {}} />);
      fireEvent.click(await screen.findByRole("button", { name: /View call data/ }));
      const page = screen.getByTestId("call-data-page");
      const values = within(page).getAllByTestId("call-value");
      const blob = values.find((v) => v.textContent!.startsWith("aaa"))!;
      expect(blob.textContent!.length).toBe(4099);
      expect(blob.dataset.clamp).toBe("6");
      expect(within(page).getByText("Value 1")).toBeTruthy();
      expect(within(page).getByText("Value 2")).toBeTruthy();
      expect(within(page).getByText("int")).toBeTruthy();
      const showAll = within(page).getByRole("button", { name: "Show all" });
      act(() => showAll.click());
      expect(blob.dataset.clamp).toBe("none");
      expect(within(page).queryByRole("button", { name: "Show all" })).toBeNull();
    } finally {
      if (sh) Object.defineProperty(proto, "scrollHeight", sh);
      if (ch) Object.defineProperty(proto, "clientHeight", ch);
    }
  });

  it("shows no amount for a call that moved nothing and reads it as words", async () => {
    const call = tx({
      hash: "a1",
      type: "contract_call",
      op_type: "call",
      to: MARKET,
      amount: 0,
      network: "mainnet",
      methodName: "approve",
      message: '["octX","0"]',
    });
    mount(<TxDetailsPanel hash="a1" network="mainnet" tx={call} onClose={() => {}} />);
    expect((await screen.findByTestId("tx-hero")).textContent).toBe("Revoke");
  });
});
