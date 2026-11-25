import { describe, expect, it } from "vitest";
import {
  ancestorsOf,
  deepestLayer,
  parentsLabel,
} from "src/features/privacy/components/CipherGraph";
import type { CipherLayer } from "src/services/pvac/pvacBridge";

const layer = (idx: number, is_base: boolean, depth: number, pa = 0, pb = 0): CipherLayer => ({
  idx,
  is_base,
  depth,
  pa,
  pb,
  pc_count: 0,
  r_pc_count: 0,
  has_r_com: false,
  edges: 0,
  sigma_ones: 0,
  sigma_bits: 0,
});

const DEEP = [
  layer(0, true, 0),
  layer(1, true, 0),
  layer(2, true, 0),
  layer(3, false, 1, 0, 1),
  layer(4, false, 2, 3, 2),
  layer(5, false, 3, 4, 0),
];

const t = (key: string, o?: Record<string, unknown>) =>
  key === "cipherMap.parentsOf" ? `${o?.a} and ${o?.b}` : key;

describe("cipher map helpers", () => {
  it("names a product layer's parents and a base layer's none", () => {
    expect(parentsLabel(DEEP[4], t)).toBe("L3 and L2");
    expect(parentsLabel(DEEP[0], t)).toBe("cipherMap.none");
  });

  it("walks the whole lineage of a deep layer", () => {
    expect([...ancestorsOf(DEEP, 5)].sort()).toEqual([0, 1, 2, 3, 4]);
    expect([...ancestorsOf(DEEP, 3)].sort()).toEqual([0, 1]);
    expect(ancestorsOf(DEEP, 1).size).toBe(0);
  });

  it("picks the deepest layer, the last one at that depth", () => {
    expect(deepestLayer(DEEP)).toBe(5);
    expect(deepestLayer([layer(0, true, 0), layer(1, true, 0)])).toBe(1);
    expect(deepestLayer([])).toBe(0);
  });
});
