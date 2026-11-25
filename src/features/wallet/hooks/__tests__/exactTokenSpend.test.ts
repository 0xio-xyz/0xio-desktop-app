import { describe, it, expect } from "vitest";
import { exactTokenSpend } from "src/features/wallet/hooks/useSendForm";

const ok = { max: 1, error: null, ok: true };

describe("exactTokenSpend", () => {
  it("passes an amount the raw balance holds", () => {
    expect(exactTokenSpend(ok, "9007199254740993", "9007199254740993")).toBe(ok);
  });

  it("refuses one raw unit more than the balance", () => {
    expect(exactTokenSpend(ok, "9007199254740994", "9007199254740993")).toEqual({
      max: 1,
      error: "Insufficient balance",
      ok: false,
    });
  });

  it("is not ready when the amount rounds to nothing", () => {
    expect(exactTokenSpend(ok, "0", "100").ok).toBe(false);
  });

  it("keeps an earlier refusal", () => {
    const short = { max: 0, error: "Insufficient public OCT for network fee", ok: false };
    expect(exactTokenSpend(short, "1", "100")).toBe(short);
  });
});
