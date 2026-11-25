import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  quote: vi.fn(),
  live: vi.fn(),
  register: vi.fn(),
  ensure: vi.fn(),
  current: vi.fn(),
}));
vi.mock("src/features/privacy/services/privacyService", () => ({
  getKeySwitchFeeQuote: (...a: unknown[]) => m.quote(...a),
  getKeySwitchFeeLive: (...a: unknown[]) => m.live(...a),
  registerPvacKey: (...a: unknown[]) => m.register(...a),
}));
vi.mock("src/hooks/privacy/usePvacSetup", () => ({
  ensurePvacFor: (...a: unknown[]) => m.ensure(...a),
}));
vi.mock("src/services/network/networkService", () => ({
  isScopeCurrent: (...a: unknown[]) => m.current(...a),
}));

import {
  readSetupFee,
  setupScopeError,
  turnOnReviewed,
} from "src/features/privacy/services/setupReview";
import {
  FEE_CHANGED,
  FEE_SHORT,
  FEE_UNAVAILABLE,
  SCOPE_CHANGED,
} from "src/services/transactions/feeCopy";

const ADDR = `oct${"A".repeat(44)}`;
const review = { walletId: "w1", address: ADDR, networkId: "devnet", feeRaw: "1200000" };

beforeEach(() => {
  m.quote.mockReset().mockResolvedValue("1200000");
  m.live.mockReset().mockResolvedValue({ ou: 1_200_000, floorOu: 3_000 });
  m.register.mockReset().mockResolvedValue(undefined);
  m.ensure.mockReset().mockResolvedValue(undefined);
  m.current.mockReset().mockReturnValue(true);
});

describe("turn on private balance after the review", () => {
  it("signs exactly the reviewed fee on the reviewed wallet and network", async () => {
    await turnOnReviewed(review, 5_000_000);
    expect(m.live).toHaveBeenCalledWith("recommended", "devnet");
    expect(m.register).toHaveBeenCalledTimes(1);
    expect(m.register).toHaveBeenCalledWith({ networkId: "devnet", address: ADDR }, "w1", {
      ou: "1200000",
    });
  });

  it.each([1_500_000, 1_000_000])(
    "signs the reviewed fee when the recommendation moved to %s",
    async (ou) => {
      m.live.mockResolvedValue({ ou, floorOu: 3_000 });
      await turnOnReviewed(review, 5_000_000);
      expect(m.register).toHaveBeenCalledWith({ networkId: "devnet", address: ADDR }, "w1", {
        ou: "1200000",
      });
    },
  );

  it("refuses with the fee-changed copy and hands back the new fee", async () => {
    m.live.mockResolvedValue({ ou: 1_500_000, floorOu: 1_250_000 });
    await expect(turnOnReviewed(review, 5_000_000)).rejects.toMatchObject({
      message: FEE_CHANGED,
      liveFeeRaw: "1500000",
    });
    expect(m.register).not.toHaveBeenCalled();
  });

  it("refuses when the fee cannot be read", async () => {
    m.live.mockRejectedValue(Object.assign(new Error("x"), { name: "FeeUnavailable" }));
    await expect(turnOnReviewed(review, 5_000_000)).rejects.toThrow(FEE_UNAVAILABLE);
    expect(m.register).not.toHaveBeenCalled();
  });

  it("refuses when the wallet or network moved", async () => {
    m.current.mockReturnValue(false);
    await expect(turnOnReviewed(review, 5_000_000)).rejects.toThrow(SCOPE_CHANGED);
    expect(m.live).not.toHaveBeenCalled();
    expect(m.register).not.toHaveBeenCalled();
  });

  it("refuses when the public balance does not cover the fee", async () => {
    await expect(turnOnReviewed(review, 1_000_000)).rejects.toThrow(FEE_SHORT);
    expect(m.register).not.toHaveBeenCalled();
  });

  it("treats a submitted registration as done", async () => {
    m.register.mockRejectedValue(Object.assign(new Error("pending"), { name: "PvacSetupPending" }));
    await expect(turnOnReviewed(review, null)).resolves.toBeUndefined();
  });
});

describe("setup review reads", () => {
  it("reads the fee strictly and maps a failure to the house copy", async () => {
    expect(await readSetupFee("mainnet")).toBe("1200000");
    m.quote.mockRejectedValue(new Error("503"));
    await expect(readSetupFee("mainnet")).rejects.toThrow(FEE_UNAVAILABLE);
  });

  it("pins wallet, address and network", () => {
    const live = { walletId: "w1", address: ADDR, networkId: "devnet" };
    expect(setupScopeError(review, live)).toBeNull();
    expect(setupScopeError(review, { ...live, walletId: "w2" })).toBe(SCOPE_CHANGED);
    expect(setupScopeError(review, { ...live, networkId: "mainnet" })).toBe(SCOPE_CHANGED);
    expect(setupScopeError(review, { ...live, address: null })).toBe(SCOPE_CHANGED);
  });
});
