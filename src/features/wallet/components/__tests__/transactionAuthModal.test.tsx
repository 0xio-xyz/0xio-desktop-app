// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import "src/i18n";

const m = vi.hoisted(() => ({
  bioUnlock: vi.fn(),
}));
vi.mock("src/services/wallet/walletBridge", () => ({
  walletBridge: { hasPassword: async () => true, unlock: vi.fn() },
}));
vi.mock("src/services/wallet/biometricService", () => ({
  BiometryChangedError: class BiometryChangedError extends Error {},
  biometricUsePassword: () => "Use password",
  biometricService: {
    isEnabled: async () => true,
    isAvailable: async () => ({ available: true, type: 1 }),
    unlock: (...a: unknown[]) => m.bioUnlock(...a),
  },
}));

import TransactionAuthModal from "src/features/wallet/components/TransactionAuthModal";

const settle = () => act(() => new Promise((r) => setTimeout(r, 10)));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("transaction auth", () => {
  it("starts Touch ID with Use password as its only button and approves on a fingerprint", async () => {
    m.bioUnlock.mockResolvedValue("pw");
    const onResult = vi.fn();
    render(<TransactionAuthModal isOpen onResult={onResult} />);
    await settle();
    expect(m.bioUnlock).toHaveBeenCalledWith(undefined, "Use password");
    expect(onResult).toHaveBeenCalledWith(true);
  });

  it("Use password leaves the password field", async () => {
    m.bioUnlock.mockRejectedValue("userCancel");
    const onResult = vi.fn();
    render(<TransactionAuthModal isOpen onResult={onResult} />);
    await settle();
    expect(onResult).not.toHaveBeenCalled();
    expect(screen.getByPlaceholderText(/password/i)).toBeTruthy();
    expect(screen.getByText(/Use Touch ID/)).toBeTruthy();
  });

  it("changed fingerprints hide Touch ID and keep the password field", async () => {
    const { BiometryChangedError } = await import("src/services/wallet/biometricService");
    m.bioUnlock.mockRejectedValue(new BiometryChangedError());
    render(<TransactionAuthModal isOpen onResult={vi.fn()} />);
    await settle();
    expect(screen.queryByText(/Use Touch ID/)).toBeNull();
    expect(screen.getByPlaceholderText(/password/i)).toBeTruthy();
  });
});
