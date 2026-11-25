// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import i18n, { switchLanguage } from "src/i18n";

const m = vi.hoisted(() => ({
  enabled: vi.fn(),
  available: vi.fn(),
  unlock: vi.fn(),
}));
vi.mock("src/services/wallet/biometricService", () => ({
  BiometryChangedError: class BiometryChangedError extends Error {},
  biometricUsePassword: () => "Use password",
  biometricService: {
    isEnabled: (...a: unknown[]) => m.enabled(...a),
    isAvailable: (...a: unknown[]) => m.available(...a),
    unlock: (...a: unknown[]) => m.unlock(...a),
  },
}));

import PasswordPrompt from "src/features/wallet/components/PasswordPrompt";

const settle = () => act(() => new Promise((r) => setTimeout(r, 10)));
const button = (name: string) => screen.getByRole("button", { name });

beforeEach(() => {
  m.enabled.mockReset().mockResolvedValue(false);
  m.available.mockReset().mockResolvedValue({ available: true });
  m.unlock.mockReset();
});
afterEach(async () => {
  cleanup();
  await i18n.changeLanguage("en");
});

describe("Password prompt", () => {
  it("is the centred sheet with Cancel and Continue and hands back the typed password", async () => {
    const onSubmit = vi.fn();
    render(<PasswordPrompt isOpen onSubmit={onSubmit} onCancel={vi.fn()} />);
    await settle();
    const sheet = screen.getByRole("dialog");
    expect(sheet.getAttribute("aria-label")).toBe("Enter your password");
    expect(sheet.getAttribute("aria-modal")).toBe("true");
    expect(document.body.textContent).not.toMatch(/Unlock|Enter Password|instead/);
    expect(button("Continue").hasAttribute("disabled")).toBe(true);
    expect(screen.queryByRole("button", { name: "Use Touch ID" })).toBeNull();

    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "pw 12345" } });
    fireEvent.click(button("Continue"));
    expect(onSubmit).toHaveBeenCalledWith("pw 12345");
  });

  it("Cancel, Escape and a click outside all cancel", async () => {
    const onCancel = vi.fn();
    render(<PasswordPrompt isOpen onSubmit={vi.fn()} onCancel={onCancel} />);
    await settle();
    fireEvent.click(button("Cancel"));
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(screen.getByRole("dialog").previousElementSibling!);
    expect(onCancel).toHaveBeenCalledTimes(3);
  });

  it("holds still while the password is checked", async () => {
    const onCancel = vi.fn();
    const view = render(<PasswordPrompt isOpen onSubmit={vi.fn()} onCancel={onCancel} />);
    await settle();
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "pw 12345" } });
    view.rerender(<PasswordPrompt isOpen busy onSubmit={vi.fn()} onCancel={onCancel} />);
    expect(button("Continue").hasAttribute("disabled")).toBe(true);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("shows the caller's error until the password is edited", async () => {
    const view = render(
      <PasswordPrompt isOpen error="Incorrect password." onSubmit={vi.fn()} onCancel={vi.fn()} />,
    );
    await settle();
    expect(screen.getByRole("alert").textContent).toBe("Incorrect password.");
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "p" } });
    expect(screen.getByRole("alert").textContent).toBe("");
    view.unmount();
  });

  it("starts with Touch ID when it is on and stays out of the way of the system panel", async () => {
    m.enabled.mockResolvedValue(true);
    m.unlock.mockResolvedValue("stored password");
    const onSubmit = vi.fn();
    const view = render(
      <PasswordPrompt
        isOpen
        reason="Show your private key"
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );
    await settle();
    expect(m.unlock).toHaveBeenCalledWith("Show your private key", "Use password");
    expect(onSubmit).toHaveBeenCalledWith("stored password");
    expect(screen.queryByRole("dialog")).toBeNull();

    view.rerender(
      <PasswordPrompt
        isOpen
        error="Too many attempts. Try again in 30 seconds."
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByRole("alert").textContent).toBe(
      "Too many attempts. Try again in 30 seconds.",
    );
  });

  it("falls back to the password when Touch ID is closed and offers it again", async () => {
    m.enabled.mockResolvedValue(true);
    m.unlock.mockRejectedValueOnce("userCancel").mockResolvedValue("stored password");
    const onSubmit = vi.fn();
    render(<PasswordPrompt isOpen onSubmit={onSubmit} onCancel={vi.fn()} />);
    await settle();
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.click(button("Use Touch ID"));
    await settle();
    expect(onSubmit).toHaveBeenCalledWith("stored password");
  });

  it("drops the Touch ID offer once the fingerprints changed", async () => {
    const { BiometryChangedError } = await import("src/services/wallet/biometricService");
    m.enabled.mockResolvedValue(true);
    m.unlock.mockRejectedValue(new BiometryChangedError());
    render(<PasswordPrompt isOpen onSubmit={vi.fn()} onCancel={vi.fn()} />);
    await settle();
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Use Touch ID" })).toBeNull();
  });

  it("renders nothing while closed", async () => {
    render(<PasswordPrompt isOpen={false} onSubmit={vi.fn()} onCancel={vi.fn()} />);
    await settle();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(m.enabled).not.toHaveBeenCalled();
  });

  it.each([
    ["id", "Masukkan kata sandi Anda", "Batal", "Lanjutkan"],
    ["ja", "パスワードを入力", "キャンセル", "続ける"],
    ["ko", "비밀번호 입력", "취소", "계속"],
    ["zh", "输入密码", "取消", "继续"],
  ])("speaks %s", async (lang, title, cancel, submit) => {
    await switchLanguage(lang);
    render(<PasswordPrompt isOpen onSubmit={vi.fn()} onCancel={vi.fn()} />);
    await settle();
    expect(screen.getByRole("dialog").getAttribute("aria-label")).toBe(title);
    expect(button(cancel)).toBeTruthy();
    expect(button(submit)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/Password|Cancel|Unlock|Continue/);
  });
});
