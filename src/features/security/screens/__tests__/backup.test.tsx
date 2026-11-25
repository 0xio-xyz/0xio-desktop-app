// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "src/lib/router";
import "src/i18n";

const PHRASE = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima".split(
  " ",
);
const KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";

const m = vi.hoisted(() => ({
  hasPassword: vi.fn(),
  exportMnemonic: vi.fn(),
  exportPrivateKey: vi.fn(),
  endReveal: vi.fn(),
  copySecret: vi.fn(),
  bioEnabled: vi.fn(),
  bioUnlock: vi.fn(),
  mark: vi.fn(),
  finishSeal: vi.fn(),
  navigate: vi.fn(),
  toast: vi.fn(),
  clipboardWrite: vi.fn(),
  unlisten: vi.fn(),
  focusChanged: null as null | ((e: { payload: boolean }) => void),
  wallets: [] as Record<string, unknown>[],
  active: {} as Record<string, unknown>,
  locked: false,
}));
vi.mock("src/services/wallet/walletBridge", () => ({
  walletBridge: {
    hasPassword: (...a: unknown[]) => m.hasPassword(...a),
    exportMnemonic: (...a: unknown[]) => m.exportMnemonic(...a),
    exportPrivateKey: (...a: unknown[]) => m.exportPrivateKey(...a),
    endReveal: (...a: unknown[]) => m.endReveal(...a),
    copySecret: (...a: unknown[]) => m.copySecret(...a),
  },
}));
vi.mock("src/services/wallet/biometricService", () => ({
  BiometryChangedError: class BiometryChangedError extends Error {},
  biometricUsePassword: () => "Use password",
  biometricService: {
    isEnabled: (...a: unknown[]) => m.bioEnabled(...a),
    isAvailable: async () => ({ available: true }),
    unlock: (...a: unknown[]) => m.bioUnlock(...a),
  },
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onFocusChanged: async (handler: (e: { payload: boolean }) => void) => {
      m.focusChanged = handler;
      return () => m.unlisten();
    },
  }),
}));
vi.mock("src/shared/layout/TopBar", () => ({ default: () => null }));
vi.mock("src/shared/ui/WalletAvatar", () => ({ default: () => null }));
vi.mock("src/services/notices/activity", () => ({ toast: (...a: unknown[]) => m.toast(...a) }));
vi.mock("src/contexts/useWallet", () => ({
  useWallet: () => ({ activeWallet: m.active, wallets: m.wallets, isLocked: m.locked }),
}));
vi.mock("src/hooks/wallet/useNeedsBackup", async (importOriginal) => ({
  ...(await importOriginal<typeof import("src/hooks/wallet/useNeedsBackup")>()),
  useNeedsBackup: () => ({
    needsBackup: true,
    markBackedUp: (...a: unknown[]) => m.mark(...a),
    finishSeal: (...a: unknown[]) => m.finishSeal(...a),
  }),
}));
vi.mock("src/lib/router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("src/lib/router")>()),
  useNavigate: () => m.navigate,
}));

import BackupScreen from "src/features/security/screens/BackupScreen";

const settle = () => act(() => new Promise((r) => setTimeout(r, 10)));
const tree = (path: string) => (
  <MemoryRouter initialEntries={[path]}>
    <BackupScreen />
  </MemoryRouter>
);
const show = async (path = "/backup") => {
  const view = render(tree(path));
  await settle();
  return view;
};
const hasWords = (text: string | null) => PHRASE.some((w) => text?.includes(w));
const setVisibility = (state: string) =>
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
const button = (name: string) => screen.getByRole("button", { name });
const sheet = () => screen.queryByRole("dialog");
const grid = () => screen.getByTestId("phrase-grid");

beforeEach(() => {
  for (const f of Object.values(m)) (f as { mockReset?: () => void } | null)?.mockReset?.();
  m.focusChanged = null;
  m.hasPassword.mockResolvedValue(true);
  m.bioEnabled.mockResolvedValue(false);
  m.exportMnemonic.mockImplementation(async (_id: string, pw: string) => {
    if (pw !== "right password") throw "Incorrect password";
    return PHRASE;
  });
  m.exportPrivateKey.mockImplementation(async (_id: string, pw: string) => {
    if (pw !== "right password") throw "Incorrect password";
    return KEY;
  });
  m.endReveal.mockResolvedValue(undefined);
  m.copySecret.mockResolvedValue(undefined);
  m.mark.mockResolvedValue(undefined);
  m.finishSeal.mockResolvedValue(undefined);
  m.wallets = [];
  m.active = {
    id: "w1",
    name: "Spending",
    address: "oct1",
    source: "mnemonic",
    needs_backup: true,
  };
  m.locked = false;
  Object.assign(navigator, { clipboard: { writeText: m.clipboardWrite } });
  setVisibility("visible");
});
afterEach(cleanup);

const typePassword = async (value = "right password") => {
  fireEvent.change(screen.getByLabelText("Password"), { target: { value } });
  fireEvent.click(button("Continue"));
  await settle();
};
const open = async (path = "/backup") => {
  const view = await show(path);
  await typePassword();
  return view;
};
const openAndShow = async (path = "/backup") => {
  const view = await open(path);
  fireEvent.click(button("Show"));
  return view;
};

describe("Auth sheet", () => {
  it("asks for the password in a sheet over the page before it reads the phrase", async () => {
    const { container } = await show();
    expect(sheet()?.getAttribute("aria-label")).toBe("Enter your password");
    expect(screen.getByRole("heading", { name: "Recovery phrase" })).toBeTruthy();
    expect(m.exportMnemonic).not.toHaveBeenCalled();
    expect(hasWords(container.textContent)).toBe(false);

    await typePassword("wrong");
    expect(screen.getByText("Incorrect password. Please try again.")).toBeTruthy();
    expect(sheet()).toBeTruthy();
    expect(hasWords(container.textContent)).toBe(false);
  });

  it("says how long to wait once the guesses ran out", async () => {
    m.exportMnemonic.mockRejectedValue("Too many failed attempts. Try again in 30 seconds.");
    await show();
    await typePassword("wrong");
    expect(screen.getByText("Too many attempts. Try again in 30 seconds.")).toBeTruthy();
  });

  it("Cancel returns to where the user was and reads nothing", async () => {
    await show();
    fireEvent.click(button("Cancel"));
    expect(m.navigate).toHaveBeenCalledWith(-1);
    expect(m.exportMnemonic).not.toHaveBeenCalled();
    expect(sheet()).toBeNull();
  });

  it("Escape cancels like Cancel", async () => {
    await show();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(m.navigate).toHaveBeenCalledWith(-1);
  });

  it("starts with Touch ID when it is on and reads with the stored password", async () => {
    m.bioEnabled.mockResolvedValue(true);
    m.bioUnlock.mockResolvedValue("right password");
    const { container } = await show();
    expect(m.bioUnlock).toHaveBeenCalledWith("Show your recovery phrase", "Use password");
    expect(m.exportMnemonic).toHaveBeenCalledWith("w1", "right password");
    expect(sheet()).toBeNull();
    expect(hasWords(container.textContent)).toBe(false);
    fireEvent.click(button("Show"));
    expect(hasWords(grid().textContent)).toBe(true);
  });

  it("falls back to the sheet when Touch ID is closed, with Touch ID one tap away", async () => {
    m.bioEnabled.mockResolvedValue(true);
    m.bioUnlock.mockRejectedValueOnce("userCancel").mockResolvedValue("right password");
    await show();
    expect(sheet()).toBeTruthy();
    expect(m.exportMnemonic).not.toHaveBeenCalled();
    fireEvent.click(button("Use Touch ID"));
    await settle();
    expect(m.exportMnemonic).toHaveBeenCalledWith("w1", "right password");
    expect(sheet()).toBeNull();
  });

  it("shows the sheet with the wait when the Touch ID password is refused", async () => {
    m.bioEnabled.mockResolvedValue(true);
    m.bioUnlock.mockResolvedValue("stale");
    m.exportMnemonic.mockRejectedValue("Too many failed attempts. Try again in 60 seconds.");
    await show();
    expect(sheet()).toBeTruthy();
    expect(screen.getByText("Too many attempts. Try again in 60 seconds.")).toBeTruthy();
  });

  it("opens without a sheet when the vault has no password", async () => {
    m.hasPassword.mockResolvedValue(false);
    m.exportMnemonic.mockResolvedValue(PHRASE);
    const { container } = await show();
    expect(sheet()).toBeNull();
    expect(m.exportMnemonic).toHaveBeenCalledWith("w1", "");
    expect(hasWords(container.textContent)).toBe(false);
    fireEvent.click(button("Show"));
    expect(hasWords(container.textContent)).toBe(true);
  });
});

describe("Secret surface", () => {
  it("lays 12 words out as numbered cells in 4 columns and hides them until Show", async () => {
    const { container } = await open();
    expect(grid().children).toHaveLength(12);
    expect(grid().className).toContain("@3xl:grid-cols-4");
    expect(grid().className).toContain("h-95");
    expect(grid().getAttribute("aria-hidden")).toBe("true");
    expect(hasWords(container.textContent)).toBe(false);

    fireEvent.click(button("Show"));
    expect(grid().getAttribute("aria-hidden")).toBe("false");
    expect([...grid().children].map((c) => c.textContent)).toEqual(
      PHRASE.map((w, i) => `${i + 1}${w}`),
    );
    expect(button("Hide").getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(button("Hide"));
    expect(hasWords(container.textContent)).toBe(false);
    expect(m.endReveal).toHaveBeenCalledTimes(1);
  });

  it("lays 24 words out in 6 columns at the same height and keeps 24 cells once dropped", async () => {
    const long = [...PHRASE, ...PHRASE.map((w) => `${w}x`)];
    m.exportMnemonic.mockResolvedValue(long);
    await openAndShow();
    expect(grid().children).toHaveLength(24);
    expect(grid().className).toContain("@4xl:grid-cols-6");
    expect(grid().className).toContain("h-95");
    expect(grid().textContent).toContain("24limax");
    fireEvent.click(button("Hide"));
    expect(grid().children).toHaveLength(24);
  });

  it("shows the private key whole in two even lines at the same height", async () => {
    const { container } = await open("/backup?wallet=w1&kind=key");
    expect(screen.getByRole("heading", { name: "Private key" })).toBeTruthy();
    expect(m.exportPrivateKey).toHaveBeenCalledWith("w1", "right password");
    expect(m.exportMnemonic).not.toHaveBeenCalled();
    const box = screen.getByTestId("private-key");
    expect(box.className).toContain("h-95");
    expect(container.textContent).not.toContain(KEY.slice(0, 8));

    fireEvent.click(button("Show"));
    const lines = [...box.children].map((c) => c.textContent ?? "");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toHaveLength(lines[1].length);
    expect(lines.join("")).toBe(KEY);
    expect(screen.getByText(/Anyone with this key can/)).toBeTruthy();
  });

  it("carries the one risk line and nothing else to read", async () => {
    const { container } = await open();
    expect(screen.getByText(/Anyone with this phrase can/).textContent).toBe(
      "Anyone with this phrase can take your funds.",
    );
    expect(container.textContent).not.toMatch(/Write down|in order|screen recording/i);
    expect(container.querySelector("canvas, [data-testid='qr']")).toBeNull();
  });

  it("asks for the password again before it shows dropped words", async () => {
    await openAndShow();
    fireEvent.click(button("Hide"));
    fireEvent.click(button("Show"));
    await settle();
    expect(sheet()).toBeTruthy();
    expect(m.exportMnemonic).toHaveBeenCalledTimes(1);
    fireEvent.click(button("Cancel"));
    expect(sheet()).toBeNull();
    expect(m.navigate).not.toHaveBeenCalled();

    fireEvent.click(button("Show"));
    await settle();
    await typePassword();
    expect(hasWords(grid().textContent)).toBe(true);
  });
});

describe("Hiding", () => {
  it("hides and drops the words when the window loses focus", async () => {
    const { container } = await openAndShow();
    expect(hasWords(container.textContent)).toBe(true);
    fireEvent.blur(window);
    expect(hasWords(container.textContent)).toBe(false);
    expect(m.endReveal).toHaveBeenCalledTimes(1);
    expect(button("Show")).toBeTruthy();
  });

  it("hides on the window's own focus event, which also covers hide and minimise", async () => {
    const { container } = await openAndShow();
    act(() => m.focusChanged?.({ payload: true }));
    expect(hasWords(container.textContent)).toBe(true);
    act(() => m.focusChanged?.({ payload: false }));
    expect(hasWords(container.textContent)).toBe(false);
    expect(m.endReveal).toHaveBeenCalledTimes(1);
  });

  it("hides when the page is hidden", async () => {
    const { container } = await openAndShow();
    setVisibility("hidden");
    fireEvent(document, new Event("visibilitychange"));
    expect(hasWords(container.textContent)).toBe(false);
    expect(m.endReveal).toHaveBeenCalledTimes(1);
  });

  it("a blur while Touch ID is up drops nothing, and the watch runs once the words show", async () => {
    m.bioEnabled.mockResolvedValue(true);
    m.bioUnlock.mockResolvedValueOnce("right password");
    const { container } = await show();
    fireEvent.click(button("Show"));
    fireEvent.click(button("Hide"));
    m.endReveal.mockClear();

    let finish: (pw: string) => void = () => {};
    m.bioUnlock.mockReturnValueOnce(new Promise<string>((r) => (finish = r)));
    fireEvent.click(button("Show"));
    await settle();
    fireEvent.blur(window);
    act(() => m.focusChanged?.({ payload: false }));
    await act(async () => finish("right password"));
    await settle();
    expect(hasWords(container.textContent)).toBe(true);
    expect(m.endReveal).not.toHaveBeenCalled();

    fireEvent.blur(window);
    expect(hasWords(container.textContent)).toBe(false);
    expect(m.endReveal).toHaveBeenCalledTimes(1);
  });

  it("does not show words that arrive while the page is hidden", async () => {
    const { container } = await show();
    setVisibility("hidden");
    await typePassword();
    setVisibility("visible");
    expect(hasWords(container.textContent)).toBe(false);
    fireEvent.click(button("Show"));
    await settle();
    expect(sheet()).toBeTruthy();
  });

  it("drops the words on lock and ends the reveal and the window watch on leaving", async () => {
    const view = await openAndShow();
    m.locked = true;
    view.rerender(tree("/backup"));
    expect(hasWords(view.container.textContent)).toBe(false);
    m.endReveal.mockClear();
    view.unmount();
    expect(m.endReveal).toHaveBeenCalledTimes(1);
    expect(m.unlisten).toHaveBeenCalledTimes(1);
  });
});

describe("Copy", () => {
  it("copies through Rust, never the web clipboard, and reads Copied for a moment", async () => {
    await openAndShow();
    fireEvent.click(button("Copy"));
    await settle();
    expect(m.copySecret).toHaveBeenCalledWith("w1", "phrase");
    expect(m.clipboardWrite).not.toHaveBeenCalled();
    expect(button("Copied").className).toContain("w-28");
  });

  it("copies without showing", async () => {
    const { container } = await open();
    fireEvent.click(button("Copy"));
    await settle();
    expect(m.copySecret).toHaveBeenCalledWith("w1", "phrase");
    expect(hasWords(container.textContent)).toBe(false);
    expect(button("I wrote them down").hasAttribute("disabled")).toBe(true);
  });

  it("asks for the password before it copies dropped words", async () => {
    const { container } = await openAndShow();
    fireEvent.click(button("Hide"));
    fireEvent.click(button("Copy"));
    await settle();
    expect(m.copySecret).not.toHaveBeenCalled();
    await typePassword();
    expect(m.copySecret).toHaveBeenCalledWith("w1", "phrase");
    expect(hasWords(container.textContent)).toBe(false);
  });

  it("drops the words when Rust refuses the copy", async () => {
    m.copySecret.mockRejectedValue("Authenticate again to copy");
    const { container } = await openAndShow();
    fireEvent.click(button("Copy"));
    await settle();
    expect(hasWords(container.textContent)).toBe(false);
    expect(screen.queryByRole("button", { name: "Copied" })).toBeNull();
  });
});

describe("Closing button", () => {
  it("first backup: I wrote them down waits for Show, then marks the wallet and says Backed up", async () => {
    await open();
    const done = button("I wrote them down");
    expect(done.hasAttribute("disabled")).toBe(true);
    expect(done.className).toContain("@4xl:w-53");
    fireEvent.click(done);
    expect(m.mark).not.toHaveBeenCalled();

    fireEvent.click(button("Show"));
    fireEvent.click(button("I wrote them down"));
    await settle();
    expect(m.mark).toHaveBeenCalledWith("w1");
    expect(m.toast).toHaveBeenCalledWith({ title: "backup.backedUp", tone: "success" });
    expect(m.navigate).toHaveBeenCalledWith("/", { replace: true });
  });

  it("says so in its slot and stays when the backup state cannot be saved", async () => {
    m.mark.mockRejectedValue("disk");
    await openAndShow();
    fireEvent.click(button("I wrote them down"));
    await settle();
    expect(screen.getByRole("alert").textContent).toBe("Could not save. Try again.");
    expect(m.toast).not.toHaveBeenCalled();
    expect(button("I wrote them down").hasAttribute("disabled")).toBe(false);
  });

  it("a wallet imported by key is backed up: its key is a plain view closed with Done", async () => {
    m.active = { id: "k1", name: "Cold", address: "oct2", source: "private_key" };
    await open();
    expect(screen.getByRole("heading", { name: "Private key" })).toBeTruthy();
    expect(m.exportPrivateKey).toHaveBeenCalledWith("k1", "right password");
    expect(screen.queryByRole("button", { name: "I wrote it down" })).toBeNull();
    fireEvent.click(button("Show"));
    expect(button("Copy")).toBeTruthy();
    fireEvent.click(button("Done"));
    expect(m.mark).not.toHaveBeenCalled();
    expect(m.toast).not.toHaveBeenCalled();
    expect(m.navigate).toHaveBeenCalledWith(-1);
  });

  it("a key wallet still pending backup closes with I wrote it down", async () => {
    m.active = {
      id: "k1",
      name: "Cold",
      address: "oct2",
      source: "private_key",
      needs_backup: true,
    };
    await open();
    expect(screen.getByRole("heading", { name: "Private key" })).toBeTruthy();
    expect(m.exportPrivateKey).toHaveBeenCalledWith("k1", "right password");
    expect(m.exportMnemonic).not.toHaveBeenCalled();
    expect(button("I wrote it down").hasAttribute("disabled")).toBe(true);

    fireEvent.click(button("Show"));
    fireEvent.click(button("I wrote it down"));
    await settle();
    expect(m.mark).toHaveBeenCalledWith("k1");
    expect(m.toast).toHaveBeenCalledWith({ title: "backup.backedUp", tone: "success" });
  });

  it("a key wallet never offers a phrase, whatever the link asks for", async () => {
    m.active = { id: "k1", name: "Cold", address: "oct2", source: "private_key" };
    await open("/backup?wallet=k1&kind=phrase");
    expect(screen.getByRole("heading", { name: "Private key" })).toBeTruthy();
    expect(m.exportMnemonic).not.toHaveBeenCalled();
  });

  it("re-viewing closes with a plain Done that goes back", async () => {
    m.active = { ...m.active, needs_backup: false };
    await open();
    expect(screen.queryByRole("button", { name: "I wrote them down" })).toBeNull();
    fireEvent.click(button("Done"));
    expect(m.mark).not.toHaveBeenCalled();
    expect(m.toast).not.toHaveBeenCalled();
    expect(m.navigate).toHaveBeenCalledWith(-1);
  });

  it("the key of a phrase wallet is a plain view even while its backup is due", async () => {
    await open("/backup?kind=key");
    expect(button("Done")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "I wrote it down" })).toBeNull();
  });

  it("backs up the wallet named in the link, not only the open one", async () => {
    m.wallets = [
      m.active,
      { id: "w2", name: "Savings", address: "oct3", source: "mnemonic", needs_backup: true },
    ];
    await openAndShow("/backup?wallet=w2");
    expect(m.exportMnemonic).toHaveBeenCalledWith("w2", "right password");
    expect(screen.getByText("Savings")).toBeTruthy();
    fireEvent.click(button("I wrote them down"));
    await settle();
    expect(m.mark).toHaveBeenCalledWith("w2");
  });

  it("opens nothing for a wallet with no key to show", async () => {
    m.active = {
      id: "v1",
      name: "Gifts",
      address: "oct4",
      source: "address",
      wallet_type: "watch",
    };
    await show();
    expect(screen.queryByTestId("phrase-grid")).toBeNull();
    expect(sheet()).toBeNull();
    expect(m.hasPassword).not.toHaveBeenCalled();

    cleanup();
    m.active = { id: "s1", name: "Sealed", address: "oct5", source: "mnemonic", exportable: false };
    await show();
    expect(screen.queryByTestId("phrase-grid")).toBeNull();
    expect(m.exportMnemonic).not.toHaveBeenCalled();
  });
});

describe("Sealed wallet waiting for its seal", () => {
  beforeEach(() => {
    m.wallets = [
      m.active,
      { id: "w9", name: "Vault", address: "oct9", source: "mnemonic", seal_pending: true },
    ];
  });

  it("shows its phrase this one time with Copy and no way back, then seals it", async () => {
    await show("/backup");
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    fireEvent.click(button("Cancel"));
    expect(m.navigate).not.toHaveBeenCalled();

    fireEvent.click(button("Show"));
    await settle();
    await typePassword();
    expect(m.exportMnemonic).toHaveBeenCalledWith("w9", "right password");
    expect(screen.getByText(/only time/).parentElement?.textContent).toBe(
      "This is the only time this computer shows these words.",
    );
    expect(button("Copy").hasAttribute("disabled")).toBe(false);
    fireEvent.click(button("I wrote them down"));
    await settle();
    expect(m.finishSeal).toHaveBeenCalledWith("w9");
    expect(m.mark).not.toHaveBeenCalled();
    expect(m.navigate).toHaveBeenCalledWith("/", { replace: true });
  });

  it("does not seal before the words were shown", async () => {
    await open("/backup");
    const done = button("I wrote them down");
    expect(done.hasAttribute("disabled")).toBe(true);
    fireEvent.click(done);
    expect(m.finishSeal).not.toHaveBeenCalled();
  });
});
