// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "src/lib/query";

const ADDR = `oct${"A".repeat(44)}`;

const m = vi.hoisted(() => ({
  quote: vi.fn(),
  live: vi.fn(),
  keySwitch: vi.fn(),
  mode: vi.fn(),
  current: vi.fn(),
  auth: vi.fn(),
  setForeign: vi.fn(),
  showMessage: vi.fn(),
}));
vi.mock("src/features/privacy/services/privacyService", () => ({
  getKeySwitchFeeQuote: (...a: unknown[]) => m.quote(...a),
  getKeySwitchFeeLive: (...a: unknown[]) => m.live(...a),
  keySwitchBalance: (...a: unknown[]) => m.keySwitch(...a),
  resolveKeySwitchMode: (...a: unknown[]) => m.mode(...a),
}));
vi.mock("src/hooks/privacy/usePvacSetup", () => ({ ensurePvacFor: vi.fn(async () => {}) }));
vi.mock("src/services/network/networkService", () => ({
  isScopeCurrent: (...a: unknown[]) => m.current(...a),
}));
vi.mock("src/features/privacy/services/keySwitchService", () => ({
  loadBlockedAck: () => null,
  saveBlockedAck: vi.fn(),
  clearBlockedAck: vi.fn(),
}));
vi.mock("src/contexts/useWallet", () => ({
  useWallet: () => ({
    pvacForeign: true,
    setPvacForeign: m.setForeign,
    activeWallet: { id: "w1", name: "Main", address: ADDR },
    showMessage: m.showMessage,
    networkId: "devnet",
  }),
}));
vi.mock("src/hooks/transactions/useTransactionAuth", () => ({
  useTransactionAuth: () => ({
    isOpen: false,
    title: "",
    requestAuth: (...a: unknown[]) => m.auth(...a),
    handleResult: () => {},
  }),
}));
vi.mock("src/features/wallet/components/TransactionAuthModal", () => ({ default: () => null }));

import KeySwitchOverlay from "src/features/privacy/components/KeySwitchOverlay";
import {
  FEE_CHANGED,
  FEE_SHORT,
  FEE_UNAVAILABLE,
  SCOPE_CHANGED,
} from "src/services/transactions/feeCopy";

let qc: QueryClient;
function show() {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <KeySwitchOverlay />
    </QueryClientProvider>,
  );
}

const alertText = () => screen.queryByRole("alert")?.textContent ?? null;
const confirmButton = () =>
  screen.getByRole("button", { name: /^(Switch Encryption Key|Migrate Balance & Switch Key)$/ });
async function confirm() {
  await screen.findByText("1.2 OCT");
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(confirmButton());
}

beforeEach(() => {
  m.quote.mockReset().mockResolvedValue("1200000");
  m.live.mockReset().mockResolvedValue({ ou: 1_200_000, floorOu: 3_000 });
  m.keySwitch.mockReset().mockResolvedValue({ txHash: "abc" });
  m.mode.mockReset().mockResolvedValue({ mode: "empty_key_switch" });
  m.current.mockReset().mockReturnValue(true);
  m.auth.mockReset().mockResolvedValue(true);
  m.setForeign.mockReset();
  m.showMessage.mockReset();
});
afterEach(cleanup);

describe("encryption key update review", () => {
  it("shows the wallet, the network and the live strict fee before anything is signed", async () => {
    show();
    await screen.findByText("1.2 OCT");
    expect(screen.getByText("Main")).toBeTruthy();
    expect(screen.getByText("Octra Devnet")).toBeTruthy();
    expect(screen.getByText("Network fee")).toBeTruthy();
    expect(m.quote).toHaveBeenCalledWith("recommended", "devnet");
    expect(m.auth).not.toHaveBeenCalled();
    expect(m.keySwitch).not.toHaveBeenCalled();
  });

  it("asks for Touch ID or the password and signs the fee it showed", async () => {
    show();
    await confirm();
    await waitFor(() => expect(m.keySwitch).toHaveBeenCalledTimes(1));
    expect(m.auth).toHaveBeenCalledWith("Update encryption key");
    expect(m.keySwitch).toHaveBeenCalledWith({ networkId: "devnet", address: ADDR }, "w1", {
      ou: "1200000",
      expect: { mode: "empty_key_switch", amountMicro: 0 },
      onStep: undefined,
    });
    expect(m.setForeign).toHaveBeenCalledWith(false);
  });

  it("carries the balance it showed into a migrating update", async () => {
    m.mode.mockResolvedValue({
      mode: "legacy_public_migration",
      amount: 3_000_000,
      oldCipher: "c",
    });
    show();
    await screen.findByText(/Your private balance of 3 OCT/);
    await confirm();
    await waitFor(() => expect(m.keySwitch).toHaveBeenCalled());
    expect(m.keySwitch.mock.calls[0][2]).toMatchObject({
      ou: "1200000",
      expect: { mode: "legacy_public_migration", amountMicro: 3_000_000 },
    });
  });

  it("signs nothing when the auth step is cancelled", async () => {
    m.auth.mockResolvedValue(false);
    show();
    await confirm();
    await waitFor(() => expect(m.auth).toHaveBeenCalled());
    expect(m.keySwitch).not.toHaveBeenCalled();
  });

  it("signs the fee it showed when the recommendation moved but the node still takes it", async () => {
    m.live.mockResolvedValue({ ou: 1_500_000, floorOu: 3_000 });
    show();
    await confirm();
    await waitFor(() => expect(m.keySwitch).toHaveBeenCalledTimes(1));
    expect(m.keySwitch.mock.calls[0][2]).toMatchObject({ ou: "1200000" });
    expect(alertText()).toBeNull();
  });

  it("refuses a changed fee and shows the new one to review again", async () => {
    show();
    await screen.findByText("1.2 OCT");
    m.live.mockResolvedValue({ ou: 1_500_000, floorOu: 1_500_000 });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(confirmButton());
    await waitFor(() => expect(alertText()).toBe(FEE_CHANGED));
    expect(m.keySwitch).not.toHaveBeenCalled();
    await screen.findByText("1.5 OCT");
    fireEvent.click(confirmButton());
    await waitFor(() => expect(m.keySwitch).toHaveBeenCalled());
    expect(m.keySwitch.mock.calls[0][2]).toMatchObject({ ou: "1500000" });
  });

  it("blocks on a failed fee read until Retry reads one", async () => {
    m.quote.mockRejectedValue(new Error("503"));
    show();
    await waitFor(() => expect(alertText()).toBe(FEE_UNAVAILABLE));
    expect(screen.queryByRole("button", { name: "Switch Encryption Key" })).toBeNull();
    m.quote.mockResolvedValue("1200000");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText("1.2 OCT");
    expect(alertText()).toBeNull();
    expect(m.keySwitch).not.toHaveBeenCalled();
  });

  it("refuses when the wallet or network moved before signing", async () => {
    show();
    await screen.findByText("1.2 OCT");
    m.current.mockReturnValue(false);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(confirmButton());
    await waitFor(() => expect(alertText()).toBe(SCOPE_CHANGED));
    expect(m.keySwitch).not.toHaveBeenCalled();
  });

  it("refuses when public OCT does not cover the fee", async () => {
    show();
    await screen.findByText("1.2 OCT");
    qc.setQueryData(["balance", ADDR, "devnet"], { balance: 1_000_000 });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(confirmButton());
    await waitFor(() => expect(alertText()).toBe(FEE_SHORT));
    expect(m.keySwitch).not.toHaveBeenCalled();
  });
});
