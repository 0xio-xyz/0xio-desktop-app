import { describe, it, expect } from "vitest";
import { ouPresets } from "src/features/wallet/components/OUSettings";
import { validFeeQuote } from "src/services/network/feePolicy";

const t = (key: string) => key;
const ids = (fees: Parameters<typeof ouPresets>[0]) => ouPresets(fees, "1000", t).map((p) => p.id);

describe("ouPresets", () => {
  it("offers Slow, Normal and Fast from a full quote", () => {
    expect(ids({ minimum: "1000", recommended: "1200", fast: "1500" })).toEqual([
      "slow",
      "normal",
      "fast",
    ]);
  });

  it("hides only Fast when the quote has none", () => {
    expect(ids(validFeeQuote({ minimum: "1000", recommended: "1200" }) ?? undefined)).toEqual([
      "slow",
      "normal",
    ]);
  });

  it("hides only Fast when fast is below the recommended fee", () => {
    const fees = validFeeQuote({ minimum: "1000", recommended: "1200", fast: "1100" });
    expect(ids(fees ?? undefined)).toEqual(["slow", "normal"]);
  });

  it("never invents a Fast preset without a quote", () => {
    expect(ouPresets(undefined, "1000", t)).toEqual([
      { id: "normal", label: "fee.normal", ou: "1000" },
    ]);
  });
});
