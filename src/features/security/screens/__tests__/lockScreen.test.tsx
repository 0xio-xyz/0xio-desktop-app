// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "src/lib/router";
import "src/i18n";

const m = vi.hoisted(() => ({
  hasPassword: vi.fn(),
  needsPassword: vi.fn(),
  setPassword: vi.fn(),
  unlock: vi.fn(),
  status: vi.fn(),
  bioEnabled: vi.fn(),
  bioUnlock: vi.fn(),
  bioDisable: vi.fn(),
  setIsLocked: vi.fn(),
}));
vi.mock("src/services/wallet/walletBridge", () => ({
  walletBridge: {
    hasPassword: (...a: unknown[]) => m.hasPassword(...a),
    needsPassword: (...a: unknown[]) => m.needsPassword(...a),
    setPassword: (...a: unknown[]) => m.setPassword(...a),
    unlock: (...a: unknown[]) => m.unlock(...a),
    unlockStatus: (...a: unknown[]) => m.status(...a),
    reset: vi.fn(),
  },
}));
vi.mock("src/services/wallet/biometricService", () => ({
  BiometryChangedError: class BiometryChangedError extends Error {},
  biometricService: {
    isEnabled: (...a: unknown[]) => m.bioEnabled(...a),
    unlock: (...a: unknown[]) => m.bioUnlock(...a),
    disable: (...a: unknown[]) => m.bioDisable(...a),
  },
}));
vi.mock("src/contexts/useWallet", () => ({
  useWallet: () => ({
    setIsLocked: m.setIsLocked,
    setIsInitialized: vi.fn(),
    setWallets: vi.fn(),
    setActiveWallet: vi.fn(),
  }),
}));
vi.mock("src/features/security/components/LockMascot", () => ({ default: () => null }));
vi.mock("src/services/app/startup", () => ({ shellReady: () => Promise.resolve() }));
vi.mock("src/hooks/app/useTrayUnlockRequest", () => ({ useTrayUnlockRequest: () => {} }));
vi.mock("src/hooks/wallet/useTokenPrice", () => ({
  useTokenPrice: () => ({
    getPrice: () => null,
    priceHistory: [],
    fetchHistoryRange: async () => [],
  }),
}));
vi.mock("src/features/settings/hooks/useAppearance", () => ({
  useAppearance: () => ({ settings: { lockPriceRange: "24h" } }),
}));
vi.mock("src/features/security/services/priceHistoryCache", () => ({
  HISTORY_REFRESH_MS: { "24h": 60_000, "7d": 60_000, "30d": 60_000 },
  cachedHistory: () => [],
  historyIsStale: () => false,
  storeHistory: () => null,
}));

import LockScreen from "src/features/security/screens/LockScreen";

const settle = () => act(() => new Promise((r) => setTimeout(r, 10)));
const show = async () => {
  render(
    <MemoryRouter>
      <LockScreen />
    </MemoryRouter>,
  );
  await settle();
};
const fresh = { attempts_left: 5, next_lockout_seconds: 30, locked_seconds: 0 };

const tryPassword = async (pw: string) => {
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: pw } });
  fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
  await settle();
};

const drawn = { strokes: 0 };
const fakeContext = () =>
  new Proxy(
    { measureText: () => ({ width: 40 }) },
    {
      get: (target, key) =>
        key in target
          ? target[key as keyof typeof target]
          : key === "stroke"
            ? () => drawn.strokes++
            : () => {},
      set: () => true,
    },
  );

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset();
  drawn.strokes = 0;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    () => fakeContext() as unknown as CanvasRenderingContext2D,
  );
  m.hasPassword.mockResolvedValue(true);
  m.bioEnabled.mockResolvedValue(false);
  m.status.mockResolvedValue(fresh);
  m.unlock.mockRejectedValue("Incorrect password");
  m.bioDisable.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Lock screen", () => {
  it("never opens the Touch ID prompt on mount, even with Touch ID on", async () => {
    m.bioEnabled.mockResolvedValue(true);
    await show();
    await settle();
    expect(m.bioUnlock).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /Unlock with Touch ID/ })).toBeTruthy();
  });

  it("opens Touch ID only when tapped", async () => {
    m.bioEnabled.mockResolvedValue(true);
    m.bioUnlock.mockRejectedValue(new Error("cancelled"));
    await show();
    fireEvent.click(screen.getByRole("button", { name: /Unlock with Touch ID/ }));
    await settle();
    expect(m.bioUnlock).toHaveBeenCalledTimes(1);
    expect(m.unlock).not.toHaveBeenCalled();
  });

  it("changed fingerprints turn Touch ID off and leave the password field", async () => {
    const { BiometryChangedError } = await import("src/services/wallet/biometricService");
    m.bioEnabled.mockResolvedValue(true);
    m.bioUnlock.mockRejectedValue(new BiometryChangedError());
    await show();
    fireEvent.click(screen.getByRole("button", { name: /Unlock with Touch ID/ }));
    await settle();
    expect(m.bioUnlock).toHaveBeenCalledWith();
    expect(
      screen.getByText(
        "Touch ID was turned off because your fingerprints changed. Turn it on again.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Unlock with Touch ID/ })).toBeNull();
    expect(screen.getByLabelText("Password")).toBeTruthy();
  });

  it("says how many attempts are left before the lockout", async () => {
    await show();
    m.status.mockResolvedValue({ attempts_left: 4, next_lockout_seconds: 30, locked_seconds: 0 });
    await tryPassword("nope");
    expect(screen.getByText("Incorrect password.")).toBeTruthy();

    m.status.mockResolvedValue({ attempts_left: 2, next_lockout_seconds: 30, locked_seconds: 0 });
    await tryPassword("nope");
    expect(
      screen.getByText("Incorrect password. 2 attempts left before a 30 second lockout."),
    ).toBeTruthy();

    m.status.mockResolvedValue({ attempts_left: 1, next_lockout_seconds: 30, locked_seconds: 0 });
    await tryPassword("nope");
    expect(
      screen.getByText("Incorrect password. 1 attempt left before a 30 second lockout."),
    ).toBeTruthy();
  });

  it("counts the lockout down and holds the button until it ends", async () => {
    await show();
    m.status.mockResolvedValue({ attempts_left: 1, next_lockout_seconds: 60, locked_seconds: 30 });
    await tryPassword("nope");
    expect(screen.getByText("Too many attempts. Try again in 30 seconds.")).toBeTruthy();
    const wait = screen.getByRole("button", { name: "Wait 30s" });
    expect(wait.hasAttribute("disabled")).toBe(true);
    expect((screen.getByLabelText("Password") as HTMLInputElement).disabled).toBe(true);
  });

  it("shows a lockout that is already running when it opens", async () => {
    m.status.mockResolvedValue({ attempts_left: 1, next_lockout_seconds: 60, locked_seconds: 12 });
    await show();
    expect(screen.getByRole("button", { name: "Wait 12s" })).toBeTruthy();
  });

  it("uses text Show and Hide for the password", async () => {
    await show();
    const field = screen.getByLabelText("Password") as HTMLInputElement;
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    expect(field.type).toBe("text");
    expect(screen.getByRole("button", { name: "Hide" })).toBeTruthy();
  });

  it("draws the dial behind the column without taking clicks", async () => {
    await show();
    const canvas = document.querySelector("canvas");
    expect(canvas).toBeTruthy();
    expect(canvas?.parentElement?.className).toContain("pointer-events-none");
    expect(canvas?.parentElement?.getAttribute("aria-hidden")).toBe("true");
    expect(drawn.strokes).toBeGreaterThan(0);
  });

  it("asks the vault at once and unlocks as soon as it opens, never waiting on the dial", async () => {
    m.unlock.mockResolvedValue([{ address: "oct1", is_active: true }]);
    await show();
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
    expect(m.unlock).toHaveBeenCalledWith("secret");
    await act(async () => {
      for (let i = 0; i < 5; i++) await Promise.resolve();
    });
    expect(m.setIsLocked).toHaveBeenCalledWith(false);
  });
});

describe("Lock screen: a vault without a password", () => {
  beforeEach(() => {
    m.hasPassword.mockResolvedValue(false);
    m.setPassword.mockResolvedValue(undefined);
    m.unlock.mockResolvedValue([{ address: "oct1", is_active: true }]);
  });

  it("still opens by itself when it holds only watch wallets", async () => {
    m.needsPassword.mockResolvedValue(false);
    await show();
    expect(m.unlock).toHaveBeenCalledWith("");
    expect(m.setIsLocked).toHaveBeenCalledWith(false);
  });

  it("holding keys, asks for a password before anything opens, then unlocks with it", async () => {
    m.needsPassword.mockResolvedValue(true);
    await show();
    expect(screen.getByText("Create a password")).toBeTruthy();
    expect(m.unlock).not.toHaveBeenCalled();
    expect(m.setIsLocked).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "correct horse 9" } });
    fireEvent.change(screen.getByLabelText("Confirm password"), {
      target: { value: "correct horse 9" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set password" }));
    await settle();

    expect(m.setPassword).toHaveBeenCalledWith("correct horse 9");
    expect(m.unlock).toHaveBeenCalledTimes(1);
    expect(m.unlock).toHaveBeenCalledWith("correct horse 9");
    expect(m.setIsLocked).toHaveBeenCalledWith(false);
  });

  it("stays locked when the password cannot be set", async () => {
    m.needsPassword.mockResolvedValue(true);
    m.setPassword.mockRejectedValue("The wallet file on this computer cannot be read.");
    await show();
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "correct horse 9" } });
    fireEvent.change(screen.getByLabelText("Confirm password"), {
      target: { value: "correct horse 9" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set password" }));
    await settle();
    expect(screen.getByText("The wallet file on this computer cannot be read.")).toBeTruthy();
    expect(m.unlock).not.toHaveBeenCalled();
    expect(m.setIsLocked).not.toHaveBeenCalled();
  });
});
