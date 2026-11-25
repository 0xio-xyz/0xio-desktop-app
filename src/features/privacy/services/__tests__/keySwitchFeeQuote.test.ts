import { beforeEach, describe, expect, it, vi } from "vitest";

const strict = vi.fn();
vi.mock("src/services/network/networkService", async (orig) => ({
  ...(await orig<typeof import("src/services/network/networkService")>()),
  getRecommendedFeeStrict: (...args: unknown[]) => strict(...args),
}));

import {
  getKeySwitchFeeLive,
  getKeySwitchFeeQuote,
} from "src/features/privacy/services/privacyService";
import { boundedKeySwitchFee } from "src/features/privacy/services/pvacUpgradePolicy";

beforeEach(() => strict.mockReset());

describe("key_switch fee quote", () => {
  it("reads the tier asked for on the network asked for", async () => {
    strict.mockResolvedValue({ minimum: "3000", recommended: "1200000", fast: "2400000" });
    expect(await getKeySwitchFeeQuote("recommended", "mainnet")).toBe("1200000");
    expect(await getKeySwitchFeeQuote("fast", "mainnet")).toBe("2400000");
    expect(strict).toHaveBeenCalledWith("key_switch", "mainnet");
  });

  it("reads the node's minimum with the fee, never under the policy minimum", async () => {
    strict.mockResolvedValue({ minimum: "3000", recommended: "24259", fast: "48518" });
    expect(await getKeySwitchFeeLive("recommended", "devnet")).toEqual({
      ou: 24_259,
      floorOu: 5_000,
    });
    expect(await getKeySwitchFeeLive("fast", "devnet")).toEqual({ ou: 48_518, floorOu: 5_000 });
    strict.mockResolvedValue({ minimum: "1000", recommended: "24259", fast: "48518" });
    expect((await getKeySwitchFeeLive("recommended", "devnet")).floorOu).toBe(5_000);
  });

  it("throws instead of a 1,000,000 fallback when the read fails", async () => {
    strict.mockResolvedValue(null);
    await expect(getKeySwitchFeeQuote("recommended", "devnet")).rejects.toMatchObject({
      name: "FeeUnavailable",
    });
  });

  it("throws for a fee outside the allowed range", async () => {
    strict.mockResolvedValue({ minimum: "1", recommended: "1", fast: "999999999" });
    await expect(getKeySwitchFeeQuote("recommended", "devnet")).rejects.toThrow(
      "Network fee unavailable. Try again.",
    );
    await expect(getKeySwitchFeeQuote("fast", "devnet")).rejects.toThrow();
  });
});

describe("bounded key_switch fee", () => {
  it("has no fallback", () => {
    expect(boundedKeySwitchFee(undefined)).toBeNull();
    expect(boundedKeySwitchFee("")).toBeNull();
    expect(boundedKeySwitchFee("4999")).toBeNull();
    expect(boundedKeySwitchFee("5000")).toBe("5000");
    expect(boundedKeySwitchFee("10000001")).toBeNull();
    expect(boundedKeySwitchFee("1500000.7")).toBe("1500000");
  });
});
