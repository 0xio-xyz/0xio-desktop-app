// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "src/lib/router";

const ME = `oct${"M".repeat(44)}`;
const m = vi.hoisted(() => ({
  watch: false,
  clipboard: vi.fn(),
  qr: vi.fn(),
  setNetworkId: vi.fn(),
}));

vi.mock("src/i18n/react", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));
vi.mock("src/contexts/useWallet", () => ({
  useWallet: () => ({
    activeWallet: { id: "w1", name: "Main", address: ME, wallet_type: m.watch ? "watch" : "hd" },
    wallets: [{ id: "w1", name: "Main", address: ME }],
    networkId: "devnet",
    setNetworkId: m.setNetworkId,
  }),
}));
vi.mock("src/shared/ui/flat", () => ({
  Screen: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PageTitle: ({ title, right }: { title: string; right?: React.ReactNode }) => (
    <div>
      <h1>{title}</h1>
      {right}
    </div>
  ),
  PillTabs: ({
    tabs,
    onChange,
  }: {
    tabs: { id: string; label: string }[];
    onChange: (id: string) => void;
  }) => (
    <div>
      {tabs.map((tab) => (
        <button key={tab.id} type="button" onClick={() => onChange(tab.id)}>
          {tab.label}
        </button>
      ))}
    </div>
  ),
}));
vi.mock("src/shared/ui/WalletAvatar", () => ({ default: () => null }));
vi.mock("src/hooks/privacy/useClaimableCount", () => ({ useClaimableCount: () => 2 }));
vi.mock("src/features/transactions/hooks/useHistoryPages", () => ({
  useHistoryPages: () => ({ rows: [], isLoading: false }),
}));
vi.mock("src/lib/qr", () => ({
  qrToCanvas: (...a: unknown[]) => m.qr(...a),
}));

import ReceiveScreen from "src/features/wallet/screens/ReceiveScreen";

function show() {
  return render(
    <MemoryRouter>
      <ReceiveScreen />
    </MemoryRouter>,
  );
}
const button = (name: string) => screen.getByRole("button", { name });

beforeEach(() => {
  vi.useFakeTimers();
  m.watch = false;
  m.qr.mockClear();
  m.clipboard.mockReset().mockResolvedValue(undefined);
  Object.assign(navigator, { clipboard: { writeText: m.clipboard } });
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("Receive", () => {
  it("copies the bare address and says Copied in place, then goes back", async () => {
    show();
    await act(async () => {
      fireEvent.click(button("receive.copyAddress"));
    });
    expect(m.clipboard).toHaveBeenCalledWith(ME);
    expect(button("common.copied")).toBeTruthy();
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(button("receive.copyAddress")).toBeTruthy();
  });

  it("turns the code and the copy into a request once an amount is typed", async () => {
    show();
    fireEvent.click(button("receive.addAmount"));
    fireEvent.change(screen.getByLabelText("receive.amount"), { target: { value: "25.50" } });
    expect(m.qr).toHaveBeenLastCalledWith(
      expect.anything(),
      `octra:${ME}?amount=25.5`,
      expect.anything(),
    );
    await act(async () => {
      fireEvent.click(button("receive.copyLink"));
    });
    expect(m.clipboard).toHaveBeenCalledWith(`octra:${ME}?amount=25.5`);
    fireEvent.click(button("receive.clearAmount"));
    expect(button("receive.copyAddress")).toBeTruthy();
  });

  it("reads waiting transfers on the other tab and offers to switch to that network", () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: "history.mainnet" }));
    expect(screen.getByText("receive.waiting")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "receive.switchTo" }));
    expect(m.setNetworkId).toHaveBeenCalledWith("mainnet");
  });

  it("shows the code for a watch-only wallet and marks private transfers not available", () => {
    m.watch = true;
    show();
    expect(screen.getByText("settings.notAvailable")).toBeTruthy();
    expect(screen.queryByText("receive.waiting")).toBeNull();
    expect(m.qr).toHaveBeenCalledWith(expect.anything(), ME, expect.anything());
  });
});
