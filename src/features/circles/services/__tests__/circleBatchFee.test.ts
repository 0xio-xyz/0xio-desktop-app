import { describe, expect, it } from "vitest";
import {
  batchFeeTotal,
  splitBatchFee,
  sumBatchFees,
} from "src/features/circles/services/circleBatchFee";

const fees = [
  { minimum: "100", recommended: "150", fast: "300" },
  { minimum: "1000", recommended: "1500", fast: "3000" },
  { minimum: "7", recommended: "9" },
];

describe("the fee of a batch", () => {
  it("adds the live fees up, with Fast only when every file has one", () => {
    expect(sumBatchFees(fees)).toEqual({ minimum: "1107", recommended: "1659" });
    expect(sumBatchFees(fees.slice(0, 2))).toEqual({
      minimum: "1100",
      recommended: "1650",
      fast: "3300",
    });
  });

  it("a preset signs each file's own live fee", () => {
    expect(splitBatchFee({ mode: "slow" }, fees)).toEqual(["100", "1000", "7"]);
    expect(splitBatchFee({ mode: "normal" }, fees)).toEqual(["150", "1500", "9"]);
    expect(splitBatchFee({ mode: "fast" }, fees)).toEqual(["300", "3000", "9"]);
  });

  it("a custom total splits exactly and never under a file's minimum", () => {
    const parts = splitBatchFee({ mode: "custom", ou: "2000" }, fees);
    expect(batchFeeTotal(parts)).toBe("2000");
    parts.forEach((p, i) => expect(Number(p)).toBeGreaterThanOrEqual(Number(fees[i].minimum)));
  });

  it("a custom total under the minimums falls back to the live fee", () => {
    expect(splitBatchFee({ mode: "custom", ou: "50" }, fees)).toEqual(["150", "1500", "9"]);
  });
});
