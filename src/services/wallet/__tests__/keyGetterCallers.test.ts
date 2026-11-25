import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "../../../..");
const SRC = join(ROOT, "src");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sources(p);
    return /\.(ts|tsx|js|jsx|json|css|html)$/.test(name) ? [p] : [];
  });
}

const files = sources(SRC).map((p) => ({
  path: relative(ROOT, p),
  text: readFileSync(p, "utf8"),
}));

function uses(pattern: RegExp): Record<string, number> {
  return Object.fromEntries(
    files
      .map((f) => [f.path, [...f.text.matchAll(pattern)].length] as const)
      .filter(([, count]) => count > 0)
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

const GETTER_COMMAND = ["wallet", "get", "private", "key"].join("_");
const GETTER_CALL = ["get", "Private", "Key"].join("");
const SEED_INIT = ["pvac", "init"].join("_");
const SEED_OF_KEY = ["private", "Key", "To", "Seed"].join("");

describe("private key getter", () => {
  it("reads every source file, tests included", () => {
    expect(files.length).toBeGreaterThan(300);
    expect(files.some((f) => f.path === "src/services/wallet/walletBridge.ts")).toBe(true);
    expect(files.some((f) => f.path.includes("__tests__"))).toBe(true);
  });

  it("is named nowhere under src", () => {
    expect(uses(new RegExp(GETTER_COMMAND, "g"))).toEqual({});
    expect(uses(new RegExp(`${GETTER_CALL}\\s*\\(`, "g"))).toEqual({});
  });

  it("the privacy engine starts from the wallet id and never from a seed", () => {
    expect(uses(new RegExp(`["'\`]${SEED_INIT}["'\`]`, "g"))).toEqual({});
    expect(uses(new RegExp(`\\b${SEED_OF_KEY}\\b`, "g"))).toEqual({});
    expect(uses(/["'`]pvac_init_wallet["'`]/g)).toEqual({
      "src/features/privacy/services/__tests__/scopeIsolation.test.ts": 2,
      "src/services/pvac/pvacBridge.ts": 1,
    });
  });

  it("the stealth scan reaches the key only through the Rust matcher", () => {
    expect(uses(/["'`]stealth_match_outputs["'`]/g)).toEqual({
      "src/features/privacy/services/__tests__/scopeIsolation.test.ts": 1,
      "src/features/privacy/services/__tests__/stealthScan.test.ts": 1,
      "src/services/wallet/walletBridge.ts": 1,
    });
    expect(uses(/\bderiveViewKeypair\b/g)).toEqual({});
  });
});
