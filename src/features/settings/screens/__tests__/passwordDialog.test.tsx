// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import "src/i18n";

const m = vi.hoisted(() => ({ change: vi.fn(), remove: vi.fn() }));
vi.mock("src/services/wallet/walletBridge", () => ({
  walletBridge: {
    changePassword: (...a: unknown[]) => m.change(...a),
    removePassword: (...a: unknown[]) => m.remove(...a),
  },
}));
vi.mock("src/services/wallet/biometricService", () => ({
  biometricService: { disable: vi.fn(async () => {}) },
}));
vi.mock("src/contexts/useWallet", () => ({ useWallet: () => ({ showMessage: vi.fn() }) }));

import { PasswordDialog } from "src/features/settings/screens/SecurityDialogs";

const settle = () => act(() => new Promise((r) => setTimeout(r, 10)));
const security = { biometric: null, setHasPassword: vi.fn(), setBiometricEnabled: vi.fn() };
const fill = (values: string[]) =>
  document.querySelectorAll("input").forEach((input, i) => {
    fireEvent.change(input, { target: { value: values[i] } });
  });

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Password dialog", () => {
  it("shows the wait in the app's words once the guesses at the current password ran out", async () => {
    m.change.mockRejectedValue("Too many failed attempts. Try again in 30 seconds.");
    render(<PasswordDialog mode="change" security={security as never} onClose={vi.fn()} />);
    fill(["wrong", "new password 9", "new password 9"]);
    fireEvent.submit(document.querySelector("form")!);
    await settle();
    expect(m.change).toHaveBeenCalledWith("wrong", "new password 9");
    expect(screen.getByText("Too many attempts. Try again in 30 seconds.")).toBeTruthy();
    expect(screen.queryByText(/failed attempts/)).toBeNull();
  });

  it("says a wrong current password in the app's words when removing it", async () => {
    m.remove.mockRejectedValue("Incorrect password");
    render(<PasswordDialog mode="remove" security={security as never} onClose={vi.fn()} />);
    fill(["wrong"]);
    fireEvent.submit(document.querySelector("form")!);
    await settle();
    expect(m.remove).toHaveBeenCalledWith("wrong");
    expect(screen.getByText("Incorrect password. Please try again.")).toBeTruthy();
  });
});
