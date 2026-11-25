// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "src/lib/router";
import { QueryClient, QueryClientProvider } from "src/lib/query";
import "src/i18n";

const m = vi.hoisted(() => ({
  navigate: vi.fn(),
  wallet: {} as Record<string, unknown>,
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
vi.mock("src/hooks/privacy/useClaimableCount", () => ({ useClaimableCount: () => 0 }));
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
  const view = render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <HomeScreen />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await act(() => new Promise((r) => setTimeout(r, 10)));
  return view;
};

beforeEach(() => {
  m.navigate.mockReset();
});
afterEach(cleanup);

describe("Home Back up tag", () => {
  it("shows Back up first for a wallet that is not written down, and opens the backup", async () => {
    m.wallet = { ...WALLET, needs_backup: true };
    await show();
    const tag = screen.getByRole("button", { name: "Back up" });
    const order = [tag, screen.getByText("Key update blocked"), screen.getByText("Set up private")];
    for (let i = 1; i < order.length; i++) {
      expect(
        order[i - 1].compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
    fireEvent.click(tag);
    expect(m.navigate).toHaveBeenCalledWith("/backup");
  });

  it("is absent once backed up, and for a watch-only wallet", async () => {
    m.wallet = { ...WALLET, needs_backup: false };
    const first = await show();
    expect(screen.queryByRole("button", { name: "Back up" })).toBeNull();
    first.unmount();
    m.wallet = { ...WALLET, wallet_type: "watch", needs_backup: true };
    await show();
    expect(screen.queryByRole("button", { name: "Back up" })).toBeNull();
  });
});
