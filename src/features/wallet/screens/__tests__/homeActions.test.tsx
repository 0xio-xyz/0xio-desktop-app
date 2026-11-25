// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "src/lib/router";
import { QueryClient, QueryClientProvider } from "src/lib/query";
import "src/i18n";

const m = vi.hoisted(() => ({
  navigate: vi.fn(),
  wallet: {} as Record<string, unknown>,
  claims: 0,
}));

vi.mock("src/lib/router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("src/lib/router")>()),
  useNavigate: () => m.navigate,
}));
vi.mock("src/contexts/useWallet", () => ({
  useWallet: () => ({
    activeWallet: m.wallet,
    networkId: "devnet",
    showBalanceValues: true,
    toggleBalanceVisibility: vi.fn(),
    pvacForeign: false,
    pvacLegacy: false,
    refreshWallets: vi.fn(),
  }),
}));
vi.mock("src/hooks/wallet/useBalance", () => ({
  useBalance: () => ({
    publicBalance: 0,
    privateBalance: 0,
    isLoading: false,
    refetch: vi.fn(),
    isRefetching: false,
    isPvacLoading: false,
  }),
}));
vi.mock("src/hooks/wallet/useTokens", () => ({
  useTokens: () => ({ tokens: [], addImportedToken: vi.fn() }),
}));
vi.mock("src/hooks/wallet/useTokenPrice", () => ({
  useTokenPrice: () => ({ getPrice: () => 0, prices: {} }),
}));
vi.mock("src/hooks/transactions/useTransactionHistory", () => ({
  useTransactionHistory: () => ({ transactions: [], isLoading: false }),
}));
vi.mock("src/hooks/privacy/useClaimableCount", () => ({ useClaimableCount: () => m.claims }));
vi.mock("src/services/storage/balanceHistory", () => ({ getSnapshots: () => [] }));
vi.mock("src/shared/layout/TopBar", () => ({ default: () => null }));
vi.mock("src/shared/ui/Mascot", () => ({ default: () => null }));
vi.mock("src/features/wallet/components/HomeTxSheet", () => ({ default: () => null }));
vi.mock("src/features/wallet/components/ImportTokenModal", () => ({ default: () => null }));
vi.mock("src/features/privacy/components/KeyBlockedTag", () => ({
  default: () => <button type="button">Key update blocked</button>,
}));
vi.mock("src/features/privacy/components/SetupPrivateTag", () => ({
  default: () => <button type="button">Set up private</button>,
}));

import HomeScreen from "src/features/wallet/screens/HomeScreen";

const WALLET = {
  id: "w1",
  name: "Wallet 1",
  address: `oct${"A".repeat(44)}`,
  wallet_type: "hd",
  is_active: true,
  created_at: 0,
  source: "mnemonic",
};

const show = async () => {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <HomeScreen />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await act(() => new Promise((r) => setTimeout(r, 10)));
};

const press = (key: string, target: Element | Window = window) =>
  fireEvent.keyDown(target, { key, metaKey: true });

beforeEach(() => {
  m.navigate.mockReset();
  m.wallet = WALLET;
  m.claims = 0;
});
afterEach(cleanup);

describe("Home actions", () => {
  it("runs Send, Receive, Privacy and History from the keyboard", async () => {
    await show();
    press("s");
    press("r");
    press("e");
    press("y");
    expect(m.navigate.mock.calls.map((c) => c[0])).toEqual([
      "/send",
      "/receive",
      "/privacy",
      "/history",
    ]);
  });

  it("opens the claims and names the count when transfers wait", async () => {
    m.claims = 3;
    await show();
    fireEvent.click(screen.getByRole("button", { name: /3$/ }));
    expect(m.navigate).toHaveBeenCalledWith("/privacy?tab=claim");
  });

  it("leaves the shortcuts alone while typing in a field", async () => {
    await show();
    const field = document.createElement("input");
    document.body.appendChild(field);
    press("s", field);
    expect(m.navigate).not.toHaveBeenCalled();
    field.remove();
  });
});
