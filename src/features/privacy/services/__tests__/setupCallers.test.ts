import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "../../../../..");
const SRC = join(ROOT, "src");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === "__tests__" ? [] : sources(p);
    return /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

const files = sources(SRC).map((p) => ({
  path: relative(ROOT, p),
  text: readFileSync(p, "utf8"),
}));

describe("private balance registration callers", () => {
  it("only the setup review and the menu bar's reviewed turn on register", () => {
    const callers = files
      .filter((f) => /registerPvacKey\(/.test(f.text))
      .map((f) => f.path)
      .sort();
    expect(callers).toEqual([
      "src/features/privacy/services/privacyService.ts",
      "src/features/privacy/services/setupReview.ts",
      "src/hooks/app/useTrayBridge.ts",
    ]);
  });

  it("nothing outside registerPvacKey asks ensurePvacRegistered to register", () => {
    const calls = files.flatMap((f) =>
      [...f.text.matchAll(/(?<!function )ensurePvacRegistered\(([^)]*)\)/g)].map((c) => c[1]),
    );
    const registering = calls.filter((args) => args.split(",").length > 2);
    expect(registering).toEqual(["scope, walletId, true, opts.ou"]);
  });

  it("the Send and Privacy gates open the setup review", () => {
    for (const path of [
      "src/features/wallet/screens/SendScreen.tsx",
      "src/features/privacy/screens/PrivacyScreen.tsx",
    ]) {
      const text = files.find((f) => f.path === path)!.text;
      expect(text).toContain("<TurnOnReview");
      expect(text).not.toMatch(/\.register\b/);
    }
    const card = files.find((f) => f.path === "src/features/privacy/hooks/useTurnOn.ts")!.text;
    expect(card).toContain("turnOnReviewed(");
    expect(card).toContain("requestAuth(");
  });
});
