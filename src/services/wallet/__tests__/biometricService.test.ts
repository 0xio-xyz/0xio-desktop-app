import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  invoke: vi.fn(),
  announce: vi.fn(),
  store: new Map<string, unknown>(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: m.invoke }));
vi.mock("src/services/notices/noticeNative", () => ({ announce: m.announce }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({
    get: async (k: string) => m.store.get(k),
    set: async (k: string, v: unknown) => void m.store.set(k, v),
    delete: async (k: string) => void m.store.delete(k),
    save: async () => {},
  })),
}));
vi.mock("src/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  BiometryChangedError,
  BiometryType,
  biometricService,
  biometricUsePassword,
} from "src/services/wallet/biometricService";

const answers = (map: Record<string, unknown>) =>
  m.invoke.mockImplementation(async (cmd: string) => {
    const a = map[cmd];
    if (a instanceof Error) throw a.message;
    return a;
  });
const calls = (cmd: string) => m.invoke.mock.calls.filter(([c]) => c === cmd).map(([, a]) => a);

beforeEach(() => {
  vi.clearAllMocks();
  m.store.clear();
});

describe("Touch ID unlock", () => {
  it("reads the password from its own item with Cancel as the only button by default", async () => {
    answers({ touch_id_read: "vault-pw" });
    await expect(biometricService.unlock()).resolves.toBe("vault-pw");
    expect(calls("touch_id_read")).toEqual([
      { reason: "Unlock 0xio Desktop", cancelTitle: "Cancel" },
    ]);
  });

  it("names the button Use password where a password field takes over", async () => {
    answers({ touch_id_read: "vault-pw" });
    await biometricService.unlock(undefined, biometricUsePassword());
    expect(calls("touch_id_read")[0]).toMatchObject({ cancelTitle: "Use password" });
  });

  it("a cancel is passed on, so the password field shows", async () => {
    answers({ touch_id_read: new Error("userCancel") });
    await expect(biometricService.unlock()).rejects.toBe("userCancel");
  });

  it("changed fingerprints turn Touch ID off with their own error", async () => {
    answers({ touch_id_read: new Error("biometryChanged") });
    await expect(biometricService.unlock()).rejects.toBeInstanceOf(BiometryChangedError);
    expect(m.announce).toHaveBeenCalledWith(
      expect.objectContaining({ title: "notices.touchIdOff" }),
    );
    answers({ touch_id_state: { enabled: false, turnedOff: true } });
    expect(await biometricService.isEnabled()).toBe(false);
    expect(await biometricService.wasTurnedOff()).toBe(true);
  });

  it("Windows Hello runs the same commands and names itself", async () => {
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" });
    try {
      answers({ touch_id_available: true, touch_id_read: "hello-pw" });
      await expect(biometricService.isAvailable()).resolves.toEqual({
        available: true,
        type: BiometryType.Auto,
      });
      await expect(biometricService.unlock("Approve", "Cancel")).resolves.toBe("hello-pw");
      expect(calls("touch_id_read")).toEqual([{ reason: "Approve", cancelTitle: "Cancel" }]);
      answers({ touch_id_read: new Error("biometryChanged") });
      await expect(biometricService.unlock()).rejects.toBeInstanceOf(BiometryChangedError);
      expect(m.announce).toHaveBeenCalledWith(
        expect.objectContaining({ title: "notices.windowsHelloOff" }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("checks availability in Rust", async () => {
    answers({ touch_id_available: true });
    await expect(biometricService.isAvailable()).resolves.toEqual({
      available: true,
      type: BiometryType.TouchID,
    });
    answers({ touch_id_available: false });
    await expect(biometricService.isAvailable()).resolves.toEqual({
      available: false,
      type: BiometryType.None,
    });
    answers({ touch_id_available: new Error("unsupported") });
    await expect(biometricService.isAvailable()).resolves.toEqual({
      available: false,
      type: BiometryType.None,
    });
  });
});

describe("turning Touch ID on and off", () => {
  it("enable asks for a fingerprint with no fallback button, then stores in Rust", async () => {
    answers({ touch_id_prompt: null, touch_id_store: null });
    await biometricService.enable("vault-pw");
    expect(calls("touch_id_prompt")).toEqual([
      { reason: expect.any(String), cancelTitle: "Cancel" },
    ]);
    expect(m.invoke.mock.calls.map(([c]) => c)).toEqual(["touch_id_prompt", "touch_id_store"]);
    expect(calls("touch_id_store")).toEqual([{ password: "vault-pw" }]);
  });

  it("the dev build without keychain access keeps the dev store", async () => {
    answers({
      touch_id_store: new Error("keychainError: -34018"),
      touch_id_read: new Error("keychainError: -34018"),
      touch_id_state: new Error("keychainError: -34018"),
      touch_id_prompt: null,
    });
    await biometricService.enable("dev-pw");
    expect(await biometricService.isEnabled()).toBe(true);
    await expect(biometricService.unlock()).resolves.toBe("dev-pw");
    expect(calls("touch_id_prompt").slice(-1)[0]).toEqual({
      reason: "Unlock 0xio Desktop",
      cancelTitle: "Cancel",
    });
  });

  it("a release build never reads the dev store and deletes what an older build left", async () => {
    vi.stubEnv("DEV", false);
    try {
      answers({
        touch_id_state: { enabled: false, turnedOff: false },
        touch_id_read: new Error("itemNotFound"),
        touch_id_store: new Error("keychainError: -34018"),
        touch_id_prompt: null,
      });
      m.store.set("biometric_pwd", "x");
      m.store.set("biometric_enc_key", "y");
      expect(await biometricService.isEnabled()).toBe(false);
      expect(m.store.size).toBe(0);

      m.store.set("biometric_pwd", "x");
      m.store.set("biometric_enc_key", "y");
      await expect(biometricService.unlock()).rejects.toThrow("No biometric credentials stored");
      expect(calls("touch_id_prompt")).toHaveLength(0);
      expect(m.store.size).toBe(0);

      await expect(biometricService.enable("pw")).rejects.toThrow();
      expect(m.store.size).toBe(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("disable removes both keychain items through Rust and the dev store", async () => {
    answers({ touch_id_clear: null });
    m.store.set("biometric_pwd", "x");
    m.store.set("biometric_enc_key", "y");
    await biometricService.disable();
    expect(calls("touch_id_clear")).toHaveLength(1);
    expect(m.store.size).toBe(0);
  });
});
