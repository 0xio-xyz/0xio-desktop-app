import { describe, expect, it, vi } from "vitest";
import {
  FEE_CHANGED,
  FEE_UNAVAILABLE,
  GENERIC_FAILURE,
  NEEDS_MIGRATION,
  NOT_TURNED_ON,
  SETTING_UP,
  STUCK,
  TrayError,
  approveTrayRequest,
  feeOu,
  feeRead,
  trayErrorCopy,
  trayErrorDetail,
  trayFeeError,
  trayScope,
} from "src/features/privacy/services/trayPrivate";
import { FeeUnavailableError } from "src/services/network/networkService";

const live = {
  walletId: "w1",
  address: "octA",
  network: "devnet",
  rpcNetwork: "devnet",
};
const req = { walletId: "w1", network: "devnet" };

describe("tray scope", () => {
  it("pins the reviewed network and the active address", () => {
    expect(trayScope(req, live)).toEqual({ networkId: "devnet", address: "octA" });
  });

  it("refuses when the shown network moved", () => {
    expect(trayScope(req, { ...live, network: "mainnet", rpcNetwork: "mainnet" })).toBeNull();
  });

  it("refuses when the RPC moved before the window re-rendered", () => {
    expect(trayScope(req, { ...live, rpcNetwork: "mainnet" })).toBeNull();
  });

  it("refuses another wallet or none", () => {
    expect(trayScope(req, { ...live, walletId: "w2" })).toBeNull();
    expect(trayScope(req, { ...live, walletId: null })).toBeNull();
    expect(trayScope(req, { ...live, address: null })).toBeNull();
  });
});

describe("tray approval", () => {
  const base = () => ({
    hasPassword: true,
    biometric: true,
    promptBiometric: vi.fn(async () => {}),
    isPending: vi.fn(() => true),
    run: vi.fn(),
    approving: vi.fn(),
    needPassword: vi.fn(),
  });

  it("runs the handlers of the moment Touch ID returns, not of the request", async () => {
    let resolve!: () => void;
    const handlers = { current: (n: string) => `stale ${n}` };
    const ran: string[] = [];
    const a = {
      ...base(),
      promptBiometric: () => new Promise<void>((r) => (resolve = r)),
      run: () => ran.push(handlers.current("devnet")),
    };
    const done = approveTrayRequest(a);
    handlers.current = (n: string) => `latest refuses ${n}`;
    resolve();
    await done;
    expect(ran).toEqual(["latest refuses devnet"]);
  });

  it("never runs a request cancelled during Touch ID", async () => {
    const a = { ...base(), isPending: vi.fn(() => false) };
    await approveTrayRequest(a);
    expect(a.run).not.toHaveBeenCalled();
    expect(a.needPassword).not.toHaveBeenCalled();
  });

  it("asks for the password when Touch ID is cancelled", async () => {
    const a = { ...base(), promptBiometric: vi.fn(async () => Promise.reject(new Error("x"))) };
    await approveTrayRequest(a);
    expect(a.run).not.toHaveBeenCalled();
    expect(a.needPassword).toHaveBeenCalledOnce();
  });

  it("asks for the password when Touch ID is off", async () => {
    const a = { ...base(), biometric: false };
    await approveTrayRequest(a);
    expect(a.promptBiometric).not.toHaveBeenCalled();
    expect(a.needPassword).toHaveBeenCalledOnce();
  });

  it("runs straight away without a password", async () => {
    const a = { ...base(), hasPassword: false };
    await approveTrayRequest(a);
    expect(a.run).toHaveBeenCalledOnce();
  });
});

describe("tray fee check", () => {
  const live = (ou: number, floorOu = 3_000) => ({ ou, floorOu });

  it("signs the reviewed fee when a read after the review gives the same fee", () => {
    expect(trayFeeError(24_987, live(24_987))).toBeNull();
  });

  it("signs the reviewed fee when the recommendation moved down or up", () => {
    expect(trayFeeError(24_987, live(23_061))).toBeNull();
    expect(trayFeeError(24_987, live(30_047))).toBeNull();
  });

  it("asks again only when the node now takes only more than the reviewed fee", () => {
    expect(trayFeeError(24_987, live(60_000, 24_987))).toBeNull();
    expect(trayFeeError(24_987, live(60_000, 24_988))).toBe(FEE_CHANGED);
  });

  it("treats a read with no minimum as its own floor", () => {
    expect(trayFeeError(1_000_000, live(1_000_000, 1_000_000))).toBeNull();
    expect(trayFeeError(1_000_000, live(1_200_000, 1_200_000))).toBe(FEE_CHANGED);
  });

  it("blocks when the live read failed", () => {
    expect(trayFeeError(1_000_000, null)).toBe(FEE_UNAVAILABLE);
  });

  it("reads only positive whole fees", () => {
    expect(feeOu("1,000,000")).toBe(1_000_000);
    expect(feeOu("0")).toBeNull();
    expect(feeOu("abc")).toBeNull();
    expect(feeOu(undefined)).toBeNull();
  });
});

describe("fee read", () => {
  it("is loading until the first read lands", () => {
    expect(feeRead({ status: "pending", fetchStatus: "fetching" })).toEqual({ state: "loading" });
    expect(feeRead({ status: "pending", fetchStatus: "idle" })).toEqual({ state: "loading" });
  });

  it("is an error with a retry, not a stuck check, when the read failed", () => {
    expect(feeRead({ status: "error", fetchStatus: "idle" })).toEqual({ state: "error" });
  });

  it("shows loading again while a retry runs", () => {
    expect(feeRead({ status: "error", fetchStatus: "fetching" })).toEqual({ state: "loading" });
  });

  it("is the amount once read", () => {
    expect(feeRead({ status: "success", data: 3_000 })).toEqual({ state: "ok", ou: 3_000 });
    expect(feeRead({ status: "success", data: { ou: 24_987, floorOu: 3_000 } })).toEqual({
      state: "ok",
      ou: 24_987,
      floor: 3_000,
    });
    expect(feeRead({ status: "success", data: 0 })).toEqual({ state: "loading" });
  });
});

describe("tray error copy", () => {
  it("keeps house copy", () => {
    expect(trayErrorCopy(new TrayError("A migration is already waiting for the network."))).toBe(
      "A migration is already waiting for the network.",
    );
    expect(trayErrorCopy(new Error("Your private balance changed. Review again."))).toBe(
      "Your private balance changed. Review again.",
    );
  });

  it("names a failed fee read", () => {
    expect(trayErrorCopy(new FeeUnavailableError())).toBe(FEE_UNAVAILABLE);
  });

  it("names a scope change", () => {
    const e = new Error("The network changed while this transaction was being prepared.");
    e.name = "ScopeChanged";
    expect(trayErrorCopy(e)).toBe("The wallet or network changed. Nothing was sent.");
  });

  it.each([
    ["RPC error -32000: fee too low (min 1200000)", FEE_CHANGED],
    ["insufficient balance for tx", "Insufficient balance"],
    ["bad nonce 12, expected 13", "Another transaction is still pending. Try again in a moment."],
    ["HTTP 429: Too Many Requests", "The network did not respond. Try again."],
    ["The operation was aborted", "The network did not respond. Try again."],
    [
      "Network is not accepting key updates for this account yet - nothing is lost, try again later",
      "The network is not taking key updates for this account yet. Nothing is lost.",
    ],
    ['{"code":-1,"message":"zk verify failed"}', GENERIC_FAILURE],
  ])("maps %s", (raw, copy) => {
    expect(trayErrorCopy(new Error(raw))).toBe(copy);
  });

  it.each([
    [
      "PvacCompactNeeded",
      "Migrate your balance first - use the Migrate balance button",
      NEEDS_MIGRATION,
    ],
    ["PvacNotSpendable", "This balance can't be spent privately yet: bad r_com.", STUCK],
    ["PvacSetupPending", "Set up your private balance first.", NOT_TURNED_ON],
    [
      "PvacSetupPending",
      "Private balance setup is confirming on-chain. Try again in a moment.",
      SETTING_UP,
    ],
  ])("maps a %s guard to standard copy", (name, raw, copy) => {
    const e = new Error(raw);
    e.name = name;
    expect(trayErrorCopy(e)).toBe(copy);
  });

  it("names a recipient that can't receive private transfers", () => {
    expect(
      trayErrorCopy(
        new Error("Recipient has no view pubkey registered. They need to register first."),
      ),
    ).toBe("This address can't receive private transfers yet.");
  });

  it("never shows a dash or raw JSON", () => {
    for (const raw of ["x - y", '{"error":1}', "", "undefined"])
      expect(trayErrorCopy(new Error(raw))).not.toMatch(/ - |[{}]/);
  });

  it("keeps the raw text for the log", () => {
    expect(trayErrorDetail(new TrayError("The network rejected the update.", "bad proof"))).toBe(
      "The network rejected the update. (bad proof)",
    );
    expect(trayErrorDetail(new Error("raw"))).toBe("Error: raw");
  });
});
