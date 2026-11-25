import { describe, it, expect, vi, beforeEach } from "vitest";

const matchesSecretProfile = vi.fn();

vi.mock("src/services/pvac/pvacBridge", () => ({
  pvacBridge: {
    requireContext: () => "ctx-a",
    matchesSecretProfile: (pubkey: string) => matchesSecretProfile(pubkey),
  },
}));

const { isOurPubkey } = await import("src/features/privacy/services/privacyService");

describe("isOurPubkey", () => {
  beforeEach(() => {
    matchesSecretProfile.mockReset();
  });

  it("reports a key derived from our secret as ours", async () => {
    matchesSecretProfile.mockResolvedValue({ matches: true, profile: 1 });
    expect(await isOurPubkey("octA", "remote-a")).toBe(true);
  });

  it("reports a foreign key as not ours", async () => {
    matchesSecretProfile.mockResolvedValue({ matches: false, profile: 1 });
    expect(await isOurPubkey("octA", "remote-b")).toBe(false);
  });

  it("caches per remote key so the 3MB deserialize runs once", async () => {
    matchesSecretProfile.mockResolvedValue({ matches: true, profile: 2 });
    await isOurPubkey("octA", "remote-c");
    await isOurPubkey("octA", "remote-c");
    expect(matchesSecretProfile).toHaveBeenCalledTimes(1);
  });

  it("treats a bridge failure as foreign rather than throwing", async () => {
    matchesSecretProfile.mockRejectedValue(new Error("pvac not initialized"));
    await expect(isOurPubkey("octA", "remote-d")).resolves.toBe(false);
  });

  it("does not cache a failure, so a later call can still succeed", async () => {
    matchesSecretProfile.mockRejectedValueOnce(new Error("transient"));
    expect(await isOurPubkey("octA", "remote-e")).toBe(false);
    matchesSecretProfile.mockResolvedValue({ matches: true, profile: 1 });
    expect(await isOurPubkey("octA", "remote-e")).toBe(true);
  });
});
