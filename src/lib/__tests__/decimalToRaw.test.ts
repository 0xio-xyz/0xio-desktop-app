import { describe, it, expect } from "vitest";
import { decimalToRaw, isPositiveDecimal } from "src/lib/format";

describe("decimalToRaw", () => {
  it("scales a decimal amount without floating point", () => {
    expect(decimalToRaw("1.5", 6)).toBe("1500000");
    expect(decimalToRaw("0.000001", 6)).toBe("1");
    expect(decimalToRaw("1000000000000000", 18)).toBe("1000000000000000000000000000000000");
    expect(decimalToRaw("9007199254740993", 0)).toBe("9007199254740993");
    expect(decimalToRaw("0.1", 18)).toBe("100000000000000000");
    expect(decimalToRaw(".5", 2)).toBe("50");
    expect(decimalToRaw("5.", 2)).toBe("500");
  });

  it("drops digits past the token's decimals", () => {
    expect(decimalToRaw("1.23456789", 6)).toBe("1234567");
    expect(decimalToRaw("0.0000001", 6)).toBe("0");
  });

  it("strips leading zeros", () => {
    expect(decimalToRaw("0007", 0)).toBe("7");
    expect(decimalToRaw("0.0", 6)).toBe("0");
  });

  it("is zero for text that is not a plain amount", () => {
    for (const bad of ["", ".", "1e21", "-1", "1,000", "abc", "1.2.3", "Infinity"])
      expect(decimalToRaw(bad, 6)).toBe("0");
  });
});

describe("isPositiveDecimal", () => {
  it("takes a plain amount above zero", () => {
    for (const ok of ["1", "0.000001", " 12.5 ", ".5", "123456789012345678901234567890"])
      expect(isPositiveDecimal(ok)).toBe(true);
  });

  it("refuses zero and anything that is not a plain amount", () => {
    for (const bad of ["", "0", "0.000", ".", "1e21", "-1", "1,000", "abc", "Infinity", "0x10"])
      expect(isPositiveDecimal(bad)).toBe(false);
  });
});
