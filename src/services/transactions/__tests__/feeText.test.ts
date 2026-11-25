import { afterEach, describe, expect, it } from "vitest";
import i18n, { switchLanguage } from "src/i18n";
import en from "src/i18n/locales/en.json";
import id from "src/i18n/locales/id.json";
import ja from "src/i18n/locales/ja.json";
import ko from "src/i18n/locales/ko.json";
import zh from "src/i18n/locales/zh.json";
import { feeText } from "src/services/transactions/feeText";
import {
  FEE_CHANGED,
  FEE_SHORT,
  FEE_UNAVAILABLE,
  INSUFFICIENT_BALANCE,
  SCOPE_CHANGED,
} from "src/services/transactions/feeCopy";

const KEYS = [
  "fee.changed",
  "fee.short",
  "fee.insufficientBalance",
  "fee.unavailableRetry",
  "fee.scopeChanged",
];

afterEach(() => i18n.changeLanguage("en"));

describe("feeText", () => {
  it("every locale has the fee refusals", () => {
    for (const locale of [en, id, ja, ko, zh] as Record<string, string>[])
      for (const key of KEYS) expect(locale[key], key).toBeTruthy();
  });

  it("shows the English codes as they read in English", async () => {
    await i18n.changeLanguage("en");
    for (const code of [
      FEE_CHANGED,
      FEE_SHORT,
      FEE_UNAVAILABLE,
      INSUFFICIENT_BALANCE,
      SCOPE_CHANGED,
    ])
      expect(feeText(code)).toBe(code);
  });

  it("translates a refusal and keeps what follows it", async () => {
    await switchLanguage("ja");
    expect(feeText(FEE_SHORT)).toBe(ja["fee.short"]);
    expect(feeText(`${INSUFFICIENT_BALANCE} (2 OCT available)`)).toBe(
      `${ja["fee.insufficientBalance"]} (2 OCT available)`,
    );
    expect(feeText("Something else")).toBe("Something else");
    expect(feeText("")).toBe("");
  });
});
