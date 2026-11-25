// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "src/lib/router";
import { QueryClient, QueryClientProvider } from "src/lib/query";

const SENDER = `oct${"S".repeat(44)}`;
const m = vi.hoisted(() => ({
  setup: {
    regState: "registered",
    needsCompact: false,
    baseLayers: 2,
    nonCanonical: false,
    held: false,
    holdKeyFine: false,
    canMigrate: false,
    notSpendable: false,
    spendReason: undefined as string | undefined,
    refresh: () => {},
  },
  publicBalance: 10_000_000,
  feeStatus: "ok" as "ok" | "loading" | "error",
  auth: vi.fn(),
  encrypt: vi.fn(),
  claim: vi.fn(),
  recheck: vi.fn(),
  check: vi.fn(),
  outputs: [] as unknown[],
  scan: vi.fn(),
  hold: null as null | { submittedAt: number; txHash: string },
}));

vi.mock("src/i18n/react", () => ({
  useTranslation: () => ({
    t: (k: string, o?: { count?: unknown; n?: unknown }) =>
      o?.count != null ? `${k}:${o.count}` : o?.n != null ? `${k}:${o.n}` : k,
  }),
}));
vi.mock("src/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("src/contexts/useWallet", () => ({
  useWallet: () => ({
    activeWallet: { id: "w1", name: "Main", address: `oct${"A".repeat(44)}` },
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
  useBalance: () => ({
    publicBalance: m.publicBalance,
    privateBalance: 5_000_000,
    isLoading: false,
    refetch: () => {},
  }),
}));
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
vi.mock("src/hooks/privacy/usePvacSetup", () => ({ usePvacSetup: () => m.setup }));
vi.mock("src/hooks/privacy/useMigrateBalance", () => ({
  useMigrateBalance: () => ({ showPopup: false, upgrading: false, open: vi.fn() }),
}));
vi.mock("src/hooks/privacy/useAutoEncrypt", () => ({ useAutoEncrypt: () => {} }));
vi.mock("src/features/privacy/hooks/useCanonicalAdvisory", () => ({
  useCanonicalAdvisory: () => {},
}));
vi.mock("src/features/privacy/hooks/useKeyHold", () => ({
  useKeyHold: () => ({
    hold: m.hold,
    checkedAt: null,
    checking: false,
    check: () => {},
    clearAndUpdate: () => {},
  }),
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
vi.mock("src/services/network/networkService", () => ({
  captureScope: (address: string) => ({ address, networkId: "devnet" }),
  assertScope: () => {},
}));
vi.mock("src/services/wallet/walletBridge", () => ({ walletBridge: {} }));
vi.mock("src/services/pvac/pvacBridge", () => ({ pvacBridge: { isInitializedFor: () => true } }));
vi.mock("src/features/privacy/services/privacyService", () => ({
  encryptBalance: (...a: unknown[]) => m.encrypt(...a),
  decryptBalance: vi.fn(),
  getStealthOutputs: async (...a: unknown[]) => {
    m.scan(...a);
    return m.outputs;
  },
  suggestedScanIntervalMs: () => 60_000,
  claimOutput: (...a: unknown[]) => m.claim(...a),
  initPvac: vi.fn(),
}));
vi.mock("src/services/storage/addressBookService", () => ({ getContacts: () => [] }));
vi.mock("src/shared/layout/TopBar", () => ({ default: () => null }));
vi.mock("src/shared/ui/Mascot", () => ({ default: () => null }));
vi.mock("src/shared/ui/WalletAvatar", () => ({ default: () => null }));
vi.mock("src/features/wallet/components/TransactionAuthModal", () => ({ default: () => null }));

import PrivacyScreen from "src/features/privacy/screens/PrivacyScreen";
import { unprovableLine } from "src/features/privacy/services/trayPrivate";
import { enqueue, getQueue, resetQueue } from "src/features/privacy/services/proofQueue";
import { getActivity, resetActivity } from "src/services/notices/activity";
import { FEE_CHANGED, FEE_SHORT, INSUFFICIENT_BALANCE } from "src/services/transactions/feeCopy";

const OLDEST = {
  id: 4,
  amount: 1_500_000,
  claimSecret: "c",
  blinding: "d",
  sender: SENDER,
  epoch: 80,
};
const NEWER = {
  id: 9,
  amount: 3_000_000,
  claimSecret: "a",
  blinding: "b",
  sender: SENDER,
  epoch: 120,
};

function show() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/privacy"]}>
        <PrivacyScreen />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
const amountField = (dir = "proofs.encrypt") => screen.getByLabelText(dir) as HTMLInputElement;
const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;
const popup = (name: string) => screen.getByRole("dialog", { name });

beforeEach(() => {
  resetQueue();
  resetActivity();
  localStorage.clear();
  m.publicBalance = 10_000_000;
  m.feeStatus = "ok";
  m.setup.regState = "registered";
  m.setup.notSpendable = false;
  m.setup.spendReason = undefined;
  m.setup.needsCompact = false;
  m.setup.baseLayers = 2;
  m.auth.mockReset().mockResolvedValue(true);
  m.encrypt.mockReset().mockResolvedValue({ txHash: "h" });
  m.claim.mockReset().mockResolvedValue({ txHash: "c" });
  m.recheck.mockReset().mockResolvedValue({ error: null, live: null });
  m.check.mockReset().mockResolvedValue(null);
  m.outputs = [];
  m.hold = null;
});
afterEach(cleanup);

describe("Privacy gates", () => {
  it("puts the unprovable line in the slot and offers no Review", () => {
    m.setup.notSpendable = true;
    m.setup.spendReason = "too many layers";
    show();
    expect(screen.getByText(unprovableLine("too many layers"))).toBeTruthy();
    expect(button("proofs.gate.unprovableAction").disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "sendFlow.reviewShort" })).toBeNull();
  });

  it("offers the refresh review at the layer limit", () => {
    m.setup.needsCompact = true;
    m.setup.baseLayers = 4;
    show();
    expect(screen.getByText("proofs.gate.refreshTitle")).toBeTruthy();
    expect(button("proofs.gate.reviewRefresh").disabled).toBe(false);
  });

  it("follows a refresh already sent instead of offering its review again", async () => {
    m.setup.needsCompact = true;
    m.setup.baseLayers = 4;
    enqueue({
      kind: "refresh",
      scope: { networkId: "devnet", address: `oct${"A".repeat(44)}` },
      amount: 0,
      steps: ["step.one", "step.two"],
      run: () => new Promise(() => {}),
    });
    show();
    expect(await screen.findByText("proofs.running.refresh")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "proofs.gate.reviewRefresh" })).toBeNull();
    fireEvent.click(button("activity.showProgress"));
    expect(getActivity().shown).toBe(getQueue().jobs[0].id);
  });

  it("shows private as Off with Turn on when it is not turned on", () => {
    m.setup.regState = "unregistered";
    show();
    expect(screen.getByText("proofs.off")).toBeTruthy();
    expect(button("proofs.turnOn.title")).toBeTruthy();
    expect(amountField().disabled).toBe(true);
    expect(button("proofs.decrypt").disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "sendFlow.reviewShort" })).toBeNull();
  });
});

describe("Action bar", () => {
  it("puts a key update on hold in the summary and its steps in the bar", () => {
    m.hold = { submittedAt: Date.now(), txHash: "f".repeat(64) };
    show();
    expect(screen.getAllByText("proofs.hold.title").length).toBe(2);
    expect(button("proofs.hold.clear")).toBeTruthy();
    expect(button("proofs.checkAgain")).toBeTruthy();
    expect(amountField().disabled).toBe(true);
  });

  it("follows a running encrypt and locks the amount until it finishes", async () => {
    enqueue({
      kind: "encrypt",
      scope: { networkId: "devnet", address: `oct${"A".repeat(44)}` },
      amount: 2_000_000,
      steps: ["step.one", "step.two"],
      run: () => new Promise(() => {}),
    });
    show();
    expect(await screen.findByText("proofs.running.encrypt")).toBeTruthy();
    expect(amountField().disabled).toBe(true);
    expect(amountField().value).toBe("2");
    expect(button("proofs.decrypt").disabled).toBe(true);
    fireEvent.click(button("activity.showProgress"));
    expect(getActivity().shown).toBe(getQueue().jobs[0].id);
  });
});

describe("Move between balances", () => {
  it("keeps Review off until the fee is live", () => {
    m.feeStatus = "loading";
    show();
    fireEvent.change(amountField(), { target: { value: "1" } });
    expect(button("sendFlow.reviewShort").disabled).toBe(true);
  });

  it("opens the review pop-up and Reject returns without signing, the amount kept", () => {
    show();
    fireEvent.change(amountField(), { target: { value: "1" } });
    fireEvent.click(button("sendFlow.reviewShort"));
    const review = popup("proofs.review.encrypt");
    expect(within(review).getByText("sendFlow.privateBalance")).toBeTruthy();
    fireEvent.click(within(review).getByRole("button", { name: "common.reject" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(amountField().value).toBe("1");
    expect(m.auth).not.toHaveBeenCalled();
    expect(getQueue().jobs).toHaveLength(0);
  });

  it("queues the reviewed encrypt after the auth step and shows its progress", async () => {
    show();
    fireEvent.change(amountField(), { target: { value: "2" } });
    fireEvent.click(button("sendFlow.reviewShort"));
    fireEvent.click(
      within(popup("proofs.review.encrypt")).getByRole("button", { name: "proofs.encrypt" }),
    );
    await waitFor(() => expect(m.encrypt).toHaveBeenCalled());
    expect(m.check).toHaveBeenCalledWith("devnet", "1000");
    expect(m.auth).toHaveBeenCalledTimes(1);
    expect(m.encrypt.mock.calls[0][1]).toBe(2_000_000);
    expect(m.encrypt.mock.calls[0][3]).toBe("1000");
    expect(getActivity().shown).toBe(getQueue().jobs[0].id);
    expect(amountField().value).toBe("");
  });

  it("signs nothing when the fee moved before signing", async () => {
    m.check.mockResolvedValue(FEE_CHANGED);
    show();
    fireEvent.change(amountField(), { target: { value: "2" } });
    fireEvent.click(button("sendFlow.reviewShort"));
    fireEvent.click(
      within(popup("proofs.review.encrypt")).getByRole("button", { name: "proofs.encrypt" }),
    );
    await waitFor(() => expect(m.check).toHaveBeenCalled());
    expect(m.auth).not.toHaveBeenCalled();
    expect(getQueue().jobs).toHaveLength(0);
    expect(popup("proofs.review.encrypt")).toBeTruthy();
  });

  it("encrypt Max leaves the fee in public OCT; the whole balance is refused", () => {
    show();
    fireEvent.click(button("sendFlow.max"));
    expect(amountField().value).toBe("9.999");
    expect(button("sendFlow.reviewShort").disabled).toBe(false);
    fireEvent.change(amountField(), { target: { value: "10" } });
    expect(screen.getByText(INSUFFICIENT_BALANCE)).toBeTruthy();
    expect(button("sendFlow.reviewShort").disabled).toBe(true);
  });

  it("the Decrypt switch turns the field into Decrypt, keeping the amount", () => {
    m.publicBalance = 999;
    show();
    fireEvent.change(amountField(), { target: { value: "5" } });
    fireEvent.click(button("proofs.decrypt"));
    expect(amountField("proofs.decrypt").value).toBe("5");
    expect(screen.getByText(FEE_SHORT)).toBeTruthy();
    expect(button("sendFlow.reviewShort").disabled).toBe(true);
  });
});

describe("Stopped proofs", () => {
  it("shows a stopped proof in the action bar with Remove and Try again, which asks for auth first", async () => {
    m.encrypt.mockRejectedValueOnce(new Error("The range proof did not verify."));
    show();
    fireEvent.change(amountField(), { target: { value: "2" } });
    fireEvent.click(button("sendFlow.reviewShort"));
    fireEvent.click(
      within(popup("proofs.review.encrypt")).getByRole("button", { name: "proofs.encrypt" }),
    );
    expect(await screen.findByText(/The range proof did not verify/)).toBeTruthy();
    expect(button("proofs.remove")).toBeTruthy();
    fireEvent.click(button("activity.tryAgain"));
    await waitFor(() => expect(m.encrypt).toHaveBeenCalledTimes(2));
    expect(m.auth).toHaveBeenCalledTimes(2);
  });
});

describe("Waiting for you", () => {
  it("lists the waiting transfers oldest first, each with its own Claim", async () => {
    m.outputs = [NEWER, OLDEST];
    show();
    const rows = await screen.findAllByRole("button", { name: "claim.claim" });
    expect(rows).toHaveLength(2);
    const list = rows[0].closest("section")!.textContent!;
    expect(list.indexOf("1.5")).toBeLessThan(list.indexOf("3"));
    expect(m.scan).toHaveBeenCalledWith("w1", `oct${"A".repeat(44)}`, "devnet");
  });

  it("queues exactly the reviewed transfer at the reviewed fee after Claim and auth", async () => {
    m.outputs = [NEWER, OLDEST];
    show();
    const rows = await screen.findAllByRole("button", { name: "claim.claim" });
    fireEvent.click(rows[1]);
    const review = popup("proofs.claim.review");
    expect(m.claim).not.toHaveBeenCalled();
    fireEvent.click(within(review).getByRole("button", { name: "claim.claim" }));
    await waitFor(() => expect(m.claim).toHaveBeenCalledTimes(1));
    expect(m.auth).toHaveBeenCalledTimes(1);
    expect(m.claim.mock.calls[0][1]).toMatchObject({ id: 9 });
    expect(m.claim.mock.calls[0][3]).toBe("1000");
  });

  it("Claim all reviews them together, asks once and queues one claim each", async () => {
    m.outputs = [NEWER, OLDEST];
    show();
    await screen.findAllByRole("button", { name: "claim.claim" });
    fireEvent.click(button("proofs.claimAll"));
    const review = popup("proofs.claimAll");
    expect(within(review).getByText("proofs.transfersN:2")).toBeTruthy();
    fireEvent.click(within(review).getByRole("button", { name: "proofs.claimAll" }));
    await waitFor(() => expect(getQueue().jobs).toHaveLength(2));
    expect(m.auth).toHaveBeenCalledTimes(1);
    expect(getQueue().jobs.map((j) => j.ref)).toEqual([4, 9]);
  });

  it("Claim all stays off when the layers allow only one claim", async () => {
    m.outputs = [NEWER, OLDEST];
    m.setup.baseLayers = 4;
    show();
    await screen.findAllByRole("button", { name: "claim.claim" });
    expect(button("proofs.claimAll").disabled).toBe(true);
  });

  it("says how many Claim all takes when the layers cap it", async () => {
    m.outputs = [NEWER, OLDEST];
    m.setup.baseLayers = 4;
    show();
    await screen.findAllByRole("button", { name: "claim.claim" });
    expect(screen.getByText(/^proofs\.atATime:/)).toBeTruthy();
  });

  it("switches the list to what finished today", async () => {
    m.outputs = [OLDEST];
    show();
    await screen.findByRole("button", { name: "claim.claim" });
    fireEvent.click(button("proofs.recent"));
    expect(screen.getByText("proofs.nothingToday")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "claim.claim" })).toBeNull();
    expect(screen.queryByRole("button", { name: "proofs.claimAll" })).toBeNull();
  });

  it("refuses a claim when public OCT does not cover the fee", async () => {
    m.outputs = [OLDEST];
    m.publicBalance = 999;
    show();
    fireEvent.click(await screen.findByRole("button", { name: "claim.claim" }));
    const review = popup("proofs.claim.review");
    expect(within(review).getByText(FEE_SHORT)).toBeTruthy();
    expect(
      (within(review).getByRole("button", { name: "claim.claim" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
