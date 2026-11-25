// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "src/lib/router";
import "src/i18n";

const ADDRESS = `oct${"7".repeat(44)}`;
const WORDS = ["abandon", "ability", "able", "about", "above", "absent", "zoo"];

const m = vi.hoisted(() => ({
  create: vi.fn(),
  exportMnemonic: vi.fn(),
  exportPrivateKey: vi.fn(),
  preview: vi.fn(),
  importMnemonic: vi.fn(),
  importPrivateKey: vi.fn(),
  importAddress: vi.fn(),
  wordlist: vi.fn(),
  available: vi.fn(),
  enable: vi.fn(),
  balance: vi.fn(),
  setWallets: vi.fn(),
  finishSeal: vi.fn(),
  clearPasted: vi.fn(),
  copySecret: vi.fn(async (..._a: unknown[]) => {}),
}));
vi.mock("src/services/wallet/walletBridge", () => ({
  walletBridge: {
    create: (...a: unknown[]) => m.create(...a),
    exportMnemonic: (...a: unknown[]) => m.exportMnemonic(...a),
    exportPrivateKey: (...a: unknown[]) => m.exportPrivateKey(...a),
    previewSecret: (...a: unknown[]) => m.preview(...a),
    importMnemonic: (...a: unknown[]) => m.importMnemonic(...a),
    importPrivateKey: (...a: unknown[]) => m.importPrivateKey(...a),
    importAddress: (...a: unknown[]) => m.importAddress(...a),
    mnemonicWordlist: (...a: unknown[]) => m.wordlist(...a),
    activateHellMode: vi.fn(),
    markBackedUp: vi.fn(),
    finishSeal: (...a: unknown[]) => m.finishSeal(...a),
    endReveal: vi.fn(async () => {}),
    copySecret: (...a: unknown[]) => m.copySecret(...a),
    clearPastedSecret: (...a: unknown[]) => m.clearPasted(...a),
  },
}));
vi.mock("src/services/wallet/biometricService", () => ({
  biometricService: {
    isAvailable: (...a: unknown[]) => m.available(...a),
    enable: (...a: unknown[]) => m.enable(...a),
  },
}));
vi.mock("src/services/network/networkService", () => ({
  getBalance: (...a: unknown[]) => m.balance(...a),
}));
vi.mock("src/shared/ui/WalletAvatar", () => ({ default: () => null }));
vi.mock("src/contexts/useWallet", () => ({
  useWallet: () => ({
    setIsInitialized: vi.fn(),
    setIsLocked: vi.fn(),
    setWallets: m.setWallets,
    setActiveWallet: vi.fn(),
  }),
}));

import OnboardingScreen from "src/features/security/screens/OnboardingScreen";

const created = {
  id: "w1",
  name: "Wallet 1",
  address: ADDRESS,
  wallet_type: "hd",
  is_active: true,
  created_at: 0,
  source: "mnemonic",
  needs_backup: true,
};

const show = () =>
  render(
    <MemoryRouter>
      <OnboardingScreen />
    </MemoryRouter>,
  );

const type = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
const press = (name: string | RegExp) => fireEvent.click(screen.getByRole("button", { name }));
const settle = () => act(() => new Promise((r) => setTimeout(r, 10)));

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset();
  m.create.mockResolvedValue(created);
  m.available.mockResolvedValue({ available: false, type: 0 });
  m.wordlist.mockResolvedValue(WORDS);
  m.balance.mockResolvedValue({ balance: 2_500_000, nonce: 0 });
});
afterEach(cleanup);

describe("Create", () => {
  it("saves the wallet without showing or fetching the phrase or key", async () => {
    const { container } = show();
    press(/Create new wallet/);
    type("Password", "correct horse 9");
    press("Continue");
    expect(await screen.findByText("Confirm password", { selector: "h1" })).toBeTruthy();
    type("Confirm password", "correct horse 9");
    press("Continue");

    expect(await screen.findByText("Your wallet is ready")).toBeTruthy();
    expect(m.create).toHaveBeenCalledWith("correct horse 9", false);
    expect(m.exportMnemonic).not.toHaveBeenCalled();
    expect(m.exportPrivateKey).not.toHaveBeenCalled();
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/Recovery Phrase|Private Key|Copy All/i);
    expect(text).toContain(ADDRESS.slice(0, 10));
  });

  it("offers no way past the password for a wallet that holds a key", async () => {
    show();
    press(/Create new wallet/);
    expect(screen.getByText("Create a password")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Skip/i })).toBeNull();
    expect(screen.queryByText(/without a password/i)).toBeNull();
  });

  it("asks for the password on its own step, then a separate confirmation", async () => {
    show();
    press(/Create new wallet/);
    expect(screen.getByText("Create a password")).toBeTruthy();
    expect(screen.queryByLabelText("Confirm password")).toBeNull();
    type("Password", "short");
    expect(screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(true);
    type("Password", "long enough 1");
    press("Continue");
    type("Confirm password", "long enough 2");
    expect(await screen.findByText("Passwords do not match")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(true);
  });

  it("offers Touch ID right after the password when the system has it", async () => {
    m.available.mockResolvedValue({ available: true, type: 2 });
    m.enable.mockResolvedValue(undefined);
    show();
    await settle();
    press(/Create new wallet/);
    type("Password", "correct horse 9");
    press("Continue");
    type("Confirm password", "correct horse 9");
    press("Continue");
    expect(await screen.findByText("Unlock with Touch ID?")).toBeTruthy();
    expect(m.create).not.toHaveBeenCalled();
    press("Use Touch ID");
    expect(await screen.findByText("Your wallet is ready")).toBeTruthy();
    expect(m.enable).toHaveBeenCalledWith("correct horse 9");
  });

  it("keeps a sealed Create waiting for its seal until the phrase was shown", async () => {
    m.exportMnemonic.mockResolvedValue(WORDS.slice(0, 6));
    m.finishSeal.mockResolvedValue([{ ...created, exportable: false, needs_backup: false }]);
    show();
    press("Advanced options");
    fireEvent.click(screen.getByRole("switch", { name: "Seal recovery phrase" }));
    press("Done");
    press(/Create new wallet/);
    type("Password", "correct horse 9");
    press("Continue");
    type("Confirm password", "correct horse 9");
    press("Continue");

    expect(await screen.findByRole("heading", { name: "Recovery phrase" })).toBeTruthy();
    expect(m.create).toHaveBeenCalledWith("correct horse 9", true);
    expect(m.finishSeal).not.toHaveBeenCalled();
    await settle();
    expect(screen.getByText(/only time/).parentElement?.textContent).toBe(
      "This is the only time this computer shows these words.",
    );
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    expect(screen.queryByText("Enter the")).toBeNull();
    const done = screen.getByRole("button", { name: "I wrote them down" });
    expect(done.hasAttribute("disabled")).toBe(true);
    press("Copy");
    await settle();
    expect(m.copySecret).toHaveBeenCalledWith("w1", "phrase");
    expect(done.hasAttribute("disabled")).toBe(true);
    press("Show");
    expect(screen.getByTestId("phrase-grid").textContent).toContain(WORDS[0]);
    press("I wrote them down");
    expect(await screen.findByText("Your wallet is ready")).toBeTruthy();
    expect(m.finishSeal).toHaveBeenCalledWith("w1");
  });

  it("uses text Show and Hide for the password, not an icon", async () => {
    show();
    press(/Create new wallet/);
    const field = screen.getByLabelText("Password") as HTMLInputElement;
    expect(field.type).toBe("password");
    press("Show");
    expect(field.type).toBe("text");
    expect(screen.getByRole("button", { name: "Hide" })).toBeTruthy();
  });
});

describe("Import field", () => {
  const open = async () => {
    show();
    press(/Import wallet/);
    await settle();
  };
  const field = () => screen.getByLabelText("Phrase, key or address");

  it("detects a phrase and previews the wallet Rust derives, with its balance", async () => {
    m.preview.mockResolvedValue({ kind: "phrase", address: ADDRESS, is_padded: false });
    await open();
    fireEvent.change(field(), { target: { value: `${"abandon ".repeat(11)}about` } });
    expect(await screen.findByText("Recovery phrase")).toBeTruthy();
    expect(m.preview).toHaveBeenCalledWith(`${"abandon ".repeat(11)}about`);
    expect(await screen.findByText("2.5")).toBeTruthy();
  });

  it("detects a private key", async () => {
    const key = `${"B".repeat(43)}=`;
    m.preview.mockResolvedValue({ kind: "key", address: ADDRESS, is_padded: false });
    await open();
    fireEvent.change(field(), { target: { value: key } });
    expect(await screen.findByText("Private key", { selector: "span" })).toBeTruthy();
    expect(m.preview).toHaveBeenCalledWith(key);
  });

  it("clears a pasted secret from the clipboard through Rust, and leaves a pasted address", async () => {
    const phrase = `${"abandon ".repeat(11)}about`;
    const readText = vi.fn(async () => `${phrase}\n`);
    Object.assign(navigator, { clipboard: { readText } });
    m.preview.mockResolvedValue({ kind: "phrase", address: ADDRESS, is_padded: false });
    m.clearPasted.mockResolvedValue(true);
    await open();
    press("Paste");
    await settle();
    expect((field() as HTMLTextAreaElement).value).toBe(phrase);
    expect(m.clearPasted).toHaveBeenCalledWith(`${phrase}\n`);

    m.clearPasted.mockClear();
    readText.mockResolvedValue(ADDRESS);
    press("Paste");
    await settle();
    expect(m.clearPasted).not.toHaveBeenCalled();
  });

  it("detects an Octra address as watch-only, without asking Rust for anything", async () => {
    await open();
    fireEvent.change(field(), { target: { value: ADDRESS } });
    expect(await screen.findByText("Watch-only")).toBeTruthy();
    expect(screen.getByText("Address. Adds it as a watch-only wallet.")).toBeTruthy();
    expect(m.preview).not.toHaveBeenCalled();
  });

  it("fixes a mistyped word in one tap", async () => {
    m.preview.mockResolvedValue({ kind: "phrase", address: ADDRESS, is_padded: false });
    await open();
    const typo = `${"abandon ".repeat(5)}abandn ${"abandon ".repeat(5)}about`;
    fireEvent.change(field(), { target: { value: typo } });
    expect(screen.getByText("“abandn” is not a recovery word.")).toBeTruthy();
    press("Use “abandon”");
    expect((field() as HTMLTextAreaElement).value).toBe(`${"abandon ".repeat(11)}about`);
    expect(await screen.findByText("Recovery phrase")).toBeTruthy();
  });

  it("adds an address without a password, since a watch wallet holds no key", async () => {
    m.importAddress.mockResolvedValue({ ...created, wallet_type: "watch", source: "address" });
    await open();
    fireEvent.change(field(), { target: { value: ADDRESS } });
    await screen.findByText("Watch-only");
    press("Continue");
    expect(await screen.findByText("Your wallet is ready")).toBeTruthy();
    expect(m.importAddress).toHaveBeenCalledWith(ADDRESS);
    expect(m.create).not.toHaveBeenCalled();
    expect(m.importMnemonic).not.toHaveBeenCalled();
    expect(m.importPrivateKey).not.toHaveBeenCalled();
  });

  it("a key import lands backed up, and a refused password reads in the app's words", async () => {
    const key = `${"B".repeat(43)}=`;
    m.preview.mockResolvedValue({ kind: "key", address: ADDRESS, is_padded: false });
    m.importPrivateKey.mockRejectedValueOnce("Incorrect password");
    m.importPrivateKey.mockRejectedValueOnce("Too many failed attempts. Try again in 30 seconds.");
    m.importPrivateKey.mockResolvedValue({
      ...created,
      wallet_type: "imported",
      source: "private_key",
      needs_backup: false,
    });
    await open();
    fireEvent.change(field(), { target: { value: key } });
    await screen.findByText("Private key", { selector: "span" });
    press("Continue");
    type("Password", "correct horse 9");
    press("Continue");
    type("Confirm password", "correct horse 9");
    press("Continue");
    expect(await screen.findByText("Incorrect password. Please try again.")).toBeTruthy();
    press("Continue");
    expect(await screen.findByText("Too many attempts. Try again in 30 seconds.")).toBeTruthy();
    expect(screen.queryByText(/failed attempts/)).toBeNull();
    press("Continue");
    expect(await screen.findByText("Your wallet is ready")).toBeTruthy();
    expect(m.importPrivateKey).toHaveBeenCalledWith(key, "correct horse 9");
    expect(m.importPrivateKey).toHaveBeenCalledTimes(3);
  });

  it("goes on to the password before it saves anything", async () => {
    m.preview.mockResolvedValue({ kind: "phrase", address: ADDRESS, is_padded: false });
    m.importMnemonic.mockResolvedValue([{ ...created, needs_backup: false }]);
    await open();
    fireEvent.change(field(), { target: { value: `${"abandon ".repeat(11)}about` } });
    await screen.findByText("Recovery phrase");
    press("Continue");
    expect(screen.getByText("Create a password")).toBeTruthy();
    expect(m.importMnemonic).not.toHaveBeenCalled();
    type("Password", "correct horse 9");
    press("Continue");
    type("Confirm password", "correct horse 9");
    press("Continue");
    expect(await screen.findByText("Your wallet is ready")).toBeTruthy();
    expect(m.importMnemonic).toHaveBeenCalledWith(
      `${"abandon ".repeat(11)}about`.split(" "),
      "correct horse 9",
    );
  });
});
