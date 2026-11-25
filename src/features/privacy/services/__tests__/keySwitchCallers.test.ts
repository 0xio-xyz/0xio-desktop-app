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

function calls(fn: string): Array<[string, string]> {
  const re = new RegExp(`(?<!function )\\b${fn}\\(([\\s\\S]*?)\\);`, "g");
  return files.flatMap((f) =>
    [...f.text.matchAll(re)].map((c): [string, string] => [
      f.path,
      c[1]
        .replace(/\s+/g, " ")
        .replace(/,\s*([}\])])/g, " $1")
        .replace(/\s+/g, " ")
        .trim(),
    ]),
  );
}

const text = (path: string) => files.find((f) => f.path === path)!.text;

describe("key_switch callers sign only a reviewed fee", () => {
  it("every keySwitchBalance call passes the reviewed ou", () => {
    expect(calls("keySwitchBalance")).toEqual([
      [
        "src/features/dapp/services/dappRequest.ts",
        'scope, w.id, { ou: fee, expect: { mode: "empty_key_switch", amountMicro: 0 } }',
      ],
      ["src/features/privacy/services/keyUpdate.ts", "scope, walletId, { ou, expect, onStep }"],
      ["src/features/privacy/services/privacyService.ts", "scope, walletId, { ou }"],
      ["src/features/privacy/services/privacyService.ts", "scope, walletId, review"],
    ]);
  });

  it("every submitKeyBoundMigration call passes the reviewed ou", () => {
    expect(calls("submitKeyBoundMigration")).toEqual([
      [
        "src/features/privacy/services/balanceRefresh.ts",
        "scope, walletId, migration, { ou, policy, owner }",
      ],
    ]);
  });

  it("every runKeyUpdate and runBalanceRefresh call carries ou", () => {
    const all = [...calls("runKeyUpdate"), ...calls("runBalanceRefresh")];
    expect(all.map(([p]) => p).sort()).toEqual([
      "src/features/privacy/services/balanceRefresh.ts",
      "src/features/privacy/services/keyUpdate.ts",
      "src/hooks/app/useTrayBridge.ts",
      "src/hooks/app/useTrayBridge.ts",
      "src/hooks/app/useTrayBridge.ts",
    ]);
    for (const [, args] of all) expect(args).toMatch(/\bou: (review\.feeRaw|String\(req\.\w+\))/);
  });

  it("migrateKeyBound and registerPvacKey callers pass a reviewed fee", () => {
    for (const [, args] of calls("migrateKeyBound")) expect(args).toMatch(/\bou\b/);
    for (const [, args] of calls("registerPvacKey")) expect(args).toMatch(/\{ ou: /);
  });

  it("no signer falls back to a live fee quote", () => {
    const svc = text("src/features/privacy/services/privacyService.ts");
    expect(svc).not.toMatch(/ou\s*\?\?\s*\(?\s*await getKeySwitchFeeQuote/);
    expect(svc).not.toMatch(/opts\?\.ou/);
    expect(text("src/features/privacy/services/balanceRefresh.ts")).not.toMatch(
      /ou \|\| undefined/,
    );
  });

  it("the main window key update and Migrate popup go through the review and auth step", () => {
    const overlay = text("src/features/privacy/components/KeySwitchOverlay.tsx");
    expect(overlay).toContain("keyUpdateReviewed(");
    expect(overlay).toContain("requestAuth(");
    expect(overlay).not.toContain("runKeyUpdate(");
    const migrate = text("src/hooks/privacy/useMigrateBalance.ts");
    expect(migrate).toContain("refreshReviewed(");
    expect(migrate).toContain("requestAuth(");
    expect(migrate).not.toContain("runBalanceRefresh(");
  });
});
