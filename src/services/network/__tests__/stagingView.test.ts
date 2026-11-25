import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { getStagingView } from "src/services/network/networkService";
import { formatOCT } from "src/lib/format";

vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));

/** Verbatim staging_view row for the 250 OCT decrypt, captured from devnet. */
const REAL_ROW = {
  hash: "1fba8bbd81631e5fb48f294e3299569d0f416c710a807d11ad8402b89b9ea4d3",
  from: "oct2qyupyPfAof4kJ8LcTdN7fyQkLxiKhfemLCz94NNoxio",
  to: "oct2qyupyPfAof4kJ8LcTdN7fyQkLxiKhfemLCz94NNoxio",
  amount: "250",
  amount_raw: "250000000",
  nonce: 255,
  ou: "39431",
  timestamp: 1785478788.375,
  op_type: "decrypt",
  message: null,
};

function mockRpc(transactions: unknown[]) {
  vi.mocked(tauriFetch).mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ jsonrpc: "2.0", id: 1, result: { transactions } }),
  } as unknown as Response);
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

describe("getStagingView amount units", () => {
  it("renders a 250 OCT decrypt as 250, not 0.00025", async () => {
    mockRpc([REAL_ROW]);
    const [tx] = await getStagingView();
    expect(formatOCT(parseInt(tx.amount))).toBe("250");
  });

  it("would have shown 0.00025 without normalization", () => {
    // staging_view's `amount` is OCT: formatOCT must not divide by 1e6 twice.
    expect(formatOCT(parseInt(REAL_ROW.amount))).toBe("0.00025");
  });

  it("keeps amount when amount_raw is absent", async () => {
    mockRpc([{ hash: "h", from: "a", to: "b", amount: "999", nonce: 1 }]);
    const [tx] = await getStagingView();
    expect(tx.amount).toBe("999");
  });

  it("returns an empty list when the RPC fails", async () => {
    vi.mocked(tauriFetch).mockRejectedValue(new Error("node down"));
    vi.useFakeTimers();
    const view = getStagingView();
    await vi.runAllTimersAsync();
    vi.useRealTimers();
    await expect(view).resolves.toEqual([]);
  });
});
