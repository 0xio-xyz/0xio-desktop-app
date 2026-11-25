// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "src/lib/router";
import { QueryClient, QueryClientProvider } from "src/lib/query";
import "src/i18n";

const PHRASE = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima".split(
  " ",
);
const MAIN = {
  id: "w1",
  name: "Wallet 1",
  address: `oct${"A".repeat(44)}`,
  wallet_type: "hd",
  is_active: true,
  created_at: 0,
  source: "mnemonic",
  exportable: true,
};
const PUBLIC_KEY = "cHVibGljIGtleSBvZiB0aGUgcGlja2VkIHdhbGxldCEhISE=";
const KEY_ONLY = {
  ...MAIN,
  id: "k1",
  name: "Cold",
  address: `oct${"C".repeat(44)}`,
  wallet_type: "imported",
  is_active: false,
  source: "private_key",
  needs_backup: false,
};
const NEW = {
  ...MAIN,
  id: "w2",
  name: "Wallet 2",
  address: `oct${"B".repeat(44)}`,
  needs_backup: true,
  seal_pending: false,
};

const m = vi.hoisted(() => ({
  createAdditional: vi.fn(),
  exportMnemonic: vi.fn(),
  exportPrivateKey: vi.fn(),
  hasPassword: vi.fn(),
  setPassword: vi.fn(),
  importPrivateKey: vi.fn(),
  verifyPassword: vi.fn(),
  deleteWallet: vi.fn(),
  getPublicKey: vi.fn(),
  clipboardWrite: vi.fn(),
  wallets: [] as Record<string, unknown>[],
  refresh: vi.fn(),
  navigate: vi.fn(),
  showMessage: vi.fn(),
}));
vi.mock("src/services/wallet/walletBridge", () => ({
  walletBridge: {
    createAdditional: (...a: unknown[]) => m.createAdditional(...a),
    exportMnemonic: (...a: unknown[]) => m.exportMnemonic(...a),
    exportPrivateKey: (...a: unknown[]) => m.exportPrivateKey(...a),
    hasPassword: (...a: unknown[]) => m.hasPassword(...a),
    setPassword: (...a: unknown[]) => m.setPassword(...a),
    importPrivateKey: (...a: unknown[]) => m.importPrivateKey(...a),
    verifyPassword: (...a: unknown[]) => m.verifyPassword(...a),
    delete: (...a: unknown[]) => m.deleteWallet(...a),
    getPublicKey: (...a: unknown[]) => m.getPublicKey(...a),
  },
}));
vi.mock("src/services/pvac/pvacBridge", () => ({ pvacBridge: { destroy: vi.fn() } }));
vi.mock("src/shared/ui/WalletAvatar", () => ({ default: () => null }));
vi.mock("src/services/wallet/biometricService", () => ({
  BiometryChangedError: class BiometryChangedError extends Error {},
  biometricUsePassword: () => "Use password",
  biometricService: {
    isEnabled: async () => false,
    isAvailable: async () => ({ available: false }),
  },
}));
vi.mock("src/contexts/useWallet", () => ({
  useWallet: () => ({
    wallets: m.wallets,
    refreshWallets: m.refresh,
    showMessage: m.showMessage,
    setIsInitialized: vi.fn(),
    setIsLocked: vi.fn(),
    setActiveWallet: vi.fn(),
    setWallets: vi.fn(),
  }),
}));
vi.mock("src/lib/router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("src/lib/router")>()),
  useNavigate: () => m.navigate,
}));

import WalletListScreen from "src/features/wallet/screens/WalletListScreen";

const settle = () => act(() => new Promise((r) => setTimeout(r, 10)));
const show = async () => {
  const view = render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <WalletListScreen />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await settle();
  return view;
};

beforeEach(() => {
  for (const f of Object.values(m)) if (typeof f === "function") f.mockReset();
  m.wallets = [MAIN];
  m.getPublicKey.mockResolvedValue(PUBLIC_KEY);
  m.clipboardWrite.mockResolvedValue(undefined);
  Object.assign(navigator, { clipboard: { writeText: m.clipboardWrite } });
  m.hasPassword.mockResolvedValue(true);
  m.createAdditional.mockResolvedValue(NEW);
  m.exportMnemonic.mockResolvedValue(PHRASE);
  m.exportPrivateKey.mockResolvedValue("c2VjcmV0");
  m.setPassword.mockResolvedValue(undefined);
  m.importPrivateKey.mockResolvedValue({ ...NEW, source: "private_key", needs_backup: false });
});
afterEach(cleanup);

describe("Wallets: new wallet", () => {
  it("creates like onboarding: no phrase or key shown, Back up waits on Home", async () => {
    const { container } = await show();
    fireEvent.click(screen.getByRole("button", { name: "Add wallet" }));
    fireEvent.click(screen.getByRole("button", { name: /Create wallet/ }));
    fireEvent.change(await screen.findByPlaceholderText("Password"), {
      target: { value: "pw 12345" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await settle();

    expect(m.createAdditional).toHaveBeenCalledWith("pw 12345");
    expect(m.exportMnemonic).not.toHaveBeenCalled();
    expect(m.exportPrivateKey).not.toHaveBeenCalled();
    const text = container.textContent ?? "";
    expect(PHRASE.some((w) => text.includes(w))).toBe(false);
    expect(text).not.toContain("c2VjcmV0");
    expect(screen.queryByRole("dialog")).toBeNull();

    const calls = m.refresh.mock.calls;
    const list = calls[calls.length - 1]?.[0] as Array<Record<string, unknown>>;
    expect(list.find((w) => w.id === "w2")).toMatchObject({ needs_backup: true, is_active: true });
    expect(list.find((w) => w.id === "w1")).toMatchObject({ is_active: false });
    expect(m.navigate).toHaveBeenCalledWith("/");
  });

  it("sends a wallet made under the seal straight to its one showing", async () => {
    m.createAdditional.mockResolvedValue({ ...NEW, seal_pending: true });
    await show();
    fireEvent.click(screen.getByRole("button", { name: "Add wallet" }));
    fireEvent.click(screen.getByRole("button", { name: /Create wallet/ }));
    fireEvent.change(await screen.findByPlaceholderText("Password"), {
      target: { value: "pw 12345" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await settle();
    expect(m.navigate).toHaveBeenCalledWith("/backup");
  });

  it("names the two entries Recovery phrase and Private key and opens the one surface", async () => {
    const { container } = await show();
    fireEvent.click(screen.getByRole("button", { name: "Wallet options" }));
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual([
      "Recovery phrase",
      "Private key",
      "Delete wallet",
    ]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Recovery phrase" }));
    expect(m.navigate).toHaveBeenCalledWith("/backup?wallet=w1&kind=phrase");
    expect(screen.queryByRole("menu")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Wallet options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Private key" }));
    expect(m.navigate).toHaveBeenCalledWith("/backup?wallet=w1&kind=key");

    fireEvent.click(screen.getByRole("button", { name: "Recovery phrase" }));
    fireEvent.click(screen.getByRole("button", { name: "Private key" }));
    expect(m.navigate).toHaveBeenCalledTimes(4);
    expect(container.textContent).not.toMatch(/Key info|Export/);
    expect(m.exportMnemonic).not.toHaveBeenCalled();
    expect(m.exportPrivateKey).not.toHaveBeenCalled();
  });

  it("closes the row menu on Escape and draws it without an outline", async () => {
    await show();
    fireEvent.click(screen.getByRole("button", { name: "Wallet options" }));
    expect(screen.getByRole("menu").className).not.toMatch(/border|outline|ring/);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("a wallet imported by key offers only Private key and starts backed up", async () => {
    m.wallets = [KEY_ONLY];
    await show();
    fireEvent.click(screen.getByRole("button", { name: "Wallet options" }));
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual([
      "Private key",
      "Delete wallet",
    ]);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("button", { name: "Recovery phrase" })).toBeNull();
    expect(screen.getByText("Backed up")).toBeTruthy();
    expect(screen.queryByText("Not backed up")).toBeNull();
    expect(screen.queryByRole("button", { name: "Back up" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Private key" }));
    expect(m.navigate).toHaveBeenCalledWith("/backup?wallet=k1&kind=key");
  });

  it("imports a key as backed up and says a wrong password in the app's words", async () => {
    await show();
    fireEvent.click(screen.getByRole("button", { name: "Add wallet" }));
    fireEvent.click(screen.getByRole("button", { name: /Import wallet/ }));
    fireEvent.change(screen.getByPlaceholderText(/private key/i), {
      target: { value: "c2VjcmV0" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await settle();
    const guess = async (value: string) => {
      fireEvent.change(screen.getByPlaceholderText("Password"), { target: { value } });
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
      await settle();
    };

    m.importPrivateKey.mockRejectedValueOnce("Incorrect password");
    await guess("wrong");
    expect(screen.getByText("Incorrect password. Please try again.")).toBeTruthy();
    m.importPrivateKey.mockRejectedValueOnce("Too many failed attempts. Try again in 30 seconds.");
    await guess("wrong again");
    expect(screen.getByText("Too many attempts. Try again in 30 seconds.")).toBeTruthy();
    expect(screen.queryByText(/failed attempts/)).toBeNull();
    expect(m.refresh).not.toHaveBeenCalled();

    await guess("pw 12345");
    expect(m.importPrivateKey).toHaveBeenCalledTimes(3);
    const calls = m.refresh.mock.calls;
    const list = calls[calls.length - 1]?.[0] as Array<Record<string, unknown>>;
    expect(list.find((w) => w.id === "w2")).toMatchObject({ needs_backup: false, is_active: true });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a key wallet still pending backup keeps Not backed up and Back up", async () => {
    m.wallets = [{ ...KEY_ONLY, needs_backup: true }];
    await show();
    fireEvent.click(screen.getByRole("button", { name: "Wallet options" }));
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual([
      "Private key",
      "Delete wallet",
    ]);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("button", { name: "Recovery phrase" })).toBeNull();
    expect(screen.getByText("Not backed up")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back up" }));
    expect(m.navigate).toHaveBeenCalledWith("/backup?wallet=k1");
  });

  it("offers neither entry for a watch only or sealed wallet", async () => {
    m.wallets = [
      { ...MAIN, exportable: false },
      { ...MAIN, id: "v1", is_active: false, wallet_type: "watch", source: "address" },
    ];
    await show();
    for (const options of screen.getAllByRole("button", { name: "Wallet options" })) {
      fireEvent.click(options);
      expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Delete wallet"]);
      fireEvent.keyDown(document, { key: "Escape" });
    }
    expect(screen.queryByRole("button", { name: "Private key" })).toBeNull();
  });

  it("keeps the address and the public key in the wallet's details, each with Copy", async () => {
    await show();
    expect(m.getPublicKey).toHaveBeenCalledWith("w1");
    expect(screen.getByText(MAIN.address)).toBeTruthy();
    expect(screen.getByText(PUBLIC_KEY)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Copy address" }));
    await settle();
    expect(m.clipboardWrite).toHaveBeenCalledWith(MAIN.address);
    expect(screen.getByRole("button", { name: "Copy address" }).textContent).toBe("Copied");
    fireEvent.click(screen.getByRole("button", { name: "Copy public key" }));
    await settle();
    expect(m.clipboardWrite).toHaveBeenCalledWith(PUBLIC_KEY);
    expect(m.showMessage).not.toHaveBeenCalled();
  });

  it("shows a watch only wallet's address and asks for no public key", async () => {
    m.wallets = [{ ...MAIN, wallet_type: "watch", source: "address" }];
    await show();
    expect(screen.getByText(MAIN.address)).toBeTruthy();
    expect(screen.queryByText("Public key")).toBeNull();
    expect(m.getPublicKey).not.toHaveBeenCalled();
  });
});

describe("Wallets: a vault without a password", () => {
  const setFirstPassword = async (pw: string, again = pw) => {
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: pw } });
    fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: again } });
    fireEvent.click(screen.getByRole("button", { name: "Set password" }));
    await settle();
  };

  beforeEach(() => m.hasPassword.mockResolvedValue(false));

  it("asks for a password before it creates a wallet, then seals it under that password", async () => {
    await show();
    fireEvent.click(screen.getByRole("button", { name: "Add wallet" }));
    fireEvent.click(screen.getByRole("button", { name: /Create wallet/ }));
    expect(screen.getByText("Create a password")).toBeTruthy();
    expect(m.createAdditional).not.toHaveBeenCalled();

    await setFirstPassword("correct horse 9");
    expect(m.setPassword).toHaveBeenCalledWith("correct horse 9");
    expect(m.createAdditional).toHaveBeenCalledWith("correct horse 9");
    expect(m.setPassword.mock.invocationCallOrder[0]).toBeLessThan(
      m.createAdditional.mock.invocationCallOrder[0],
    );
  });

  it("asks for a password before it imports a key", async () => {
    await show();
    fireEvent.click(screen.getByRole("button", { name: "Add wallet" }));
    fireEvent.click(screen.getByRole("button", { name: /Import wallet/ }));
    fireEvent.change(screen.getByPlaceholderText(/private key/i), {
      target: { value: "c2VjcmV0" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(m.importPrivateKey).not.toHaveBeenCalled();

    await setFirstPassword("correct horse 9");
    expect(m.importPrivateKey).toHaveBeenCalledWith("c2VjcmV0", "correct horse 9");
  });

  it("never adds a key when the password is short, does not match, or fails to set", async () => {
    await show();
    fireEvent.click(screen.getByRole("button", { name: "Add wallet" }));
    fireEvent.click(screen.getByRole("button", { name: /Create wallet/ }));
    await setFirstPassword("short");
    await setFirstPassword("correct horse 9", "correct horse 8");
    expect(screen.getByText("Passwords do not match")).toBeTruthy();
    expect(m.setPassword).not.toHaveBeenCalled();

    m.setPassword.mockRejectedValue("Incorrect password");
    await setFirstPassword("correct horse 9");
    expect(screen.getByText("Incorrect password")).toBeTruthy();
    expect(m.createAdditional).not.toHaveBeenCalled();
  });
});

describe("Wallets: delete", () => {
  const askDelete = async () => {
    await show();
    fireEvent.click(screen.getByRole("button", { name: "Wallet options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete wallet" }));
    fireEvent.click(screen.getByRole("button", { name: /^Delete$/ }));
    await settle();
  };
  const guess = async (value: string) => {
    fireEvent.change(screen.getByPlaceholderText("Password"), { target: { value } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await settle();
  };

  it("checks the password with the verify-only command, never by reading the key", async () => {
    m.verifyPassword.mockResolvedValue(undefined);
    m.deleteWallet.mockResolvedValue([NEW]);
    await askDelete();
    expect(m.deleteWallet).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog").getAttribute("aria-label")).toBe("Delete wallet");
    expect(screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(true);
    fireEvent.submit(screen.getByPlaceholderText("Password").closest("form")!);
    await settle();
    expect(m.verifyPassword).not.toHaveBeenCalled();

    await guess("pw 12345");
    expect(m.verifyPassword).toHaveBeenCalledWith("pw 12345");
    expect(m.deleteWallet).toHaveBeenCalledWith("w1");
  });

  it("keeps the wallet and says so in the app's words when the password is wrong", async () => {
    m.verifyPassword.mockRejectedValue("Incorrect password");
    await askDelete();
    await guess("wrong");
    expect(screen.getByText("Incorrect password. Please try again.")).toBeTruthy();
    expect(m.deleteWallet).not.toHaveBeenCalled();
  });

  it("shows the wait once the guesses ran out, and no raw backend text", async () => {
    m.verifyPassword.mockRejectedValue("Too many failed attempts. Try again in 30 seconds.");
    await askDelete();
    await guess("wrong");
    expect(screen.getByText("Too many attempts. Try again in 30 seconds.")).toBeTruthy();
    expect(screen.queryByText(/failed attempts/)).toBeNull();

    m.verifyPassword.mockRejectedValue("Vault not found");
    await guess("again");
    expect(screen.getByText("Could not check the password. Try again.")).toBeTruthy();
    expect(screen.queryByText("Vault not found")).toBeNull();
    expect(m.deleteWallet).not.toHaveBeenCalled();
  });

  it("Cancel closes the prompt and deletes nothing", async () => {
    await askDelete();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(m.verifyPassword).not.toHaveBeenCalled();
    expect(m.deleteWallet).not.toHaveBeenCalled();
  });
});
