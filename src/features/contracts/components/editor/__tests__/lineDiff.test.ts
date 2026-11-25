import { describe, expect, it } from "vitest";
import { diffLines, lineOps } from "src/features/contracts/components/editor/lineDiff";

const lines = (...l: string[]) => l.join("\n");

describe("diffLines", () => {
  it("marks nothing when the text is unchanged", () => {
    const d = diffLines("a\nb\nc", "a\nb\nc");
    expect(d.marks).toEqual(["", "", ""]);
    expect(d.adds + d.dels).toBe(0);
    expect(d.deletedAbove).toEqual([]);
  });

  it("marks an added line", () => {
    const d = diffLines(lines("a", "b"), lines("a", "x", "b"));
    expect(d.marks).toEqual(["", "add", ""]);
    expect([d.adds, d.dels]).toEqual([1, 0]);
  });

  it("marks a changed line as modified", () => {
    const d = diffLines(lines("a", "b", "c"), lines("a", "B", "c"));
    expect(d.marks).toEqual(["", "mod", ""]);
    expect([d.adds, d.dels]).toEqual([1, 1]);
  });

  it("points a deletion at the line below it", () => {
    const d = diffLines(lines("a", "b", "c"), lines("a", "c"));
    expect(d.marks).toEqual(["", ""]);
    expect(d.deletedAbove).toEqual([2]);
    expect(d.deletedAtEnd).toBe(false);
  });

  it("flags a deletion at the end of the file", () => {
    const d = diffLines(lines("a", "b", "c"), lines("a", "b"));
    expect(d.deletedAtEnd).toBe(true);
  });

  it("splits one changed line into one more added line", () => {
    const d = diffLines(lines("a", "x", "c"), lines("a", "y", "z", "c"));
    expect(d.marks).toEqual(["", "mod", "add", ""]);
    const changed = d.split.filter((r) => r.left.kind || r.right.kind);
    expect(changed.map((r) => [r.left.kind, r.right.kind])).toEqual([
      ["del", "add"],
      ["pad", "add"],
    ]);
  });

  it("lists inline rows with both line numbers", () => {
    const d = diffLines(lines("a", "b"), lines("a", "c"));
    expect(d.inline).toEqual([
      { a: 1, b: 1, sign: " ", text: "a" },
      { a: 2, b: null, sign: "-", text: "b" },
      { a: null, b: 2, sign: "+", text: "c" },
    ]);
  });

  it("handles an empty saved text", () => {
    const d = diffLines("", lines("a", "b"));
    expect(d.marks).toEqual(["mod", "add"]);
  });

  it("stays fast and exact on a long file with one edit", () => {
    const base = Array.from({ length: 5000 }, (_, i) => `line ${i}`);
    const edited = [...base];
    edited[2500] = "changed";
    const ops = lineOps(base, edited);
    expect(ops.filter((o) => o.t !== "eq")).toEqual([
      { t: "del", a: 2500 },
      { t: "add", b: 2500 },
    ]);
  });
});
