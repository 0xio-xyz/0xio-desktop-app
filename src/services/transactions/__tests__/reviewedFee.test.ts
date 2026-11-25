import { describe, expect, it } from "vitest";
import { liveFeeOf, reviewedFeeError } from "src/services/transactions/reviewedFee";
import { FEE_CHANGED, FEE_UNAVAILABLE } from "src/services/transactions/feeCopy";

const DEVNET_ENCRYPT_READS = [
  { minimum: "3000", recommended: "24987" },
  { minimum: "3000", recommended: "23061" },
  { minimum: "3000", recommended: "30047" },
  { minimum: "3000", recommended: "24089" },
];

describe("a reviewed fee against a live read", () => {
  it("stands through recommendations that move on every read", () => {
    const reviewed = Number(DEVNET_ENCRYPT_READS[0].recommended);
    for (const r of DEVNET_ENCRYPT_READS)
      expect(reviewedFeeError(reviewed, liveFeeOf(r.recommended, r.minimum))).toBeNull();
  });

  it("stands when the live fee is equal or lower", () => {
    expect(reviewedFeeError(24_987, { ou: 24_987, floorOu: 3_000 })).toBeNull();
    expect(reviewedFeeError(24_987, { ou: 8_530, floorOu: 3_000 })).toBeNull();
  });

  it("asks again only when the node's minimum is above it", () => {
    expect(reviewedFeeError(24_987, { ou: 60_000, floorOu: 24_987 })).toBeNull();
    expect(reviewedFeeError(24_987, { ou: 60_000, floorOu: 24_988 })).toBe(FEE_CHANGED);
  });

  it("refuses a failed read", () => {
    expect(reviewedFeeError(24_987, null)).toBe(FEE_UNAVAILABLE);
  });
});

describe("live fee from a node quote", () => {
  it("takes the minimum as the floor", () => {
    expect(liveFeeOf("24987", "3000")).toEqual({ ou: 24_987, floorOu: 3_000 });
  });

  it("uses the fee itself when no minimum is given, so only a higher fee lapses", () => {
    expect(liveFeeOf("1000000", undefined)).toEqual({ ou: 1_000_000, floorOu: 1_000_000 });
    expect(reviewedFeeError(1_000_000, liveFeeOf("1200000", null))).toBe(FEE_CHANGED);
    expect(reviewedFeeError(1_000_000, liveFeeOf("900000", null))).toBeNull();
  });

  it("never puts the floor above the fee the node recommends", () => {
    expect(liveFeeOf("5000", "9000")).toEqual({ ou: 5_000, floorOu: 5_000 });
  });

  it("reads nothing from a missing or non-positive fee", () => {
    expect(liveFeeOf(undefined, "3000")).toBeNull();
    expect(liveFeeOf("0", "3000")).toBeNull();
  });
});
