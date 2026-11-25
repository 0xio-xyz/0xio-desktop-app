// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "src/lib/query";

const m = vi.hoisted(() => ({ read: vi.fn(), call: vi.fn(), auth: vi.fn() }));

vi.mock("src/contexts/useWallet", () => ({ useWallet: () => ({ networkId: "devnet" }) }));
vi.mock("src/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("src/services/network/networkService", () => ({
  getRecommendedFeeStrict: (...a: unknown[]) => m.read(...a),
  captureScope: (address: string) => ({ address, networkId: "devnet" }),
  jsonRpcCall: vi.fn(async () => ({ methods: [{ name: "transfer" }] })),
  FeeUnavailableError: class extends Error {
    name = "FeeUnavailable";
  },
}));
vi.mock("src/services/contracts/contractService", () => ({
  callContract: (...a: unknown[]) => m.call(...a),
}));
vi.mock("src/hooks/transactions/useTransactionAuth", () => ({
  useTransactionAuth: () => ({
    requestAuth: (...a: unknown[]) => m.auth(...a),
    isOpen: false,
    handleResult: () => {},
    title: "",
  }),
}));
vi.mock("src/hooks/wallet/useTokenPrice", () => ({
  useTokenPrice: () => ({ getUsdValue: () => null, getPrice: () => null }),
}));
vi.mock("src/features/wallet/components/TransactionAuthModal", () => ({ default: () => null }));
vi.mock("src/features/wallet/components/AddressBookPicker", () => ({ default: () => null }));
vi.mock("src/shared/ui/Mascot", () => ({ default: () => null }));
vi.mock("src/features/nft/services/data", () => ({
  nftDisplayName: (d: { tokenId: string }) => `Piece #${d.tokenId}`,
}));

import "src/i18n";
import NftSendDrawer from "src/features/nft/components/NftSendDrawer";
import type { NftTokenDetail } from "src/features/nft/services/data";

const WALLET = `oct${"A".repeat(44)}`;
const TO = `oct${"B".repeat(44)}`;
const LIVE = { minimum: "1000", recommended: "1700", fast: "3400" };

function renderDrawer() {
  const qc = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
  return render(
    <QueryClientProvider client={qc}>
      <NftSendDrawer
        open
        onClose={() => {}}
        detail={{ tokenId: "7", image: null } as unknown as NftTokenDetail}
        collectionName="Shapes"
        contractAddress={`oct${"C".repeat(44)}`}
        walletAddress={WALLET}
        walletId="w1"
        onSent={() => {}}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  m.call.mockResolvedValue("hash");
  m.auth.mockResolvedValue(true);
});
afterEach(cleanup);

const toReview = () => {
  fireEvent.change(screen.getByPlaceholderText("oct..."), { target: { value: TO } });
  fireEvent.click(screen.getByText("Review transfer"));
};

describe("NFT send fee", () => {
  it("offers no fixed fee presets and cannot send until the fee is read", async () => {
    m.read.mockReturnValue(new Promise(() => {}));
    renderDrawer();
    for (const preset of ["3000", "5000", "10000", "30000"])
      expect(screen.queryByText(preset)).toBeNull();
    toReview();
    expect(screen.getByText("Reject")).toBeTruthy();
    const send = screen.getByText("Transfer").closest("button")!;
    expect(send.disabled).toBe(true);
    fireEvent.click(send);
    expect(m.call).not.toHaveBeenCalled();
  });

  it("signs the live call fee shown on the review", async () => {
    m.read.mockResolvedValue(LIVE);
    renderDrawer();
    toReview();
    await waitFor(() =>
      expect(screen.getByText("Transfer").closest("button")!.disabled).toBe(false),
    );
    await act(async () => {
      fireEvent.click(screen.getByText("Transfer"));
    });
    await waitFor(() => expect(m.call).toHaveBeenCalled());
    expect(m.read).toHaveBeenCalledWith("call", "devnet", undefined);
    expect(m.call).toHaveBeenCalledWith(
      expect.objectContaining({ method: "transfer", params: [TO, 7], ou: "1700" }),
    );
  });

  it("a minimum above the reviewed fee asks again and signs nothing", async () => {
    m.read
      .mockResolvedValueOnce(LIVE)
      .mockResolvedValue({ minimum: "2500", recommended: "2600", fast: "5200" });
    renderDrawer();
    toReview();
    await waitFor(() =>
      expect(screen.getByText("Transfer").closest("button")!.disabled).toBe(false),
    );
    await act(async () => {
      fireEvent.click(screen.getByText("Transfer"));
    });
    await waitFor(() =>
      expect(screen.getByText("The network fee changed. Review again.")).toBeTruthy(),
    );
    expect(m.auth).not.toHaveBeenCalled();
    expect(m.call).not.toHaveBeenCalled();
  });
});
