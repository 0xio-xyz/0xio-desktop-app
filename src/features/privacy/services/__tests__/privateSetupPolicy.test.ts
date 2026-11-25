import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  shouldOfferPrivateSetup,
  type PrivateSetupSignals,
} from "src/features/privacy/services/privateSetupPolicy";

const svc = vi.hoisted(() => ({
  regState: vi.fn(),
  feeQuote: vi.fn(),
  migration: vi.fn(),
}));

vi.mock("src/features/privacy/services/privacyService", () => ({
  getPvacRegistrationState: svc.regState,
  getKeySwitchFeeLive: svc.feeQuote,
}));
vi.mock("src/services/network/networkService", () => ({
  getPvacMigrationStatus: svc.migration,
}));

const FEE = "1000000";

const ready = (over: Partial<PrivateSetupSignals> = {}): PrivateSetupSignals => ({
  privacy: true,
  canSign: true,
  keyBlocked: false,
  pending: false,
  checks: { regState: "unregistered", canKeySwitch: true, feeRaw: FEE },
  publicBalanceRaw: 25_000_000,
  ...over,
});

describe("Set up private tag visibility", () => {
  it("shows for a funded signing wallet with no key on chain", () => {
    expect(shouldOfferPrivateSetup(ready())).toBe(true);
  });

  it("shows when the balance exactly covers the fee", () => {
    expect(shouldOfferPrivateSetup(ready({ publicBalanceRaw: Number(FEE) }))).toBe(true);
  });

  it("hides below the live fee", () => {
    expect(shouldOfferPrivateSetup(ready({ publicBalanceRaw: Number(FEE) - 1 }))).toBe(false);
  });

  it("follows the fee the node quotes rather than a fixed figure", () => {
    const checks = { regState: "unregistered" as const, canKeySwitch: true, feeRaw: "3000" };
    expect(shouldOfferPrivateSetup(ready({ checks, publicBalanceRaw: 3_000 }))).toBe(true);
    expect(shouldOfferPrivateSetup(ready({ checks, publicBalanceRaw: 2_999 }))).toBe(false);
  });

  it("hides without privacy on the network", () => {
    expect(shouldOfferPrivateSetup(ready({ privacy: false }))).toBe(false);
  });

  it("hides for a watch-only wallet", () => {
    expect(shouldOfferPrivateSetup(ready({ canSign: false }))).toBe(false);
  });

  it("hides once a key is registered", () => {
    const checks = { regState: "registered" as const, canKeySwitch: true, feeRaw: FEE };
    expect(shouldOfferPrivateSetup(ready({ checks }))).toBe(false);
  });

  it("hides while a registration is pending", () => {
    const checks = { regState: "pending" as const, canKeySwitch: true, feeRaw: FEE };
    expect(shouldOfferPrivateSetup(ready({ checks }))).toBe(false);
    expect(shouldOfferPrivateSetup(ready({ pending: true }))).toBe(false);
  });

  it("hides when the node refuses a key_switch", () => {
    const checks = { regState: "unregistered" as const, canKeySwitch: false, feeRaw: FEE };
    expect(shouldOfferPrivateSetup(ready({ checks }))).toBe(false);
  });

  it("never sits beside the key-hold tag", () => {
    expect(shouldOfferPrivateSetup(ready({ keyBlocked: true }))).toBe(false);
  });

  it("hides when a read failed or has not landed", () => {
    expect(shouldOfferPrivateSetup(ready({ checks: null }))).toBe(false);
    expect(shouldOfferPrivateSetup(ready({ publicBalanceRaw: null }))).toBe(false);
  });

  it("hides without a usable fee", () => {
    for (const feeRaw of [null, "", "0", "abc"]) {
      const checks = { regState: "unregistered" as const, canKeySwitch: true, feeRaw };
      expect(shouldOfferPrivateSetup(ready({ checks }))).toBe(false);
    }
  });
});

describe("Set up private checks", () => {
  beforeEach(() => {
    svc.regState.mockReset();
    svc.feeQuote.mockReset();
    svc.migration.mockReset();
  });

  const read = async (...a: [string, string]) =>
    (await import("src/hooks/privacy/usePrivateSetupTag")).readPrivateSetupChecks(...a);

  it("asks the node for the fee and key_switch only when no key is registered", async () => {
    svc.regState.mockResolvedValue("registered");
    const out = await read("oct1", "devnet");
    expect(out.regState).toBe("registered");
    expect(svc.migration).not.toHaveBeenCalled();
    expect(svc.feeQuote).not.toHaveBeenCalled();
  });

  it("reads the live fee on the current network", async () => {
    svc.regState.mockResolvedValue("unregistered");
    svc.migration.mockResolvedValue({ can_key_switch: true });
    svc.feeQuote.mockResolvedValue({ ou: 1_250_000, floorOu: 3_000 });
    const out = await read("oct1", "devnet");
    expect(svc.feeQuote).toHaveBeenCalledWith("recommended", "devnet");
    expect(svc.migration).toHaveBeenCalledWith("oct1", "devnet");
    expect(out).toEqual({
      regState: "unregistered",
      canKeySwitch: true,
      feeRaw: "1250000",
      floorRaw: "3000",
    });
  });

  it("fails rather than guessing when the key_switch status cannot be read", async () => {
    svc.regState.mockResolvedValue("unregistered");
    svc.migration.mockResolvedValue(null);
    svc.feeQuote.mockResolvedValue({ ou: Number(FEE), floorOu: 3_000 });
    await expect(read("oct1", "devnet")).rejects.toThrow();
  });

  it("fails when the key read fails", async () => {
    svc.regState.mockRejectedValue(new Error("503"));
    await expect(read("oct1", "devnet")).rejects.toThrow("503");
  });

  it("carries a refused key_switch through", async () => {
    svc.regState.mockResolvedValue("unregistered");
    svc.migration.mockResolvedValue({ can_key_switch: false });
    svc.feeQuote.mockResolvedValue({ ou: Number(FEE), floorOu: 3_000 });
    expect((await read("oct1", "devnet")).canKeySwitch).toBe(false);
  });
});
