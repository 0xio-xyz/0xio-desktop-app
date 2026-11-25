// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "src/lib/router";
import { QueryClient, QueryClientProvider } from "src/lib/query";

const SELF = `oct${"A".repeat(44)}`;
const MIRA = `oct${"M".repeat(44)}`;
const JONAS = `oct${"J".repeat(44)}`;

const TARGET = "octkj7UCF12TYNsUtivfccTnUyNY2xnRtuVGqjejzo5kcRF";
const MOVED = "octc9qTj2s2eVEz8MEjmr9RygZcPRKhKr2rENEfYG24RUV8";

const m = vi.hoisted(() => ({
  resolve: vi.fn(),
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
    networkId: "devnet",
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
    NETWORKS: { devnet: { ...real.NETWORKS.devnet, supportsPrivacy: true } },
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
  captureScope: (address: string) => ({ address, networkId: "devnet" }),
  assertScope: () => {},
}));
vi.mock("src/services/names/onsService", () => ({
  ONS_FORWARD_TTL_MS: 60_000,
  ONS_PRIMARY_TTL_MS: 600_000,
  ONS_LIST_TTL_MS: 600_000,
  ONS_RETRY_MS: 60_000,
  loadOnsContract: async () => ({
    state: "on",
    address: "oct91H1swTpzRnN91cW5EdMtcBBL4mPQADsKZcNWihowjLN",
  }),
  onsContract: (networkId: string) =>
    networkId === "devnet" ? "oct91H1swTpzRnN91cW5EdMtcBBL4mPQADsKZcNWihowjLN" : null,
  subscribeOnsContract: () => () => {},
  resolveWallet: (...a: unknown[]) => m.resolve(...a),
  primaryName: async () => ({ ok: true, name: null }),
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
import { getQueue, resetQueue } from "src/features/privacy/services/proofQueue";
import { resetActivity } from "src/services/notices/activity";

function show() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/send"]}>
        <SendScreen />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const found = (address = TARGET) => ({ ok: true, name: "0xio", address });
const refused = (reason: string) => ({ ok: false, reason });
const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;
const review = (name = "sendFlow.review") => screen.getByRole("dialog", { name });
const verb = (name = "sendFlow.review") =>
  within(review(name)).getByRole("button", { name: "common.send" }) as HTMLButtonElement;
const row = () => screen.getByTestId("name-row");

function type(text: string) {
  fireEvent.click(button("sendFlow.recipient"));
  fireEvent.change(screen.getByLabelText("sendFlow.searchOrPaste"), { target: { value: text } });
}

async function pickName(text = "0xio.oct") {
  type(text);
  await waitFor(() => expect(row().dataset.state).toBe("found"));
  fireEvent.keyDown(screen.getByLabelText("sendFlow.searchOrPaste"), { key: "Enter" });
  expect(screen.queryByRole("listbox")).toBeNull();
}

async function toReview() {
  await pickName();
  fireEvent.change(screen.getByLabelText("sendFlow.amount"), { target: { value: "12.5" } });
  fireEvent.click(button("sendFlow.reviewShort"));
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
  m.resolve.mockReset().mockResolvedValue(found());
});
afterEach(cleanup);

describe("Send to a name, the picker row", () => {
  it("looks a typed .oct name up in a row of its own and leaves other text alone", async () => {
    let answer: (v: unknown) => void = () => {};
    m.resolve.mockReturnValue(new Promise((r) => (answer = r)));
    show();
    type("0xio");
    expect(screen.queryByTestId("name-row")).toBeNull();
    expect(m.resolve).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("sendFlow.searchOrPaste"), {
      target: { value: "0Xio.OCT" },
    });
    expect(row().dataset.state).toBe("resolving");
    expect(within(row()).getByRole("status", { name: "ons.lookingUp" })).toBeTruthy();
    expect(row().className).toMatch(/\bh-14\b/);
    expect(row().textContent).toContain("0xio.oct");
    answer(found());
    await waitFor(() => expect(row().dataset.state).toBe("found"));
    expect(row().className).toMatch(/\bh-14\b/);
    expect(row().textContent).not.toContain(TARGET);
    expect(m.resolve).toHaveBeenCalledWith("0xio", { networkId: "devnet" });
  });

  it("takes a typed name as the recipient after a pause in typing, with no pick", async () => {
    let answer: (v: unknown) => void = () => {};
    m.resolve.mockReturnValue(new Promise((r) => (answer = r)));
    show();
    fireEvent.change(screen.getByLabelText("sendFlow.amount"), { target: { value: "1" } });
    type("0xio.oct");
    expect(button("sendFlow.reviewShort").disabled).toBe(true);
    answer(found());
    await waitFor(() => expect(row().dataset.state).toBe("found"));
    expect(screen.getByRole("listbox")).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull(), { timeout: 2500 });
    const field = button("sendFlow.recipient");
    expect(field.textContent).toContain("0xio.oct");
    expect(field.textContent).not.toContain(TARGET);
    expect(field.querySelector(".truncate")).toBeTruthy();
    expect(button("sendFlow.reviewShort").disabled).toBe(false);
  });

  it("takes nothing while the text is still changing", async () => {
    let answer: (v: unknown) => void = () => {};
    m.resolve.mockReturnValueOnce(new Promise((r) => (answer = r)));
    show();
    type("0xio.oct");
    fireEvent.change(screen.getByLabelText("sendFlow.searchOrPaste"), {
      target: { value: "0xio.octa" },
    });
    answer(found());
    await Promise.resolve();
    expect(screen.getByRole("listbox")).toBeTruthy();
    expect(button("sendFlow.recipient").textContent).toContain("sendFlow.chooseRecipient");
  });

  it.each([
    ["not_registered"],
    ["not_set"],
    ["points_to_circle"],
    ["expired"],
    ["reserved"],
    ["invalid"],
  ])("dims a name that cannot be paid and says why: %s", async (reason) => {
    m.resolve.mockResolvedValue(refused(reason));
    show();
    type("0xio-labs.oct");
    await waitFor(() => expect(row().dataset.state).toBe("refused"));
    expect(row().textContent).toContain(`ons.reason.${reason}`);
    expect(row().getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(row());
    expect(screen.getByRole("listbox")).toBeTruthy();
    expect(button("sendFlow.recipient").textContent).toContain("sendFlow.chooseRecipient");
  });

  it("refuses a name that breaks the rules without asking the node", () => {
    show();
    type("al_ice.oct");
    expect(row().dataset.state).toBe("refused");
    expect(row().textContent).toContain("ons.reason.invalid");
    expect(m.resolve).not.toHaveBeenCalled();
  });

  it.each([["busy"], ["unavailable"], ["bad_reply"]])(
    "offers Retry when the node did not answer (%s), never not registered",
    async (reason) => {
      m.resolve.mockResolvedValueOnce(refused(reason)).mockResolvedValue(found());
      show();
      type("0xio.oct");
      await waitFor(() => expect(row().dataset.state).toBe("failed"));
      expect(row().textContent).toContain(`ons.reason.${reason}`);
      expect(row().textContent).not.toContain("ons.reason.not_registered");
      expect(row().textContent).toContain("ons.retry");
      fireEvent.click(row());
      await waitFor(() => expect(row().dataset.state).toBe("found"));
      expect(m.resolve).toHaveBeenCalledTimes(2);
    },
  );
});

describe("Send to a name, the review", () => {
  it("shows one To card with the name and the full address", async () => {
    show();
    await toReview();
    const card = within(review()).getByTestId("name-card");
    expect(card.dataset.state).toBe("set");
    expect(card.textContent).toContain("0xio.oct");
    expect(card.textContent).toContain(TARGET);
    expect(within(review()).queryByText("sendFlow.address")).toBeNull();
  });

  it("resolves again past the cache at confirm and signs to the address", async () => {
    show();
    await toReview();
    m.resolve.mockClear();
    fireEvent.click(verb());
    await waitFor(() => expect(m.broadcast).toHaveBeenCalled());
    expect(m.resolve).toHaveBeenCalledWith("0xio.oct", { networkId: "devnet", fresh: true });
    expect(m.resolve.mock.invocationCallOrder[0]).toBeLessThan(m.auth.mock.invocationCallOrder[0]);
    expect(m.build.mock.calls[0][0]).toMatchObject({ to: TARGET, amount: 12_500_000 });
  });

  it("signs nothing when the name moved: was and now in place, Send off until accepted", async () => {
    show();
    await toReview();
    const before = within(review()).getByTestId("name-card").className;
    m.resolve.mockResolvedValue(found(MOVED));
    fireEvent.click(verb());
    await waitFor(() =>
      expect(within(review()).getByTestId("name-card").dataset.state).toBe("moved"),
    );
    const card = within(review()).getByTestId("name-card");
    expect(card.className).toBe(before);
    expect(card.textContent).toContain("ons.was");
    expect(card.textContent).toContain(TARGET);
    expect(card.textContent).toContain("ons.now");
    expect(card.textContent).toContain(MOVED);
    expect(verb().disabled).toBe(true);
    expect(m.auth).not.toHaveBeenCalled();
    expect(m.build).not.toHaveBeenCalled();

    fireEvent.click(within(card).getByRole("button", { name: "ons.useNewAddress" }));
    expect(within(review()).getByTestId("name-card").dataset.state).toBe("set");
    expect(within(review()).getByTestId("name-card").textContent).toContain(MOVED);
    expect(verb().disabled).toBe(false);
    expect(m.build).not.toHaveBeenCalled();

    m.resolve.mockClear();
    fireEvent.click(verb());
    await waitFor(() => expect(m.broadcast).toHaveBeenCalled());
    expect(m.resolve).toHaveBeenCalledWith("0xio.oct", { networkId: "devnet", fresh: true });
    expect(m.build.mock.calls[0][0]).toMatchObject({ to: MOVED });
  });

  it.each([["busy"], ["unavailable"], ["not_set"], ["expired"], ["not_registered"]])(
    "stops with the reason when the fresh read gives %s",
    async (reason) => {
      show();
      await toReview();
      m.resolve.mockResolvedValue(refused(reason));
      fireEvent.click(verb());
      await waitFor(() =>
        expect(within(review()).getByRole("alert").textContent).toBe(`ons.reason.${reason}`),
      );
      expect(m.auth).not.toHaveBeenCalled();
      expect(m.build).not.toHaveBeenCalled();
      expect(review()).toBeTruthy();
    },
  );

  it("stops when the fresh read throws", async () => {
    show();
    await toReview();
    m.resolve.mockRejectedValue(new Error("network down"));
    fireEvent.click(verb());
    await waitFor(() =>
      expect(within(review()).getByRole("alert").textContent).toBe("ons.reason.unavailable"),
    );
    expect(m.build).not.toHaveBeenCalled();
  });

  it("does not resolve anything for a recipient entered as an address", async () => {
    show();
    type(TARGET);
    fireEvent.keyDown(screen.getByLabelText("sendFlow.searchOrPaste"), { key: "Enter" });
    fireEvent.change(screen.getByLabelText("sendFlow.amount"), { target: { value: "2" } });
    fireEvent.click(button("sendFlow.reviewShort"));
    expect(within(review()).queryByTestId("name-card")).toBeNull();
    expect(within(review()).getByText("sendFlow.address")).toBeTruthy();
    fireEvent.click(verb());
    await waitFor(() => expect(m.broadcast).toHaveBeenCalled());
    expect(m.resolve).not.toHaveBeenCalled();
    expect(m.build.mock.calls[0][0]).toMatchObject({ to: TARGET });
  });

  it("checks the name again inside a private send before it signs", async () => {
    show();
    fireEvent.click(button("sendFlow.private"));
    await pickName();
    fireEvent.change(screen.getByLabelText("sendFlow.amount"), { target: { value: "2" } });
    fireEvent.click(button("sendFlow.reviewShort"));
    m.resolve.mockClear();
    m.resolve.mockResolvedValueOnce(found()).mockResolvedValue(found(MOVED));
    fireEvent.click(verb("sendFlow.reviewPrivate"));
    await waitFor(() => expect(getQueue().jobs[0]?.status).toBe("failed"));
    expect(m.resolve).toHaveBeenCalledTimes(2);
    expect(m.stealth).not.toHaveBeenCalled();
  });

  it("sends privately to the resolved address when the name holds", async () => {
    show();
    fireEvent.click(button("sendFlow.private"));
    await pickName();
    fireEvent.change(screen.getByLabelText("sendFlow.amount"), { target: { value: "2" } });
    fireEvent.click(button("sendFlow.reviewShort"));
    fireEvent.click(verb("sendFlow.reviewPrivate"));
    await waitFor(() => expect(m.stealth).toHaveBeenCalled());
    expect(m.stealth.mock.calls[0][0]).toMatchObject({ recipient: TARGET, amount: 2_000_000 });
  });
});
