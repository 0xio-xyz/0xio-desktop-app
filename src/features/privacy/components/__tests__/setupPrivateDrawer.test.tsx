// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "src/lib/query";
import "src/i18n";

const m = vi.hoisted(() => ({
  quote: vi.fn(),
  live: vi.fn(),
  register: vi.fn(),
  current: vi.fn(),
  auth: vi.fn(),
  wallet: {
    activeWallet: { id: "w1", name: "Main", address: `oct${"A".repeat(44)}` } as {
      id: string;
      name: string;
      address: string;
    } | null,
    networkId: "devnet",
  },
}));
vi.mock("src/features/privacy/services/privacyService", () => ({
  getKeySwitchFeeQuote: (...a: unknown[]) => m.quote(...a),
  getKeySwitchFeeLive: (...a: unknown[]) => m.live(...a),
  registerPvacKey: (...a: unknown[]) => m.register(...a),
  getPvacRegistrationState: async () => "registered",
}));
vi.mock("src/hooks/privacy/usePvacSetup", () => ({ ensurePvacFor: vi.fn(async () => {}) }));
vi.mock("src/services/network/networkService", () => ({
  isScopeCurrent: (...a: unknown[]) => m.current(...a),
}));
vi.mock("src/contexts/useWallet", () => ({ useWallet: () => m.wallet }));
vi.mock("src/hooks/transactions/useTransactionAuth", () => ({
  useTransactionAuth: () => ({
    isOpen: false,
    title: "",
    requestAuth: (...a: unknown[]) => m.auth(...a),
    handleResult: () => {},
  }),
}));
vi.mock("src/features/wallet/components/TransactionAuthModal", () => ({ default: () => null }));
vi.mock("src/shared/ui/Mascot", () => ({ default: () => null }));
vi.mock("src/shared/ui/WalletAvatar", () => ({ default: () => null }));

import SetupPrivateDrawer from "src/features/privacy/components/SetupPrivateDrawer";
import TurnOnReview from "src/features/privacy/components/TurnOnReview";
import { resetQueue } from "src/features/privacy/services/proofQueue";
import { FEE_CHANGED, FEE_UNAVAILABLE, SCOPE_CHANGED } from "src/services/transactions/feeCopy";

const ADDR = `oct${"A".repeat(44)}`;

function wrap(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui = (n: ReactNode) => <QueryClientProvider client={qc}>{n}</QueryClientProvider>;
  const view = render(ui(node));
  return { ...view, rerenderWith: (n: ReactNode) => view.rerender(ui(n)) };
}

const turnOn = () => screen.getByRole("button", { name: /^(Turn on|Try again)$/ });
const alertText = () => screen.queryByRole("alert")?.textContent || null;
// An Amount draws the figure and its unit in separate spans; match the span holding both.
const findFee = (text: string) =>
  screen.findAllByText(
    (_, el) =>
      el?.tagName === "SPAN" &&
      el.className.includes("whitespace-nowrap") &&
      el.textContent === text.replace(" ", ""),
  );

beforeEach(() => {
  m.quote.mockReset().mockResolvedValue("1200000");
  m.live.mockReset().mockResolvedValue({ ou: 1_200_000, floorOu: 3_000 });
  m.register.mockReset().mockResolvedValue(undefined);
  m.current.mockReset().mockReturnValue(true);
  m.auth.mockReset().mockResolvedValue(true);
  m.wallet.activeWallet = { id: "w1", name: "Main", address: ADDR };
  m.wallet.networkId = "devnet";
});
afterEach(cleanup);

describe("Turn on review pop-up", () => {
  it("shows the wallet, the network and the live fee, and signs nothing before Turn on", async () => {
    resetQueue();
    const onReject = vi.fn();
    wrap(<TurnOnReview open publicBalance={5_000_000} onReject={onReject} />);
    await waitFor(() => expect(m.quote).toHaveBeenCalledWith("recommended", "devnet"));
    expect(screen.getByText("Main")).toBeTruthy();
    expect(screen.getByText("Octra Devnet")).toBeTruthy();
    expect(m.register).not.toHaveBeenCalled();
    expect(m.auth).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(onReject).toHaveBeenCalled();
    expect(m.register).not.toHaveBeenCalled();
  });

  it("runs the reviewed fee through the proof queue after the auth step", async () => {
    resetQueue();
    wrap(<TurnOnReview open publicBalance={5_000_000} onReject={() => {}} />);
    const verb = await screen.findByRole("button", { name: "Turn on" });
    await waitFor(() => expect((verb as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(verb);
    await waitFor(() => expect(m.register).toHaveBeenCalled());
    expect(m.auth).toHaveBeenCalledWith("Turn on private balance");
    expect(m.register).toHaveBeenCalledWith({ networkId: "devnet", address: ADDR }, "w1", {
      ou: "1200000",
    });
  });
});

describe("setup review", () => {
  it("signs the fee it showed after the auth step", async () => {
    const onDone = vi.fn();
    wrap(<SetupPrivateDrawer publicBalance={5_000_000} onClose={() => {}} onDone={onDone} />);
    await findFee("1.2 OCT");
    fireEvent.click(turnOn());
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(m.auth).toHaveBeenCalledWith("Turn on private balance");
    expect(m.register).toHaveBeenCalledWith({ networkId: "devnet", address: ADDR }, "w1", {
      ou: "1200000",
    });
  });

  it("signs nothing when the auth step is cancelled", async () => {
    m.auth.mockResolvedValue(false);
    wrap(<SetupPrivateDrawer publicBalance={5_000_000} onClose={() => {}} onDone={() => {}} />);
    await findFee("1.2 OCT");
    fireEvent.click(turnOn());
    await waitFor(() => expect(m.auth).toHaveBeenCalled());
    expect(m.register).not.toHaveBeenCalled();
  });

  it("signs the fee it showed when the recommendation moved but the node still takes it", async () => {
    const onDone = vi.fn();
    m.live.mockResolvedValue({ ou: 1_000_000, floorOu: 3_000 });
    wrap(<SetupPrivateDrawer publicBalance={5_000_000} onClose={() => {}} onDone={onDone} />);
    await findFee("1.2 OCT");
    fireEvent.click(turnOn());
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(m.register).toHaveBeenCalledWith(expect.anything(), "w1", { ou: "1200000" });
  });

  it("refuses a changed fee and shows the new one to review again", async () => {
    const onDone = vi.fn();
    wrap(<SetupPrivateDrawer publicBalance={5_000_000} onClose={() => {}} onDone={onDone} />);
    await findFee("1.2 OCT");
    m.live.mockResolvedValue({ ou: 1_500_000, floorOu: 1_500_000 });
    fireEvent.click(turnOn());
    await waitFor(() => expect(alertText()).toBe(FEE_CHANGED));
    expect(m.register).not.toHaveBeenCalled();
    await findFee("1.5 OCT");
    fireEvent.click(turnOn());
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(m.register).toHaveBeenCalledWith(expect.anything(), "w1", { ou: "1500000" });
  });

  it("blocks on a failed fee read until Retry reads one", async () => {
    m.quote.mockRejectedValue(new Error("503"));
    wrap(<SetupPrivateDrawer publicBalance={5_000_000} onClose={() => {}} onDone={() => {}} />);
    await waitFor(() => expect(alertText()).toBe(FEE_UNAVAILABLE));
    expect((turnOn() as HTMLButtonElement).disabled).toBe(true);
    m.quote.mockResolvedValue("1200000");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await findFee("1.2 OCT");
    expect(alertText()).toBeNull();
    expect((turnOn() as HTMLButtonElement).disabled).toBe(false);
    expect(m.register).not.toHaveBeenCalled();
  });

  it("refuses when the wallet changed during the review", async () => {
    const node = () => (
      <SetupPrivateDrawer publicBalance={5_000_000} onClose={() => {}} onDone={() => {}} />
    );
    const v = wrap(node());
    await findFee("1.2 OCT");
    m.wallet.activeWallet = { id: "w2", name: "Other", address: `oct${"B".repeat(44)}` };
    v.rerenderWith(node());
    expect(alertText()).toBe(SCOPE_CHANGED);
    expect((turnOn() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(turnOn());
    expect(m.auth).not.toHaveBeenCalled();
    expect(m.register).not.toHaveBeenCalled();
  });

  it("refuses when the network moved after the auth step", async () => {
    wrap(<SetupPrivateDrawer publicBalance={5_000_000} onClose={() => {}} onDone={() => {}} />);
    await findFee("1.2 OCT");
    m.current.mockReturnValue(false);
    fireEvent.click(turnOn());
    await waitFor(() => expect(alertText()).toBe(SCOPE_CHANGED));
    expect(m.register).not.toHaveBeenCalled();
  });
});
