import { describe, expect, it } from "vitest";
import { spendCheck } from "src/services/transactions/spendLimit";
import { FEE_SHORT, INSUFFICIENT_BALANCE } from "src/services/transactions/feeCopy";

const OCT = 1_000_000;

describe("spendCheck", () => {
  it.each(["public", "encrypt"] as const)("%s Max is the balance minus the live fee", (kind) => {
    const c = spendCheck({
      kind,
      balance: 10 * OCT,
      publicMicro: 10 * OCT,
      feeOu: 1_000,
      amount: 0,
    });
    expect(c.max).toBe(10 * OCT - 1_000);
    expect(spendCheck({ kind, balance: 500, publicMicro: 500, feeOu: 1_000, amount: 0 }).max).toBe(
      0,
    );
  });

  it.each(["public", "encrypt"] as const)("%s refuses an amount that leaves no fee", (kind) => {
    const all = spendCheck({
      kind,
      balance: 10 * OCT,
      publicMicro: 10 * OCT,
      feeOu: 1_000,
      amount: 10 * OCT,
    });
    expect(all).toMatchObject({ error: INSUFFICIENT_BALANCE, ok: false });
    const max = spendCheck({
      kind,
      balance: 10 * OCT,
      publicMicro: 10 * OCT,
      feeOu: 1_000,
      amount: 10 * OCT - 1_000,
    });
    expect(max).toMatchObject({ error: null, ok: true });
  });

  it.each(["token", "decrypt", "private"] as const)(
    "%s Max is the whole balance and public OCT must cover the fee",
    (kind) => {
      const covered = spendCheck({
        kind,
        balance: 7 * OCT,
        publicMicro: OCT,
        feeOu: 1_000_000,
        amount: 7 * OCT,
      });
      expect(covered).toMatchObject({ max: 7 * OCT, error: null, ok: true });
      const short = spendCheck({
        kind,
        balance: 7 * OCT,
        publicMicro: 999_999,
        feeOu: 1_000_000,
        amount: OCT,
      });
      expect(short).toMatchObject({ error: FEE_SHORT, ok: false });
      const over = spendCheck({
        kind,
        balance: 7 * OCT,
        publicMicro: OCT,
        feeOu: 1_000,
        amount: 8 * OCT,
      });
      expect(over).toMatchObject({ error: INSUFFICIENT_BALANCE, ok: false });
    },
  );

  it("has no Max and no go while the fee or a balance is unknown", () => {
    expect(
      spendCheck({ kind: "public", balance: OCT, publicMicro: OCT, feeOu: null, amount: 1 }),
    ).toEqual({
      max: null,
      error: null,
      ok: false,
    });
    expect(
      spendCheck({ kind: "decrypt", balance: null, publicMicro: OCT, feeOu: 1_000, amount: 1 }).ok,
    ).toBe(false);
    expect(
      spendCheck({ kind: "token", balance: 5, publicMicro: null, feeOu: 1_000, amount: 1 }).ok,
    ).toBe(false);
  });

  it("a batch must fit its total plus one fee per send", () => {
    const pub = { kind: "public" as const, balance: 10 * OCT, publicMicro: 10 * OCT, feeOu: 1_000 };
    expect(spendCheck({ ...pub, amount: 10 * OCT - 3_000, count: 3 }).ok).toBe(true);
    expect(spendCheck({ ...pub, amount: 10 * OCT - 2_999, count: 3 }).error).toBe(
      INSUFFICIENT_BALANCE,
    );
    const priv = { kind: "private" as const, balance: 10 * OCT, publicMicro: 2_999, feeOu: 1_000 };
    expect(spendCheck({ ...priv, amount: OCT, count: 3 }).error).toBe(FEE_SHORT);
  });
});
