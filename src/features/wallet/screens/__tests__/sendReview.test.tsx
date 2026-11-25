// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "src/lib/router";
import { QueryClient, QueryClientProvider } from "src/lib/query";

const SELF = `oct${"A".repeat(44)}`;
const MIRA = `oct${"M".repeat(44)}`;
const JONAS = `oct${"J".repeat(44)}`;

const m = vi.hoisted(() => ({
  feeStatus: "ok" as "ok" | "loading" | "error",
  auth: vi.fn(),
  build: vi.fn(),
  broadcast: vi.fn(),
  stealth: vi.fn(),
  recheck: vi.fn(),
  check: vi.fn(),
  privacy: true,
}));

vi.mock("src/i18n/react", () => ({
  useTranslation: () => ({
    t: (k: string, o?: { count?: number }) => (o?.count != null ? `${k}:${o.count}` : k),
  }),
}));
vi.mock("src/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("src/contexts/useWallet", () => ({
  useWallet: () => ({
    activeWallet: { id: "w1", name: "Spending", address: SELF, wallet_type: "hd" },
    wallets: [],
    networkId: "mainnet",
    showMessage: () => {},
    pvacForeign: false,
    pvacLegacy: false,
    setPvacForeign: () => {},
  }),
}));
vi.mock("src/services/network/config", async (orig) => {
  const real = await orig<typeof import("src/services/network/config")>();
  return {
    ...real,
    NETWORKS: { mainnet: { ...real.NETWORKS.mainnet, supportsPrivacy: true } },
  };
});
vi.mock("src/hooks/wallet/useBalance", () => ({
  useBalance: () => ({ publicBalance: 100_000_000, privateBalance: 50_000_000, isLoading: false }),
}));
vi.mock("src/hooks/wallet/useTokens", () => ({ useTokens: () => ({ tokens: [] }) }));
vi.mock("src/hooks/transactions/useFees", () => ({
  useFee: () => ({
    status: m.feeStatus,
    fee: m.feeStatus === "ok" ? { minimum: "1000", recommended: "1000", fast: "2000" } : null,
    last: null,
    retry: () => {},
  }),
  useFeeRecheck: () => ({ checking: false, error: "", setError: () => {}, check: m.check }),
  recheckReviewedFee: (...a: unknown[]) => m.recheck(...a),
}));
vi.mock("src/hooks/transactions/usePersistedOU", () => ({
  usePersistedOU: () => ["1000", () => {}],
}));
vi.mock("src/hooks/privacy/usePvacSetup", () => ({
  usePvacSetup: () => ({
    regState: "registered",
    held: false,
    needsCompact: false,
    canMigrate: false,
    notSpendable: false,
    baseLayers: 2,
    refresh: () => {},
  }),
}));
vi.mock("src/hooks/privacy/useMigrateBalance", () => ({
  useMigrateBalance: () => ({ showPopup: false, upgrading: false, open: vi.fn() }),
}));
vi.mock("src/features/privacy/hooks/useKeyHold", () => ({
  useKeyHold: () => ({ hold: null, checkedAt: null, checking: false, check: () => {} }),
}));
vi.mock("src/hooks/transactions/useTransactionAuth", () => ({
  useTransactionAuth: () => ({
    isOpen: false,
    title: "",
    requestAuth: (...a: unknown[]) => m.auth(...a),
    handleResult: vi.fn(),
  }),
}));
vi.mock("src/hooks/wallet/useTokenPrice", () => ({
  useTokenPrice: () => ({ getUsdValue: () => undefined }),
}));
vi.mock("src/hooks/transactions/useTransactionHistory", () => ({
  historyQueryKey: (a: string, n: string, c: number) => ["txHistory", a, n, c],
  HISTORY_PAGE_SIZE: 20,
  fetchHistoryPage: async () => ({
    transactions: [
      {
        hash: "1",
        from: SELF,
        to: MIRA,
        amount: 12_500_000,
        timestamp: 1_760_000_000,
        status: "confirmed",
      },
      {
        hash: "2",
        from: SELF,
        to: MIRA,
        amount: 3_000_000,
        timestamp: 1_750_000_000,
        status: "confirmed",
      },
    ],
  }),
}));
vi.mock("src/services/storage/addressBookService", () => ({
  INTERNAL_TAG: "internal",
  getContacts: () => [
    { id: "c1", label: "Mira", address: MIRA, tags: [], createdAt: 0 },
    { id: "c2", label: "Jonas", address: JONAS, tags: [], createdAt: 0 },
  ],
}));
vi.mock("src/services/network/networkService", () => ({
  captureScope: (address: string) => ({ address, networkId: "mainnet" }),
  assertScope: () => {},
}));
vi.mock("src/services/network/transactionBuilder", () => ({
  buildTransferTx: (...a: unknown[]) => m.build(...a),
  broadcastSignedTx: (...a: unknown[]) => m.broadcast(...a),
}));
vi.mock("src/services/contracts/contractService", () => ({ callContract: vi.fn() }));
vi.mock("src/services/pvac/pvacBridge", () => ({ pvacBridge: { isInitializedFor: () => true } }));
vi.mock("src/features/privacy/services/privacyService", () => ({
  sendStealth: (...a: unknown[]) => m.stealth(...a),
  initPvac: vi.fn(),
}));
vi.mock("src/shared/layout/TopBar", () => ({ default: () => null }));
vi.mock("src/shared/ui/WalletAvatar", () => ({ default: () => null }));
vi.mock("src/features/wallet/components/TransactionAuthModal", () => ({ default: () => null }));

import SendScreen from "src/features/wallet/screens/SendScreen";
import { pickerRows } from "src/features/wallet/components/send/RecipientPicker";
import { getQueue, resetQueue } from "src/features/privacy/services/proofQueue";
import { getActivity, resetActivity } from "src/services/notices/activity";
import { parseRows } from "src/features/wallet/hooks/useBulkFlow";

function show(entry = "/send") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = () => (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[entry]}>
        <SendScreen />
      </MemoryRouter>
    </QueryClientProvider>
  );
  return { ...render(tree()), tree };
}

const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;
const review = (name = "sendFlow.review") => screen.getByRole("dialog", { name });
const verb = (name = "sendFlow.review") =>
  within(review(name)).getByRole("button", { name: "common.send" }) as HTMLButtonElement;

function pick(query: string) {
  fireEvent.click(button("sendFlow.recipient"));
  const search = screen.getByLabelText("sendFlow.searchOrPaste");
  fireEvent.change(search, { target: { value: query } });
  fireEvent.keyDown(search, { key: "Enter" });
}

function fill(amount = "12.5", message = "October rent") {
  pick("Mira");
  fireEvent.change(screen.getByLabelText("sendFlow.amount"), { target: { value: amount } });
  if (message)
    fireEvent.change(screen.getByLabelText("sendFlow.message"), { target: { value: message } });
}

beforeEach(() => {
  resetQueue();
  resetActivity();
  localStorage.clear();
  m.feeStatus = "ok";
  m.auth.mockReset().mockResolvedValue(true);
  m.check.mockReset().mockResolvedValue(null);
  m.recheck.mockReset().mockResolvedValue({ error: null, live: null });
  m.build.mockReset().mockResolvedValue({ signed: true });
  m.broadcast.mockReset().mockResolvedValue("7f3a91c0d2aa00bb11cc22dd33ee44ff55c41e9d07b2");
  m.stealth.mockReset().mockResolvedValue({ txHash: "stealthhash0000000000000000" });
});
afterEach(cleanup);

describe("Recipient picker", () => {
  it("groups Recent, Contacts and Your wallets and filters by name or address", async () => {
    show();
    fireEvent.click(button("sendFlow.recipient"));
    await waitFor(() => expect(screen.getByText("sendFlow.group.recent")).toBeTruthy());
    expect(screen.getByText("sendFlow.group.contacts")).toBeTruthy();
    const options = () => screen.getAllByRole("option").map((o) => o.textContent);
    expect(options()[0]).toContain("Mira");
    fireEvent.change(screen.getByLabelText("sendFlow.searchOrPaste"), { target: { value: "jon" } });
    expect(options()).toHaveLength(1);
    expect(options()[0]).toContain("Jonas");
  });

  it("offers a pasted address the wallet does not know first, as Use this address", () => {
    const NEW = `oct${"N".repeat(44)}`;
    const rows = pickerRows(
      {
        search: () => [{ address: MIRA, name: "Mira", source: "book", sent: 0, last: null }],
      } as never,
      NEW,
    );
    expect(rows[0]).toEqual({ address: NEW, name: null, group: "new" });
  });

  it("fills the field with the picked person and closes", () => {
    show();
    pick("Mira");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(button("sendFlow.recipient").textContent).toContain("Mira");
  });
});

describe("Send review", () => {
  it("keeps Review off until the fee is live", () => {
    m.feeStatus = "loading";
    show();
    fill();
    expect(button("sendFlow.reviewShort").disabled).toBe(true);
  });

  it("opens the review pop-up over the locked form", () => {
    show();
    fill();
    fireEvent.click(button("sendFlow.reviewShort"));
    const card = review();
    expect(card.textContent).toContain("Mira");
    expect(card.textContent).toContain("October rent");
    expect(verb().disabled).toBe(false);
    const form = screen.getByLabelText("sendFlow.amount").closest("[aria-disabled]");
    expect(form?.getAttribute("aria-disabled")).toBe("true");
  });

  it("keeps Send off while the fee is being read again", () => {
    const view = show();
    fill();
    fireEvent.click(button("sendFlow.reviewShort"));
    m.feeStatus = "loading";
    view.rerender(view.tree());
    expect(verb().disabled).toBe(true);
    expect(within(review()).getByRole("status", { name: "fee.checking" })).toBeTruthy();
  });

  it("Reject returns to editing without signing, every value kept", () => {
    show();
    fill();
    fireEvent.click(button("sendFlow.reviewShort"));
    fireEvent.click(within(review()).getByRole("button", { name: "common.reject" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect((screen.getByLabelText("sendFlow.amount") as HTMLInputElement).value).toBe("12.5");
    expect(m.auth).not.toHaveBeenCalled();
    expect(m.build).not.toHaveBeenCalled();
  });

  it("signs a public send only after Send and the auth step, then reports it as a toast", async () => {
    show();
    fill();
    fireEvent.click(button("sendFlow.reviewShort"));
    fireEvent.click(verb());
    await waitFor(() => expect(m.broadcast).toHaveBeenCalled());
    expect(m.check).toHaveBeenCalledWith("mainnet", "1000");
    expect(m.auth).toHaveBeenCalledTimes(1);
    expect(m.build.mock.calls[0][0]).toMatchObject({
      to: MIRA,
      amount: 12_500_000,
      ou: "1000",
      message: "October rent",
    });
    await waitFor(() => expect(getActivity().toasts).toHaveLength(1));
    expect(getActivity().toasts[0]).toMatchObject({
      title: "activity.sent",
      who: MIRA,
      view: { hash: "7f3a91c0d2aa00bb11cc22dd33ee44ff55c41e9d07b2", network: "mainnet" },
    });
    expect((screen.getByLabelText("sendFlow.amount") as HTMLInputElement).value).toBe("");
    expect(getQueue().jobs).toHaveLength(0);
  });

  it("signs nothing when the fee moved before signing", async () => {
    m.check.mockResolvedValue("The network fee changed. Review again.");
    show();
    fill();
    fireEvent.click(button("sendFlow.reviewShort"));
    fireEvent.click(verb());
    await waitFor(() => expect(m.check).toHaveBeenCalled());
    expect(m.auth).not.toHaveBeenCalled();
    expect(m.build).not.toHaveBeenCalled();
    expect(review()).toBeTruthy();
  });

  it("runs a private send through the shared proof queue and shows its progress", async () => {
    show();
    fireEvent.click(button("sendFlow.private"));
    fill("2", "");
    expect((screen.getByLabelText("sendFlow.message") as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(button("sendFlow.reviewShort"));
    fireEvent.click(verb("sendFlow.reviewPrivate"));
    await waitFor(() => expect(m.stealth).toHaveBeenCalled());
    expect(m.auth).toHaveBeenCalledTimes(1);
    expect(m.recheck).toHaveBeenCalledWith("stealth", "mainnet", "1000");
    expect(m.stealth.mock.calls[0][0]).toMatchObject({
      recipient: MIRA,
      amount: 2_000_000,
      ou: "1000",
    });
    const job = getQueue().jobs[0];
    expect(job).toMatchObject({ kind: "send", to: MIRA, amount: 2_000_000 });
    expect(getActivity().shown).toBe(job.id);
    expect(m.build).not.toHaveBeenCalled();
  });
});

describe("Bulk send", () => {
  it("reads address,amount lines and skips a header", () => {
    expect(parseRows(`address,amount\n${MIRA},1.5\nbad,2\n${JONAS}\t2`)).toEqual([
      { address: MIRA, amount: "1.5" },
      { address: JONAS, amount: "2" },
    ]);
    expect(parseRows(`${MIRA},1e21\n${JONAS},0.000\n${MIRA},-1\n${JONAS},0.5`)).toEqual([
      { address: JONAS, amount: "0.5" },
    ]);
  });

  it("lists every send in order in the review and sends after the auth step", async () => {
    show("/send?tab=batch");
    fireEvent.change(screen.getByLabelText("sendFlow.pasteList"), {
      target: { value: `${MIRA},1.5\n${JONAS},2` },
    });
    fireEvent.click(button("send.addAll"));
    fireEvent.click(button("sendFlow.reviewN:2"));
    const card = screen.getByRole("region", { name: "sendFlow.reviewBulk" });
    const text = card.textContent!;
    expect(text.indexOf("Mira")).toBeLessThan(text.indexOf("Jonas"));
    expect(m.build).not.toHaveBeenCalled();
    fireEvent.click(within(card).getByRole("button", { name: "sendFlow.sendN:2" }));
    await waitFor(() => expect(m.broadcast).toHaveBeenCalledTimes(2));
    expect(m.auth).toHaveBeenCalledTimes(1);
    expect(m.build.mock.calls.map((c) => c[0].to)).toEqual([MIRA, JONAS]);
  });
});
