import { describe, it, expect, vi } from "vitest";
import {
  KEY_BLOCKED_LINE,
  KEY_FINE_LINE,
  KEY_CHECK_FAILED_LINE,
  PAST_CAP_LINE,
  privateReadiness,
  runPrivateOp,
  runPrivateRefresh,
  runPrivateSend,
  trayMigrateRequestError,
  trayRequestError,
  type FreshReadiness,
  type FreshSendReadiness,
  type ReadinessSignals,
} from "src/features/privacy/services/trayPrivate";
import type { PvacSetupData } from "src/hooks/privacy/usePvacSetup";
import type { RefreshOutcome } from "src/features/privacy/services/balanceRefresh";
import { keyUpdateSteps, privateSteps } from "src/tray/protocol";
import {
  keyModeSignal,
  keyUpdateMismatch,
  keyUpdateMovesBalance,
  type KeyModeSignal,
  type KeyUpdateMode,
} from "src/features/privacy/services/keyUpdatePolicy";
import type { KeySwitchMode } from "src/features/privacy/services/privacyService";

const setup = (over: Partial<PvacSetupData> = {}): PvacSetupData => ({
  regState: "registered",
  needsCompact: false,
  baseLayers: 2,
  nonCanonical: false,
  held: false,
  holdKeyFine: false,
  canMigrate: false,
  notSpendable: false,
  canRefresh: true,
  ...over,
});

const signals = (over: Partial<ReadinessSignals> = {}): ReadinessSignals => ({
  setup: setup(),
  foreign: false,
  legacy: false,
  refreshPending: false,
  ...over,
});

describe("tray private readiness", () => {
  it("is ok for a registered balance under the refresh threshold", () => {
    expect(privateReadiness(signals())).toEqual({ state: "ok" });
  });

  it("is checking until the setup query has run", () => {
    expect(privateReadiness(signals({ setup: undefined }))).toEqual({ state: "checking" });
  });

  it("needs a refresh at the threshold when the node accepts it", () => {
    expect(
      privateReadiness(signals({ setup: setup({ needsCompact: true, baseLayers: 4 }) })),
    ).toEqual({ state: "needsRefresh" });
  });

  it("is blocked when a refresh is due but the node does not accept it", () => {
    expect(
      privateReadiness(
        signals({ setup: setup({ needsCompact: true, baseLayers: 4, canRefresh: false }) }),
      ),
    ).toEqual({ state: "blocked", reason: "keyBlocked", detail: KEY_BLOCKED_LINE });
  });

  it("is stuck past the compactable cap", () => {
    expect(
      privateReadiness(signals({ setup: setup({ needsCompact: true, baseLayers: 8 }) })),
    ).toEqual({ state: "stuck", reason: "pastCap", detail: PAST_CAP_LINE });
  });

  it("allows a refresh at exactly the cap", () => {
    expect(
      privateReadiness(signals({ setup: setup({ needsCompact: true, baseLayers: 6 }) })),
    ).toEqual({ state: "needsRefresh" });
  });

  it("shows why an unprovable balance can't be spent", () => {
    expect(
      privateReadiness(signals({ setup: setup({ notSpendable: true, spendReason: "bad r_com" }) })),
    ).toEqual({
      state: "stuck",
      reason: "unprovable",
      detail: "This private balance can't be proven right now: bad r_com.",
    });
  });

  it.each([
    [{ setup: setup({ regState: "pending" }) }, "setupPending"],
    [{ setup: setup({ regState: "unregistered" }), staged: true }, "setupPending"],
    [
      { refreshPending: true, setup: setup({ needsCompact: true, baseLayers: 4 }) },
      "refreshPending",
    ],
  ] as const)("waits on the network for %o", (over, reason) => {
    expect(privateReadiness(signals(over))).toEqual({ state: "waiting", reason });
  });

  it("shows the node's reason for a held balance", () => {
    expect(
      privateReadiness(
        signals({
          setup: setup({ held: true, needsCompact: true, baseLayers: 4 }),
          blockedAck: "history index incomplete",
        }),
      ),
    ).toEqual({ state: "blocked", reason: "keyBlocked", detail: "history index incomplete" });
  });

  it("says the key is fine for a held balance with a current key", () => {
    expect(
      privateReadiness(
        signals({
          setup: setup({ held: true, holdKeyFine: true, needsCompact: true, baseLayers: 4 }),
          blockedAck: "key_bound_unavailable",
        }),
      ),
    ).toEqual({ state: "blocked", reason: "keyBlocked", detail: KEY_FINE_LINE });
  });

  it("offers the Migrate balance popup for a held balance with the migration open", () => {
    expect(
      privateReadiness(
        signals({
          setup: setup({ held: true, canMigrate: true, needsCompact: true, baseLayers: 4 }),
        }),
      ),
    ).toEqual({ state: "needsRefresh" });
  });

  it("still calls a held balance past the cap stuck", () => {
    expect(
      privateReadiness(
        signals({
          setup: setup({ held: true, canMigrate: true, needsCompact: true, baseLayers: 8 }),
        }),
      ),
    ).toEqual({ state: "stuck", reason: "pastCap", detail: PAST_CAP_LINE });
  });
});

describe("tray key update (the key dialog's modes)", () => {
  const update = (mode: KeyUpdateMode, amountMicro = 0): KeyModeSignal => ({
    kind: "update",
    mode,
    amountMicro,
  });

  it.each([
    ["empty_key_switch", 0],
    ["legacy_zero_reset", 0],
    ["legacy_public_migration", 7_000_000],
    ["key_bound_migration", 3_000_000],
  ] as const)("offers %s on a key mismatch at the live fee", (mode, amount) => {
    expect(
      privateReadiness(
        signals({
          setup: undefined,
          foreign: true,
          keyMode: update(mode, amount),
          keyFee: { state: "ok", ou: 1_000_000 },
        }),
      ),
    ).toEqual({
      state: "keyUpdate",
      mode,
      amountMicro: amount,
      fee: { state: "ok", ou: 1_000_000 },
    });
  });

  it("offers the update for a legacy balance when the node takes one", () => {
    expect(
      privateReadiness(signals({ legacy: true, keyMode: update("legacy_public_migration", 5) })),
    ).toEqual({
      state: "keyUpdate",
      mode: "legacy_public_migration",
      amountMicro: 5,
      fee: { state: "loading" },
    });
  });

  it("keeps checking until the key dialog's mode is read", () => {
    expect(privateReadiness(signals({ foreign: true }))).toEqual({ state: "checking" });
  });

  it("waits instead of offering again while an update is staged", () => {
    expect(
      privateReadiness(
        signals({ foreign: true, refreshPending: true, keyMode: update("empty_key_switch") }),
      ),
    ).toEqual({ state: "waiting", reason: "refreshPending" });
  });

  it("shows the node's reason when it refuses the key update", () => {
    expect(
      privateReadiness(
        signals({ foreign: true, keyMode: { kind: "blocked", reason: "history incomplete" } }),
      ),
    ).toEqual({ state: "blocked", reason: "keyMismatch", detail: "history incomplete" });
  });

  it.each([
    [true, KEY_FINE_LINE],
    [false, KEY_BLOCKED_LINE],
  ] as const)("says whether the key is fine when the migration is unavailable", (cur, line) => {
    expect(
      privateReadiness(
        signals({ foreign: true, keyMode: { kind: "unavailable", keyCurrent: cur } }),
      ),
    ).toEqual({ state: "blocked", reason: "keyMismatch", detail: line });
  });

  it("names a legacy balance the node takes no update for", () => {
    expect(
      privateReadiness(
        signals({ legacy: true, keyMode: { kind: "unavailable", keyCurrent: false } }),
      ),
    ).toEqual({ state: "blocked", reason: "keyBlocked", detail: KEY_BLOCKED_LINE });
    expect(
      privateReadiness(signals({ legacy: true, keyMode: { kind: "blocked", reason: "" } })),
    ).toEqual({ state: "blocked", reason: "keyBlocked", detail: "" });
  });

  it("says the check failed when the mode could not be read", () => {
    expect(privateReadiness(signals({ foreign: true, keyMode: null }))).toEqual({
      state: "blocked",
      reason: "keyMismatch",
      detail: KEY_CHECK_FAILED_LINE,
    });
  });

  it("offers the update behind an acknowledged block once the node takes it", () => {
    expect(
      privateReadiness(
        signals({
          setup: setup({ held: true, needsCompact: true, baseLayers: 4 }),
          blockedAck: "history index incomplete",
          keyMode: update("key_bound_migration", 4),
          keyFee: { state: "error" },
        }),
      ),
    ).toEqual({
      state: "keyUpdate",
      mode: "key_bound_migration",
      amountMicro: 4,
      fee: { state: "error" },
    });
  });

  it("prefers the Migrate balance popup over a key update for a refresh due", () => {
    expect(
      privateReadiness(
        signals({
          setup: setup({ needsCompact: true, baseLayers: 4 }),
          blockedAck: "x",
          keyMode: update("key_bound_migration", 4),
        }),
      ),
    ).toEqual({ state: "needsRefresh" });
  });

  it("does not offer an update an acknowledged block never asked for on a healthy balance", () => {
    expect(
      privateReadiness(signals({ blockedAck: "x", keyMode: update("empty_key_switch") })),
    ).toEqual({ state: "ok" });
  });
});

describe("key dialog mode mapping", () => {
  it.each([
    [{ mode: "empty_key_switch" }, { kind: "update", mode: "empty_key_switch", amountMicro: 0 }],
    [{ mode: "legacy_zero_reset" }, { kind: "update", mode: "legacy_zero_reset", amountMicro: 0 }],
    [
      { mode: "legacy_public_migration", amount: 9, oldCipher: "c" },
      { kind: "update", mode: "legacy_public_migration", amountMicro: 9 },
    ],
    [
      { mode: "key_bound_migration", amount: 4, oldCipher: "c", oldPubkey: "p", keyCurrent: true },
      { kind: "update", mode: "key_bound_migration", amountMicro: 4 },
    ],
    [
      { mode: "key_bound_unavailable", keyCurrent: true },
      { kind: "unavailable", keyCurrent: true },
    ],
    [
      { mode: "blocked", reason: "no" },
      { kind: "blocked", reason: "no" },
    ],
  ] as const)("maps %o", (mode, signal) => {
    expect(keyModeSignal(mode as KeySwitchMode)).toEqual(signal);
  });

  it("knows which modes move a balance", () => {
    expect(keyUpdateMovesBalance("legacy_public_migration")).toBe(true);
    expect(keyUpdateMovesBalance("key_bound_migration")).toBe(true);
    expect(keyUpdateMovesBalance("empty_key_switch")).toBe(false);
    expect(keyUpdateMovesBalance("legacy_zero_reset")).toBe(false);
  });
});

describe("key update re-check before signing", () => {
  const expected = { mode: "legacy_public_migration" as const, amountMicro: 9 };

  it("passes when the node resolves the same mode and balance", () => {
    expect(
      keyUpdateMismatch({ mode: "legacy_public_migration", amount: 9, oldCipher: "c" }, expected),
    ).toBeNull();
  });

  it("refuses when the mode changed", () => {
    expect(keyUpdateMismatch({ mode: "legacy_zero_reset" }, expected)).toMatch(/changed/);
  });

  it("refuses when the balance changed", () => {
    expect(
      keyUpdateMismatch({ mode: "legacy_public_migration", amount: 10, oldCipher: "c" }, expected),
    ).toMatch(/balance changed/);
  });

  it.each([
    [{ mode: "blocked", reason: "no" }],
    [{ mode: "key_bound_unavailable", keyCurrent: false }],
  ] as const)("refuses when the node no longer takes it %o", (mode) => {
    expect(keyUpdateMismatch(mode as KeySwitchMode, expected)).toMatch(/no longer/);
  });
});

describe("tray migrate requests", () => {
  const live = { walletId: "w1", network: "devnet", fee: { ou: 1_000_000, floorOu: 1_000_000 } };
  const req = {
    walletId: "w1",
    network: "devnet",
    feeOu: 1_000_000,
    mode: "key_bound_migration",
    amountMicro: 5,
    confirmed: true,
  };

  it("accepts the update the review showed", () => {
    expect(trayMigrateRequestError(req, live)).toBeNull();
    expect(
      trayMigrateRequestError({ ...req, mode: "empty_key_switch", amountMicro: 0 }, live),
    ).toBeNull();
  });

  it("needs the explicit confirm", () => {
    expect(trayMigrateRequestError({ ...req, confirmed: false }, live)).toMatch(/Confirm/);
    expect(trayMigrateRequestError({ ...req, confirmed: undefined }, live)).toMatch(/Confirm/);
  });

  it.each([
    [{ mode: "rotate" }],
    [{ amountMicro: -1 }],
    [{ amountMicro: 1.5 }],
    [{ mode: "empty_key_switch", amountMicro: 3 }],
    [{ mode: "legacy_zero_reset", amountMicro: 3 }],
  ])("refuses a request the review could not show %o", (over) => {
    expect(trayMigrateRequestError({ ...req, ...over }, live)).toMatch(/does not look right/);
  });

  it.each([[{ walletId: "w2" }], [{ network: "mainnet" }]] as const)(
    "refuses when the wallet or network changed %o",
    (over) => {
      expect(trayMigrateRequestError(req, { ...live, ...over })).toMatch(/wallet or network/);
    },
  );

  it("keeps the reviewed fee while the node still takes it", () => {
    const fee = (ou: number, floorOu: number) => ({ ...live, fee: { ou, floorOu } });
    expect(trayMigrateRequestError(req, fee(1_400_000, 3_000))).toBeNull();
    expect(trayMigrateRequestError(req, fee(700_000, 3_000))).toBeNull();
    expect(trayMigrateRequestError(req, fee(1_400_000, 1_000_001))).toMatch(/fee changed/);
    expect(trayMigrateRequestError(req, { ...live, fee: null })).toMatch(/fee unavailable/);
  });
});

describe("tray key update steps", () => {
  it("names moving the balance only when the mode moves one", () => {
    expect(keyUpdateSteps(true)).toContain("Moving your balance");
    expect(keyUpdateSteps(false)).not.toContain("Moving your balance");
    const steps = keyUpdateSteps(false);
    expect(steps[steps.length - 1]).toBe("Waiting for the network");
  });
});

describe("tray turn on", () => {
  const noKey = (over: Partial<ReadinessSignals> = {}) =>
    privateReadiness(
      signals({
        setup: setup({ regState: "unregistered" }),
        setupChecks: { regState: "unregistered", canKeySwitch: true, feeRaw: "1000000" },
        publicMicro: 5_000_000,
        ...over,
      }),
    );

  it("offers turn on at the live fee when the public balance covers it", () => {
    expect(noKey()).toEqual({ state: "noKey", setup: { state: "offer", feeOu: 1_000_000 } });
  });

  it("asks for the missing OCT when the fee is not covered", () => {
    expect(noKey({ publicMicro: 400_000 })).toEqual({
      state: "noKey",
      setup: { state: "short", feeOu: 1_000_000, addMicro: 600_000 },
    });
  });

  it("asks for the whole fee on an empty wallet", () => {
    expect(noKey({ publicMicro: 0 })).toEqual({
      state: "noKey",
      setup: { state: "short", feeOu: 1_000_000, addMicro: 1_000_000 },
    });
  });

  it.each([
    [{ setupChecks: undefined }],
    [{ setupChecks: null }],
    [{ publicMicro: null }],
  ] as const)("keeps checking without the setup checks %o", (over) => {
    expect(noKey(over as Partial<ReadinessSignals>)).toEqual({
      state: "noKey",
      setup: { state: "checking" },
    });
  });

  it("offers a retry, never a fee, when the live fee is missing", () => {
    expect(
      noKey({ setupChecks: { regState: "unregistered", canKeySwitch: true, feeRaw: null } }),
    ).toEqual({ state: "noKey", setup: { state: "unavailable", reason: "fee" } });
  });

  it.each(["fee", "check"] as const)("offers a retry when the %s read failed", (reason) => {
    expect(noKey({ setupChecks: null, setupError: reason })).toEqual({
      state: "noKey",
      setup: { state: "unavailable", reason },
    });
  });

  it("is blocked when the node refuses a key switch", () => {
    expect(
      noKey({ setupChecks: { regState: "unregistered", canKeySwitch: false, feeRaw: "1000000" } }),
    ).toEqual({ state: "blocked", reason: "keyBlocked", detail: KEY_BLOCKED_LINE });
  });

  it("is blocked with the node's reason after an acknowledged block", () => {
    expect(noKey({ blockedAck: "node says no" })).toEqual({
      state: "blocked",
      reason: "keyBlocked",
      detail: "node says no",
    });
  });

  it("waits instead of offering again once a registration is staged", () => {
    expect(noKey({ staged: true })).toEqual({ state: "waiting", reason: "setupPending" });
  });
});

describe("tray refresh and turn on requests", () => {
  const req = { walletId: "w1", network: "devnet", feeOu: 2_000_000 };
  const live = { walletId: "w1", network: "devnet", fee: { ou: 2_000_000, floorOu: 3_000 } };

  it("accepts the request the review showed", () => {
    expect(trayRequestError(req, live)).toBeNull();
  });

  it.each([[{ walletId: "w2" }], [{ walletId: null }], [{ network: "mainnet" }]] as const)(
    "refuses when the wallet or network changed %o",
    (over) => {
      expect(trayRequestError(req, { ...live, ...over })).toMatch(/wallet or network changed/);
    },
  );

  it("signs the reviewed fee when the recommendation moved but the node still takes it", () => {
    expect(trayRequestError(req, { ...live, fee: { ou: 2_000_001, floorOu: 3_000 } })).toBeNull();
    expect(trayRequestError(req, { ...live, fee: { ou: 1_500_000, floorOu: 3_000 } })).toBeNull();
  });

  it("refuses when the node now takes only more than the reviewed fee", () => {
    const fee = { ou: 2_500_000, floorOu: 2_000_001 };
    expect(trayRequestError(req, { ...live, fee })).toMatch(/fee changed/);
  });

  it.each([0, -1, 1.5, Number.NaN])("refuses a reviewed fee of %s", (feeOu) => {
    expect(trayRequestError({ ...req, feeOu }, live)).toMatch(/does not look right/);
  });
});

describe("tray private steps", () => {
  it("lists only the op without a refresh", () => {
    expect(privateSteps("encrypt", false)).toEqual([
      "Preparing",
      "Encrypting the amount",
      "Range proofs",
      "Sending",
    ]);
  });

  it("puts the refresh first and numbers the last op step", () => {
    expect(privateSteps("decrypt", true)).toEqual([
      "Refreshing your private balance (1 of 2)",
      "Preparing",
      "Decrypting proof",
      "Range proofs",
      "Sending (2 of 2)",
    ]);
  });
});

const READY: FreshReadiness = { ready: true, needsCompact: false };
const DUE: FreshReadiness = { ready: false, needsCompact: true };

function harness(
  reads: (FreshReadiness | Error)[],
  refreshStatus: RefreshOutcome["status"] = "confirmed",
) {
  const log: string[] = [];
  let i = 0;
  const deps = {
    readiness: vi.fn(async () => {
      const r = reads[Math.min(i++, reads.length - 1)];
      log.push(`read:${r instanceof Error ? "error" : r.ready ? "ready" : "due"}`);
      if (r instanceof Error) throw r;
      return r;
    }),
    refresh: vi.fn(async () => {
      log.push("refresh");
      return { txHash: "h", status: refreshStatus };
    }),
    op: vi.fn(async (onStep: (n: number) => void) => {
      log.push("op");
      onStep(1);
    }),
    sleep: vi.fn(async () => {
      log.push("sleep");
    }),
  };
  return { deps, log };
}

describe("tray refresh then continue", () => {
  it("runs only the op when no refresh is due", async () => {
    const { deps, log } = harness([READY]);
    await runPrivateOp({ reviewedRefresh: false, deps });
    expect(log).toEqual(["read:ready", "op"]);
  });

  it("refreshes, waits for the node to serve the new balance, then runs the op", async () => {
    const { deps, log } = harness([DUE, DUE, DUE, READY]);
    const events: string[] = [];
    await runPrivateOp({
      reviewedRefresh: true,
      deps,
      onEvent: (e) => events.push(e.phase === "op" ? `op${e.step}` : e.phase),
    });
    expect(log).toEqual([
      "read:due",
      "refresh",
      "read:due",
      "sleep",
      "read:due",
      "sleep",
      "read:ready",
      "op",
    ]);
    expect(events).toEqual(["refresh", "op0", "op1"]);
  });

  it("keeps waiting through a transient read failure after the refresh", async () => {
    const { deps, log } = harness([DUE, new Error("busy"), READY]);
    await runPrivateOp({ reviewedRefresh: true, deps });
    expect(log).toEqual(["read:due", "refresh", "read:error", "sleep", "read:ready", "op"]);
  });

  it("stops before the op when the refresh is rejected", async () => {
    const { deps } = harness([DUE], "rejected");
    await expect(runPrivateOp({ reviewedRefresh: true, deps })).rejects.toThrow(/rejected/);
    expect(deps.op).not.toHaveBeenCalled();
  });

  it("stops before the op when the refresh is still confirming", async () => {
    const { deps } = harness([DUE], "pending");
    await expect(runPrivateOp({ reviewedRefresh: true, deps })).rejects.toThrow(/confirming/);
    expect(deps.op).not.toHaveBeenCalled();
  });

  it("stops before the op when the refresh itself throws", async () => {
    const { deps } = harness([DUE]);
    deps.refresh.mockRejectedValueOnce(new Error("proof failed"));
    await expect(runPrivateOp({ reviewedRefresh: true, deps })).rejects.toThrow("proof failed");
    expect(deps.op).not.toHaveBeenCalled();
  });

  it("stops when the node never serves the refreshed balance", async () => {
    const { deps } = harness([DUE]);
    await expect(runPrivateOp({ reviewedRefresh: true, deps, serveTimeoutMs: 0 })).rejects.toThrow(
      /old balance/,
    );
    expect(deps.op).not.toHaveBeenCalled();
  });

  it("refuses a refresh the review did not show", async () => {
    const { deps } = harness([DUE]);
    await expect(runPrivateOp({ reviewedRefresh: false, deps })).rejects.toThrow(/Review again/);
    expect(deps.refresh).not.toHaveBeenCalled();
    expect(deps.op).not.toHaveBeenCalled();
  });

  it("skips the refresh when it is no longer due", async () => {
    const { deps, log } = harness([READY]);
    await runPrivateOp({ reviewedRefresh: true, deps });
    expect(log).toEqual(["read:ready", "op"]);
  });

  it("refuses a balance only the app can fix", async () => {
    const { deps } = harness([{ ready: false, needsCompact: false }]);
    await expect(runPrivateOp({ reviewedRefresh: false, deps })).rejects.toThrow(
      /spent or migrated/,
    );
    expect(deps.op).not.toHaveBeenCalled();
  });

  it("does not refresh on an unreadable balance", async () => {
    const { deps } = harness([new Error("busy")]);
    await expect(runPrivateOp({ reviewedRefresh: true, deps })).rejects.toThrow(/Could not read/);
    expect(deps.refresh).not.toHaveBeenCalled();
  });

  it("lets the op guard re-check when no refresh was planned and the read fails", async () => {
    const { deps, log } = harness([new Error("busy")]);
    await runPrivateOp({ reviewedRefresh: false, deps });
    expect(log).toEqual(["read:error", "op"]);
  });
});

describe("tray refresh on its own", () => {
  it("refreshes and waits until the node serves the new balance", async () => {
    const { deps, log } = harness([DUE, DUE, READY]);
    const events: string[] = [];
    await runPrivateRefresh({ deps, onEvent: (e) => events.push(e.phase) });
    expect(log).toEqual(["read:due", "refresh", "read:due", "sleep", "read:ready"]);
    expect(events).toEqual(["refresh", "serve"]);
    expect(deps.op).not.toHaveBeenCalled();
  });

  it("refuses when no refresh is due any more", async () => {
    const { deps } = harness([READY]);
    await expect(runPrivateRefresh({ deps })).rejects.toThrow(/does not need a refresh/);
    expect(deps.refresh).not.toHaveBeenCalled();
  });

  it("refuses a balance only the app can fix", async () => {
    const { deps } = harness([{ ready: false, needsCompact: false }]);
    await expect(runPrivateRefresh({ deps })).rejects.toThrow(/spent or migrated/);
    expect(deps.refresh).not.toHaveBeenCalled();
  });

  it("does not refresh on an unreadable balance", async () => {
    const { deps } = harness([new Error("busy")]);
    await expect(runPrivateRefresh({ deps })).rejects.toThrow(/Could not read/);
    expect(deps.refresh).not.toHaveBeenCalled();
  });

  it("stops on a rejected refresh", async () => {
    const { deps } = harness([DUE], "rejected");
    await expect(runPrivateRefresh({ deps })).rejects.toThrow(/rejected/);
  });

  it("stops when the node never serves the refreshed balance", async () => {
    const { deps } = harness([DUE]);
    await expect(runPrivateRefresh({ deps, serveTimeoutMs: 0 })).rejects.toThrow(/old balance/);
  });
});

describe("tray private send at sign time", () => {
  const fresh = (over: Partial<FreshSendReadiness> = {}): FreshSendReadiness => ({
    ready: true,
    needsCompact: false,
    registration: "registered",
    keyUpdate: false,
    waiting: false,
    ...over,
  });
  const run = (read: FreshSendReadiness | Error) => {
    const op = vi.fn(async () => {});
    const readiness = vi.fn(async () => {
      if (read instanceof Error) throw read;
      return read;
    });
    return { op, done: runPrivateSend({ readiness, op }) };
  };

  it("sends while the balance is ready", async () => {
    const { op, done } = run(fresh());
    await done;
    expect(op).toHaveBeenCalledOnce();
  });

  it.each([
    ["a migration is due", fresh({ ready: false, needsCompact: true }), /needs a migration first/],
    ["the balance can't be proven", fresh({ ready: false }), /can't be spent or migrated/],
    ["the private balance is off", fresh({ registration: "unregistered" }), /Turn on/],
    ["the setup is confirming", fresh({ registration: "pending" }), /still being set up/],
    ["the key needs an update", fresh({ keyUpdate: true }), /key update first/],
    ["a key switch is waiting", fresh({ waiting: true }), /waiting for the network/],
    ["the read fails", new Error("busy"), /Could not read/],
  ])("refuses before any proof work when %s", async (_why, read, copy) => {
    const { op, done } = run(read);
    await expect(done).rejects.toThrow(copy);
    expect(op).not.toHaveBeenCalled();
  });
});
