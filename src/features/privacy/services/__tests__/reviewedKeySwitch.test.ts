import { beforeEach, describe, expect, it, vi } from "vitest";

const ADDR = `oct${"A".repeat(44)}`;

const m = vi.hoisted(() => ({
  quote: vi.fn(),
  keySwitch: vi.fn(),
  submit: vi.fn(),
  build: vi.fn(),
  current: vi.fn(),
}));
vi.mock("src/features/privacy/services/privacyService", () => ({
  getKeySwitchFeeLive: (...a: unknown[]) => m.quote(...a),
  keySwitchBalance: (...a: unknown[]) => m.keySwitch(...a),
  submitKeyBoundMigration: (...a: unknown[]) => m.submit(...a),
  buildKeyBoundMigrationPayload: (...a: unknown[]) => m.build(...a),
  confirmKeySwitchOutcome: async () => ({ status: "confirmed" }),
  sourceCipherHash: async () => "h",
}));
vi.mock("src/hooks/privacy/usePvacSetup", () => ({ ensurePvacFor: vi.fn(async () => {}) }));
vi.mock("src/services/network/networkService", () => ({
  isScopeCurrent: (...a: unknown[]) => m.current(...a),
  getEncryptedBalance: async () => null,
}));
vi.mock("src/features/privacy/services/keySwitchService", () => ({
  recordPendingKeySwitch: vi.fn(),
  clearPendingKeySwitch: vi.fn(),
}));

import { keyUpdateReviewed } from "src/features/privacy/services/keyUpdate";
import { refreshReviewed } from "src/features/privacy/services/balanceRefresh";
import {
  FEE_CHANGED,
  FEE_SHORT,
  FEE_UNAVAILABLE,
  SCOPE_CHANGED,
} from "src/services/transactions/feeCopy";

const SCOPE = { networkId: "devnet", address: ADDR };
const base = { walletId: "w1", address: ADDR, networkId: "devnet", feeRaw: "1200000" };
const keyReview = { ...base, expect: { mode: "empty_key_switch" as const, amountMicro: 0 } };

beforeEach(() => {
  m.quote.mockReset().mockResolvedValue({ ou: 1_200_000, floorOu: 3_000 });
  m.keySwitch.mockReset().mockResolvedValue({ txHash: "k1" });
  m.submit.mockReset().mockResolvedValue({ txHash: "r1" });
  m.build.mockReset().mockResolvedValue({ migration: { source_cipher_hash: "h" } });
  m.current.mockReset().mockReturnValue(true);
});

describe("reviewed key update", () => {
  it("re-reads the strict fee and signs the fee shown with the mode shown", async () => {
    await keyUpdateReviewed(keyReview, 5_000_000);
    expect(m.quote).toHaveBeenCalledWith("recommended", "devnet");
    expect(m.keySwitch).toHaveBeenCalledWith(SCOPE, "w1", {
      ou: "1200000",
      expect: keyReview.expect,
      onStep: undefined,
    });
  });

  it.each([1_500_000, 900_000])(
    "signs the fee shown when the recommendation moved to %s and the node still takes it",
    async (ou) => {
      m.quote.mockResolvedValue({ ou, floorOu: 3_000 });
      await keyUpdateReviewed(keyReview, 5_000_000);
      expect(m.keySwitch).toHaveBeenCalledWith(
        SCOPE,
        "w1",
        expect.objectContaining({ ou: "1200000" }),
      );
    },
  );

  it("refuses when the node now takes only more and hands the new fee back", async () => {
    m.quote.mockResolvedValue({ ou: 1_500_000, floorOu: 1_200_001 });
    await expect(keyUpdateReviewed(keyReview, 5_000_000)).rejects.toMatchObject({
      message: FEE_CHANGED,
      liveFeeRaw: "1500000",
    });
    expect(m.keySwitch).not.toHaveBeenCalled();
  });

  it("refuses on a failed read, a moved scope or a short public balance", async () => {
    m.quote.mockRejectedValueOnce(new Error("503"));
    await expect(keyUpdateReviewed(keyReview, null)).rejects.toThrow(FEE_UNAVAILABLE);
    await expect(keyUpdateReviewed(keyReview, 1_000_000)).rejects.toThrow(FEE_SHORT);
    m.current.mockReturnValue(false);
    await expect(keyUpdateReviewed(keyReview, null)).rejects.toThrow(SCOPE_CHANGED);
    expect(m.keySwitch).not.toHaveBeenCalled();
  });
});

describe("reviewed balance refresh (Migrate balance)", () => {
  it("re-reads the fee on the tier it showed and signs that fee", async () => {
    const out = await refreshReviewed({ ...base, reuse: false }, 5_000_000);
    expect(out.status).toBe("confirmed");
    expect(m.quote).toHaveBeenCalledWith("recommended", "devnet");
    expect(m.submit).toHaveBeenCalledWith(SCOPE, "w1", expect.any(Object), { ou: "1200000" });
  });

  it("signs the fee shown when the fast tier moved but the node still takes it", async () => {
    m.quote.mockResolvedValue({ ou: 2_600_000, floorOu: 3_000 });
    await refreshReviewed({ ...base, reuse: false }, 5_000_000);
    expect(m.submit).toHaveBeenCalledWith(SCOPE, "w1", expect.any(Object), { ou: "1200000" });
  });

  it("refuses a fee the node no longer takes before building any proof", async () => {
    m.quote.mockResolvedValue({ ou: 2_400_000, floorOu: 1_300_000 });
    await expect(refreshReviewed({ ...base, reuse: true }, 5_000_000)).rejects.toMatchObject({
      message: FEE_CHANGED,
      liveFeeRaw: "2400000",
    });
    expect(m.quote).toHaveBeenCalledWith("fast", "devnet");
    expect(m.build).not.toHaveBeenCalled();
    expect(m.submit).not.toHaveBeenCalled();
  });

  it("refuses on a failed read or a moved scope", async () => {
    m.quote.mockRejectedValueOnce(new Error("503"));
    await expect(refreshReviewed({ ...base, reuse: false }, null)).rejects.toThrow(FEE_UNAVAILABLE);
    m.current.mockReturnValue(false);
    await expect(refreshReviewed({ ...base, reuse: false }, null)).rejects.toThrow(SCOPE_CHANGED);
    expect(m.submit).not.toHaveBeenCalled();
  });
});
