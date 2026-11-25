import { describe, it, expect } from "vitest";
import {
  FEE_FLOORS,
  MAX_FEE_RAW,
  feeAllowed,
  flooredFeeQuote,
  validFeeQuote,
} from "src/services/network/feePolicy";

const quote = { minimum: "1000", recommended: "1200", fast: "1500" };

describe("validFeeQuote", () => {
  it("accepts an ordered quote", () => {
    expect(validFeeQuote(quote)).toEqual(quote);
    expect(validFeeQuote({ minimum: 1000, recommended: 1000, fast: 1000 })).toEqual({
      minimum: "1000",
      recommended: "1000",
      fast: "1000",
    });
  });

  it("is valid without fast", () => {
    expect(validFeeQuote({ minimum: "1000", recommended: "1200" })).toEqual({
      minimum: "1000",
      recommended: "1200",
    });
  });

  it("drops only fast when it is below the recommended fee or invalid", () => {
    expect(validFeeQuote({ ...quote, fast: "1100" })).toEqual({
      minimum: "1000",
      recommended: "1200",
    });
    expect(validFeeQuote({ ...quote, fast: String(MAX_FEE_RAW + 1) })?.fast).toBeUndefined();
    expect(validFeeQuote({ ...quote, fast: "01500" })?.fast).toBeUndefined();
  });

  it("takes the first valid of recommended, base_fee and minimum", () => {
    expect(validFeeQuote({ recommended: "0", base_fee: "2000", minimum: "1000" })).toEqual({
      minimum: "1000",
      recommended: "2000",
    });
    expect(validFeeQuote({ minimum: "1000" })).toEqual({ minimum: "1000", recommended: "1000" });
    expect(validFeeQuote({ recommended: 3000 })).toEqual({ minimum: "3000", recommended: "3000" });
  });

  it("refuses a minimum above the recommended fee", () => {
    expect(validFeeQuote({ ...quote, recommended: "999" })).toBeNull();
  });

  it("is unavailable when recommended, base_fee and minimum are all missing or invalid", () => {
    expect(validFeeQuote({ fast: "1500" })).toBeNull();
    expect(validFeeQuote({ minimum: "0", recommended: "01000", base_fee: "1000.5" })).toBeNull();
    expect(validFeeQuote({ recommended: 1000.5 })).toBeNull();
    expect(validFeeQuote({ recommended: "-1000" })).toBeNull();
    expect(validFeeQuote({ recommended: "100000000" })).toBeNull();
    expect(validFeeQuote(null)).toBeNull();
    expect(validFeeQuote([1, 2, 3])).toBeNull();
  });

  it("takes the limit itself", () => {
    const max = String(MAX_FEE_RAW);
    expect(validFeeQuote({ minimum: max, recommended: max, fast: max })?.fast).toBe(max);
  });
});

describe("flooredFeeQuote", () => {
  it("raises private ops to their floor", () => {
    expect(FEE_FLOORS).toEqual({
      key_switch: 5000,
      encrypt: 5000,
      decrypt: 5000,
      stealth: 5000,
      claim: 3000,
    });
    expect(flooredFeeQuote("key_switch", quote)).toEqual({
      minimum: "5000",
      recommended: "5000",
      fast: "5000",
    });
    expect(
      flooredFeeQuote("claim", { minimum: "1000", recommended: "4000", fast: "6000" }),
    ).toEqual({ minimum: "3000", recommended: "4000", fast: "6000" });
    expect(flooredFeeQuote("encrypt", { minimum: "1000", recommended: "1200" })).toEqual({
      minimum: "5000",
      recommended: "5000",
    });
  });

  it("leaves other ops and higher quotes alone", () => {
    expect(flooredFeeQuote("standard", quote)).toEqual(quote);
    const high = { minimum: "1000000", recommended: "1016950", fast: "1100000" };
    expect(flooredFeeQuote("decrypt", high)).toEqual(high);
  });

  it("is null for an invalid quote", () => {
    expect(flooredFeeQuote("encrypt", { minimum: "2000", recommended: "1000" })).toBeNull();
  });
});

describe("feeAllowed", () => {
  it("holds a fee to the op floor and the limit", () => {
    expect(feeAllowed("key_switch", 4999)).toBe(false);
    expect(feeAllowed("key_switch", 5000)).toBe(true);
    expect(feeAllowed("claim", 3000)).toBe(true);
    expect(feeAllowed("claim", MAX_FEE_RAW + 1)).toBe(false);
    expect(feeAllowed("standard", 0)).toBe(false);
  });
});
