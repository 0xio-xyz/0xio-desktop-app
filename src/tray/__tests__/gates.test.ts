import { describe, expect, it } from "vitest";
import {
  keyConfirmScope,
  keyFeeGate,
  privateOpGate,
  privateSendBlock,
  privateStatusLines,
  reviewedFeeLapse,
  sendGate,
} from "../gates";
import { parseSend } from "../commands";
import type { FeeRead, TraySnapshot } from "../protocol";
import {
  FEE_CHANGED,
  FEE_SHORT,
  FEE_UNAVAILABLE,
  INSUFFICIENT_BALANCE,
} from "src/services/transactions/feeCopy";

const ok = (ou: number): FeeRead => ({ state: "ok", ou });

const snap = (over: Partial<TraySnapshot> = {}): TraySnapshot => ({
  locked: false,
  hasPassword: true,
  biometric: false,
  wallets: [{ id: "w1", name: "Main", address: "octAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }],
  activeId: "w1",
  network: "devnet",
  networks: [{ id: "devnet", name: "Devnet" }],
  privacy: true,
  canSign: true,
  privateReadiness: { state: "ok" },
  publicMicro: 5_000_000,
  privateMicro: 3_000_000,
  claims: 0,
  fees: {
    public: ok(1_000),
    private: ok(1_000_000),
    encrypt: ok(1_000_000),
    decrypt: ok(1_000_000),
    refresh: ok(2_000_000),
  },
  ...over,
});

describe("send gate", () => {
  it("carries the live fee and leaves it out of the public amount", () => {
    const g = sendGate(snap(), "public", 1_000_000);
    expect(g.feeOu).toBe(1_000);
    expect(g.available).toBe(4_999_000);
    expect(g.ok).toBe(true);
  });

  it("never offers a fee while it loads", () => {
    const g = sendGate(
      snap({ fees: { ...snap().fees, public: { state: "loading" } } }),
      "public",
      1,
    );
    expect(g.feeOu).toBeNull();
    expect(g.ok).toBe(false);
    expect(g.feeError).toBe("");
    expect(g.retry).toBe(false);
  });

  it("blocks with a retry when the fee read failed", () => {
    const g = sendGate(
      snap({ fees: { ...snap().fees, private: { state: "error" } } }),
      "private",
      1,
    );
    expect(g.ok).toBe(false);
    expect(g.feeError).toBe(FEE_UNAVAILABLE);
    expect(g.retry).toBe(true);
  });

  it("blocks a private send when public OCT does not cover its fee", () => {
    const g = sendGate(snap({ publicMicro: 999_999 }), "private", 1_000_000);
    expect(g.ok).toBe(false);
    expect(g.feeError).toBe(FEE_SHORT);
    expect(g.available).toBe(3_000_000);
  });

  it("allows a private send once public OCT covers its fee", () => {
    expect(sendGate(snap({ publicMicro: 1_000_000 }), "private", 3_000_000).ok).toBe(true);
  });

  it("names a send above the balance", () => {
    expect(sendGate(snap(), "private", 3_000_001).amountError).toBe(INSUFFICIENT_BALANCE);
  });

  it("is not ready while the balance has not loaded", () => {
    expect(sendGate(snap({ publicMicro: null }), "private", 1).ok).toBe(false);
  });
});

describe("command line send", () => {
  it("names the fee shortfall for a private send", () => {
    const s = parseSend(
      ["1", "to", "octBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", "private"],
      snap({ publicMicro: 10 }),
    );
    expect(s.issues).toContain(FEE_SHORT);
  });
});

describe("private op gate", () => {
  it("adds the refresh fee when the review runs it first", () => {
    const g = privateOpGate(snap({ privateReadiness: { state: "needsRefresh" } }), "encrypt", 1);
    expect(g.feeOu).toBe(3_000_000);
    expect(g.opFeeOu).toBe(1_000_000);
    expect(g.refreshFeeOu).toBe(2_000_000);
    expect(g.available).toBe(2_000_000);
  });

  it("is unavailable when either fee failed", () => {
    const s = snap({
      privateReadiness: { state: "needsRefresh" },
      fees: { ...snap().fees, refresh: { state: "error" } },
    });
    const g = privateOpGate(s, "decrypt", 1);
    expect(g.ok).toBe(false);
    expect(g.fee).toEqual({ state: "error" });
    expect(g.feeError).toBe(FEE_UNAVAILABLE);
  });

  it("blocks a decrypt whose fee public OCT does not cover", () => {
    const g = privateOpGate(snap({ publicMicro: 10 }), "decrypt", 1);
    expect(g.ok).toBe(false);
    expect(g.feeError).toBe(FEE_SHORT);
  });
});

describe("key fee gate", () => {
  it("is ready only with a live fee the public balance covers", () => {
    expect(keyFeeGate(ok(2_000_000), 2_000_000).ok).toBe(true);
    expect(keyFeeGate(ok(2_000_000), 1_999_999).feeError).toBe(FEE_SHORT);
    expect(keyFeeGate({ state: "loading" }, 9e9).ok).toBe(false);
    const failed = keyFeeGate({ state: "error" }, 9e9);
    expect(failed.ok).toBe(false);
    expect(failed.retry).toBe(true);
    expect(failed.feeError).toBe(FEE_UNAVAILABLE);
  });
});

describe("key update confirm", () => {
  const update = snap({
    privateReadiness: {
      state: "keyUpdate",
      mode: "key_bound_migration",
      amountMicro: 4,
      fee: ok(1_000_000),
    },
  });

  it("lapses on a wallet or network change", () => {
    const given = keyConfirmScope(update);
    expect(given).not.toBeNull();
    expect(keyConfirmScope({ ...update, activeId: "w2" })).not.toBe(given);
    expect(keyConfirmScope({ ...update, network: "mainnet" })).not.toBe(given);
  });

  it("holds while only the fee read moves", () => {
    const given = keyConfirmScope(update);
    const r = update.privateReadiness;
    if (r.state !== "keyUpdate") throw new Error("setup");
    expect(keyConfirmScope({ ...update, privateReadiness: { ...r, fee: ok(2) } })).toBe(given);
  });

  it("lapses when what the update moves changes", () => {
    const r = update.privateReadiness;
    if (r.state !== "keyUpdate") throw new Error("setup");
    expect(keyConfirmScope({ ...update, privateReadiness: { ...r, amountMicro: 5 } })).not.toBe(
      keyConfirmScope(update),
    );
  });
});

describe("private status lines", () => {
  it("has a line for a failed setup read", () => {
    expect(
      privateStatusLines({ state: "noKey", setup: { state: "unavailable", reason: "fee" } }),
    ).toEqual([FEE_UNAVAILABLE]);
  });

  it("has none once the balance is ready", () => {
    expect(privateStatusLines({ state: "ok" })).toEqual([]);
  });
});

describe("private send block", () => {
  const loading: FeeRead = { state: "loading" };
  it("lets a ready balance through", () => {
    expect(privateSendBlock({ state: "ok" })).toBeNull();
  });

  it.each([
    [{ state: "needsRefresh" }, "Your private balance is due for a migration", "migrate"],
    [
      { state: "keyUpdate", mode: "key_bound_migration", amountMicro: 1, fee: loading },
      "Your private balance needs to move to your current encryption key",
      "keyUpdate",
    ],
    [
      { state: "noKey", setup: { state: "offer", feeOu: 1_000 } },
      "Your private balance is off",
      "turnOn",
    ],
    [{ state: "noKey", setup: { state: "unavailable", reason: "fee" } }, FEE_UNAVAILABLE, "retry"],
    [{ state: "waiting", reason: "refreshPending" }, "Migrating, waiting for the network", null],
    [
      { state: "blocked", reason: "keyBlocked", detail: "Held by the network" },
      "Held by the network",
      null,
    ],
    [
      { state: "stuck", reason: "pastCap", detail: "Past the layer limit" },
      "Past the layer limit",
      null,
    ],
    [{ state: "checking" }, "", null],
    [{ state: "noKey", setup: { state: "checking" } }, "", null],
  ] as [TraySnapshot["privateReadiness"], string, string | null][])(
    "refuses %j with the private view's line and fix",
    (readiness, line, fix) => {
      expect(privateSendBlock(readiness)).toEqual({ line, fix });
    },
  );
});

describe("reviewed fee lapse", () => {
  const read = (ou: number, floor?: number): FeeRead => ({ state: "ok", ou, floor });

  it("holds while each part is at or above the node's floor", () => {
    expect(reviewedFeeLapse([[24_987, read(30_047, 3_000)]])).toBeNull();
    expect(reviewedFeeLapse([[24_987, read(8_530, 3_000)]])).toBeNull();
    expect(
      reviewedFeeLapse([
        [24_987, read(49_107, 3_000)],
        [42_099, read(18_110, 3_000)],
      ]),
    ).toBeNull();
  });

  it("lapses when any part's floor is above what the review showed", () => {
    expect(
      reviewedFeeLapse([
        [24_987, read(24_987, 3_000)],
        [42_099, read(60_000, 50_000)],
      ]),
    ).toBe(FEE_CHANGED);
  });

  it("takes a read with no floor as its own floor", () => {
    expect(reviewedFeeLapse([[1_000, read(1_000)]])).toBeNull();
    expect(reviewedFeeLapse([[1_000, read(800)]])).toBeNull();
    expect(reviewedFeeLapse([[1_000, read(2_000)]])).toBe(FEE_CHANGED);
  });

  it("leaves a loading or failed read to the main window's own check", () => {
    expect(reviewedFeeLapse([[1_000, { state: "loading" }]])).toBeNull();
    expect(reviewedFeeLapse([[1_000, { state: "error" }]])).toBeNull();
  });
});
