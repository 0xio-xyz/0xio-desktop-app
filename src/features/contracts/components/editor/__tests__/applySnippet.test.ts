import { describe, expect, it } from "vitest";
import { isWholeFile, mergeSnippet } from "src/features/contracts/components/editor/applySnippet";

const vault = [
  "Program Vault {",
  "  fn withdraw(amount: u128) {",
  '    require(self.balances[caller] >= amount, "insufficient")',
  "    self.total = self.total - amount",
  "  }",
  "}",
].join("\n");

describe("mergeSnippet", () => {
  it("adds a new check where the snippet's first line already is", () => {
    const fix = [
      "  fn withdraw(amount: u128) {",
      '    require(amount > 0, "zero amount")',
      '    require(self.balances[caller] >= amount, "insufficient")',
    ].join("\n");
    expect(mergeSnippet(vault, fix, 1).split("\n")).toEqual([
      "Program Vault {",
      "  fn withdraw(amount: u128) {",
      '    require(amount > 0, "zero amount")',
      '    require(self.balances[caller] >= amount, "insufficient")',
      "    self.total = self.total - amount",
      "  }",
      "}",
    ]);
  });

  it("replaces a changed line between two matching ones", () => {
    const fix = [
      "  fn withdraw(amount: u128) {",
      '    require(self.balances[caller] >= amount, "low balance")',
      "    self.total = self.total - amount",
    ].join("\n");
    expect(mergeSnippet(vault, fix, 1)).toContain('"low balance"');
    expect(mergeSnippet(vault, fix, 1)).not.toContain('"insufficient"');
    expect(mergeSnippet(vault, fix, 1).split("\n")).toHaveLength(6);
  });

  it("puts a snippet with no anchor on its own lines at the cursor", () => {
    const out = mergeSnippet(vault, "  view fn total(): u128 {\n    return self.total\n  }", 6);
    expect(out.split("\n")[5]).toBe("  view fn total(): u128 {");
    expect(out.endsWith("\n}")).toBe(true);
  });

  it("tells a whole program from a fragment", () => {
    expect(isWholeFile("Program X {\n}", vault)).toBe(true);
    expect(isWholeFile("    require(x)", vault)).toBe(false);
  });
});
