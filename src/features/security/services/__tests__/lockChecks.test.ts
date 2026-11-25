// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  hasPassword: vi.fn(),
  needsPassword: vi.fn(),
  status: vi.fn(),
  bioEnabled: vi.fn(),
}));
vi.mock("src/services/wallet/walletBridge", () => ({
  walletBridge: {
    hasPassword: () => m.hasPassword(),
    needsPassword: () => m.needsPassword(),
    unlockStatus: () => m.status(),
  },
}));
vi.mock("src/services/wallet/biometricService", () => ({
  biometricService: { isEnabled: () => m.bioEnabled() },
}));

const { biometricHint, prefetchLockChecks, takeLockChecks } =
  await import("src/features/security/services/lockChecks");

const fresh = { attempts_left: 5, next_lockout_seconds: 30, locked_seconds: 0 };

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset();
  localStorage.clear();
  m.hasPassword.mockResolvedValue(true);
  m.status.mockResolvedValue(fresh);
  m.bioEnabled.mockResolvedValue(false);
});

describe("lock checks", () => {
  it("are asked once when prefetched and handed to the first lock screen only", async () => {
    prefetchLockChecks();
    prefetchLockChecks();
    const first = takeLockChecks();
    expect(await first.password).toBe("set");
    expect(await first.status).toEqual(fresh);
    expect(m.hasPassword).toHaveBeenCalledTimes(1);
    takeLockChecks();
    expect(m.hasPassword).toHaveBeenCalledTimes(2);
  });

  it("asks Touch ID and the lockout only for a vault with a password", async () => {
    m.hasPassword.mockResolvedValue(false);
    m.needsPassword.mockResolvedValue(true);
    const checks = takeLockChecks();
    expect(await checks.password).toBe("needed");
    expect(await checks.status).toBeNull();
    expect(await checks.biometric).toBe(false);
    expect(m.status).not.toHaveBeenCalled();
    expect(m.bioEnabled).not.toHaveBeenCalled();
  });

  it("treats an unreadable vault as password protected", async () => {
    m.hasPassword.mockRejectedValue(new Error("unreadable"));
    expect(await takeLockChecks().password).toBe("set");
  });

  it("remembers the Touch ID answer for the next lock screen", async () => {
    m.bioEnabled.mockResolvedValue(true);
    expect(await takeLockChecks().biometric).toBe(true);
    expect(biometricHint()).toBe(true);
    m.bioEnabled.mockResolvedValue(false);
    expect(await takeLockChecks().biometric).toBe(false);
    expect(biometricHint()).toBe(false);
  });
});
