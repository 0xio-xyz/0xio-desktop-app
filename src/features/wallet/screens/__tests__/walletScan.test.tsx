// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "src/lib/router";
import { QueryClient, QueryClientProvider } from "src/lib/query";
import "src/i18n";

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
const SECOND = {
  ...MAIN,
  id: "w2",
  name: "Wallet 2",
  address: `oct${"B".repeat(44)}`,
  is_active: false,
};
const addressAt = (index: number) => `oct${String(index).padStart(2, "0")}${"S".repeat(42)}`;
const accountsTo = (max: number) =>
  Array.from({ length: Math.min(max, 50) }, (_, index) => ({
    index,
    address: index === 0 ? MAIN.address : addressAt(index),
    imported: index === 0,
  }));

const m = vi.hoisted(() => ({
  hasPassword: vi.fn(),
  scanHdAccounts: vi.fn(),
  deriveAccount: vi.fn(),
  getPublicKey: vi.fn(),
  getBalance: vi.fn(),
  refresh: vi.fn(),
  showMessage: vi.fn(),
}));
const held = vi.hoisted(() => ({ wallets: [] as unknown[] }));
vi.mock("src/services/wallet/walletBridge", () => ({
  walletBridge: {
    hasPassword: (...a: unknown[]) => m.hasPassword(...a),
    scanHdAccounts: (...a: unknown[]) => m.scanHdAccounts(...a),
    deriveAccount: (...a: unknown[]) => m.deriveAccount(...a),
    getPublicKey: (...a: unknown[]) => m.getPublicKey(...a),
  },
}));
vi.mock("src/services/network/networkService", async (original) => ({
  ...(await original<typeof import("src/services/network/networkService")>()),
  getBalance: (...a: unknown[]) => m.getBalance(...a),
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
    wallets: held.wallets,
    networkId: "mainnet",
    refreshWallets: m.refresh,
    showMessage: m.showMessage,
    setIsInitialized: vi.fn(),
    setIsLocked: vi.fn(),
    setActiveWallet: vi.fn(),
    setWallets: vi.fn(),
  }),
}));

import WalletListScreen from "src/features/wallet/screens/WalletListScreen";

const settle = () => act(() => new Promise((r) => setTimeout(r, 10)));
const button = (name: string | RegExp) => screen.getByRole("button", { name });
const noButton = (name: string | RegExp) => screen.queryByRole("button", { name }) === null;
const sheet = () => screen.queryByRole("dialog", { name: "Enter your password" });
const scanner = () => screen.queryByRole("dialog", { name: "Derive account" });
const rows = () => screen.getAllByRole("button", { name: /^Account \d+$/ });
const field = () => screen.getByPlaceholderText("Index or address");
const openScanner = async () => {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <WalletListScreen />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await settle();
  fireEvent.click(button("Derive account"));
};
const press = async (name: string | RegExp) => {
  fireEvent.click(button(name));
  await settle();
};
const pressScan = () => press("Scan accounts");
const cancelSheet = () => fireEvent.click(within(sheet()!).getByRole("button", { name: "Cancel" }));
const guess = async (value: string) => {
  fireEvent.change(screen.getByPlaceholderText("Password"), { target: { value } });
  fireEvent.click(button("Continue"));
  await settle();
};

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset();
  held.wallets = [MAIN];
  m.hasPassword.mockResolvedValue(true);
  m.getPublicKey.mockResolvedValue("");
  m.getBalance.mockResolvedValue({ balance: 0, nonce: 0 });
  m.scanHdAccounts.mockImplementation(async (_id: string, _pw: string, max: number) => ({
    accounts: accountsTo(max),
  }));
});
afterEach(cleanup);

describe("Wallets: scan for more accounts on a vault with a password", () => {
  it("asks once in the auth sheet, then scans with that password and lists the accounts", async () => {
    await openScanner();
    await pressScan();
    expect(sheet()).toBeTruthy();
    expect(m.scanHdAccounts).not.toHaveBeenCalled();

    await guess("pw 12345");
    expect(m.scanHdAccounts).toHaveBeenCalledTimes(1);
    expect(m.scanHdAccounts).toHaveBeenCalledWith("w1", "pw 12345", 20);
    expect(m.deriveAccount).not.toHaveBeenCalled();
    expect(sheet()).toBeNull();
    expect(rows()).toHaveLength(20);
    expect(button("Account 7").getAttribute("title")).toBe(addressAt(7));
    expect(screen.getByText("oct07SSSSSSS...SSSSSSSS")).toBeTruthy();
    expect(m.showMessage).not.toHaveBeenCalled();
    expect(m.getBalance).not.toHaveBeenCalled();
  });

  it("Cancel closes the sheet, scans nothing and leaves Scan ready", async () => {
    await openScanner();
    await pressScan();
    cancelSheet();
    expect(sheet()).toBeNull();
    expect(m.scanHdAccounts).not.toHaveBeenCalled();
    expect(button("Scan accounts").hasAttribute("disabled")).toBe(false);

    await pressScan();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(sheet()).toBeNull();
    expect(button("Scan accounts")).toBeTruthy();
    expect(m.scanHdAccounts).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(scanner()).toBeNull();
  });

  it("a wrong password is one attempt and reads in the app's words", async () => {
    m.scanHdAccounts.mockRejectedValueOnce("Incorrect password");
    m.scanHdAccounts.mockRejectedValueOnce("Too many failed attempts. Try again in 30 seconds.");
    await openScanner();
    await pressScan();
    await guess("wrong");
    expect(m.scanHdAccounts).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Incorrect password. Please try again.")).toBeTruthy();
    expect(sheet()).toBeTruthy();

    await guess("wrong again");
    expect(m.scanHdAccounts).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Too many attempts. Try again in 30 seconds.")).toBeTruthy();
    expect(screen.queryByText(/failed attempts/)).toBeNull();
    expect(m.showMessage).not.toHaveBeenCalled();

    await guess("pw 12345");
    expect(m.scanHdAccounts).toHaveBeenCalledTimes(3);
    expect(sheet()).toBeNull();
    expect(rows()).toHaveLength(20);
  });

  it("Load more asks once and keeps the list when it is cancelled", async () => {
    await openScanner();
    await pressScan();
    await guess("pw 12345");
    await press("Load more");
    expect(sheet()).toBeTruthy();
    cancelSheet();
    expect(rows()).toHaveLength(20);

    await press("Load more");
    await guess("pw 12345");
    expect(m.scanHdAccounts).toHaveBeenLastCalledWith("w1", "pw 12345", 30);
    expect(m.scanHdAccounts).toHaveBeenCalledTimes(2);
    expect(rows()).toHaveLength(30);
  });

  it("the address search asks once and uses that password for every range", async () => {
    await openScanner();
    await pressScan();
    await guess("pw 12345");
    fireEvent.change(field(), { target: { value: addressAt(34) } });
    expect(screen.getByText("No accounts found")).toBeTruthy();
    await press("Search");
    expect(sheet()).toBeTruthy();
    expect(m.scanHdAccounts).toHaveBeenCalledTimes(1);

    await guess("pw 12345");
    expect(sheet()).toBeNull();
    expect(m.scanHdAccounts.mock.calls.slice(1)).toEqual([
      ["w1", "pw 12345", 30],
      ["w1", "pw 12345", 40],
    ]);
    expect(rows()).toHaveLength(1);
    expect(button("Account 34").getAttribute("aria-pressed")).toBe("true");
    expect(button("Add account 34")).toBeTruthy();
  });

  it("the address search stops at the first refused password", async () => {
    await openScanner();
    await pressScan();
    await guess("pw 12345");
    fireEvent.change(field(), { target: { value: addressAt(34) } });
    await press("Search");
    m.scanHdAccounts.mockRejectedValueOnce("Incorrect password");
    await guess("wrong");
    expect(m.scanHdAccounts).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Incorrect password. Please try again.")).toBeTruthy();
  });

  it("an address in no account ends at the cap with nothing found and no more to load", async () => {
    await openScanner();
    await pressScan();
    await guess("pw 12345");
    fireEvent.change(field(), { target: { value: `oct${"Z".repeat(44)}` } });
    await press("Search");
    await guess("pw 12345");
    expect(m.scanHdAccounts.mock.calls.slice(1).map((c) => c[2])).toEqual([30, 40, 50]);
    expect(screen.getByText("No accounts found")).toBeTruthy();
    expect(button("Search").hasAttribute("disabled")).toBe(true);

    fireEvent.change(field(), { target: { value: "" } });
    expect(rows()).toHaveLength(50);
    expect(noButton("Load more")).toBe(true);
  });

  it("adding the picked account asks for the password once and ends with the result toast", async () => {
    m.deriveAccount.mockResolvedValue({ ...MAIN, id: "w7", address: addressAt(7) });
    await openScanner();
    await pressScan();
    await guess("pw 12345");
    expect(button("Add account").hasAttribute("disabled")).toBe(true);
    fireEvent.click(button("Account 7"));
    await press("Add account 7");
    expect(sheet()).toBeTruthy();
    expect(m.deriveAccount).not.toHaveBeenCalled();

    cancelSheet();
    expect(sheet()).toBeNull();
    expect(rows()).toHaveLength(20);
    expect(button("Account 7").getAttribute("aria-pressed")).toBe("true");

    await press("Add account 7");
    await guess("pw 12345");
    expect(m.deriveAccount).toHaveBeenCalledTimes(1);
    expect(m.deriveAccount).toHaveBeenCalledWith("w1", "pw 12345", 7);
    expect(m.scanHdAccounts).toHaveBeenCalledTimes(1);
    expect(m.showMessage).toHaveBeenCalledTimes(1);
    expect(m.showMessage).toHaveBeenCalledWith("success", "Account 7 added");
    expect(scanner()).toBeNull();
    expect(sheet()).toBeNull();
  });
});

describe("Wallets: scan on a vault without a password", () => {
  beforeEach(() => m.hasPassword.mockResolvedValue(false));

  it("scans straight away with no prompt", async () => {
    await openScanner();
    await pressScan();
    expect(sheet()).toBeNull();
    expect(m.scanHdAccounts).toHaveBeenCalledWith("w1", "", 20);
    expect(rows()).toHaveLength(20);

    await press("Load more");
    expect(sheet()).toBeNull();
    expect(m.scanHdAccounts).toHaveBeenLastCalledWith("w1", "", 30);
  });

  it("a failed scan shows in the list slot with Retry, and Retry scans again", async () => {
    m.scanHdAccounts.mockRejectedValueOnce("No mnemonic");
    await openScanner();
    await pressScan();
    expect(sheet()).toBeNull();
    expect(screen.getByText("Could not scan")).toBeTruthy();
    expect(screen.queryByText("No mnemonic")).toBeNull();
    expect(m.showMessage).not.toHaveBeenCalled();

    await press("Retry");
    expect(m.scanHdAccounts).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("Could not scan")).toBeNull();
    expect(rows()).toHaveLength(20);
  });

  it("a failed Load more keeps Retry for the same range", async () => {
    await openScanner();
    await pressScan();
    m.scanHdAccounts.mockRejectedValueOnce("busy");
    await press("Load more");
    expect(screen.getByText("Could not scan")).toBeTruthy();
    await press("Retry");
    expect(m.scanHdAccounts).toHaveBeenLastCalledWith("w1", "", 30);
    expect(rows()).toHaveLength(30);
  });

  it("a scan that finds nothing says so and offers no more", async () => {
    m.scanHdAccounts.mockResolvedValue({ accounts: [] });
    await openScanner();
    await pressScan();
    expect(screen.getByText("No accounts found")).toBeTruthy();
    expect(noButton("Load more")).toBe(true);
    expect(noButton("Scan accounts")).toBe(true);
    expect(button("Add account").hasAttribute("disabled")).toBe(true);
  });

  it("Load more is offered until the 50 account cap, then goes", async () => {
    await openScanner();
    await pressScan();
    await press("Load more");
    await press("Load more");
    expect(rows()).toHaveLength(40);
    expect(button("Load more")).toBeTruthy();

    await press("Load more");
    expect(m.scanHdAccounts).toHaveBeenLastCalledWith("w1", "", 50);
    expect(rows()).toHaveLength(50);
    expect(noButton("Load more")).toBe(true);
  });

  it("the picked account is a filled row; one already in the wallet cannot be picked", async () => {
    await openScanner();
    await pressScan();
    expect(button("Account 0").hasAttribute("disabled")).toBe(true);
    expect(within(scanner()!).getByText("Added")).toBeTruthy();

    fireEvent.click(button("Account 7"));
    expect(button("Account 7").getAttribute("aria-pressed")).toBe("true");
    expect(button("Account 7").parentElement?.className).toContain("bg-surface-highlight");
    fireEvent.click(button("Account 9"));
    expect(button("Account 7").getAttribute("aria-pressed")).toBe("false");
    expect(button("Add account 9").hasAttribute("disabled")).toBe(false);
    expect(document.body.textContent).not.toMatch(/[\u2713\u2714]/);
  });

  it("an index outside the list is scanned up to it and picked; past 49 is refused in words", async () => {
    await openScanner();
    await pressScan();
    fireEvent.change(field(), { target: { value: "42" } });
    await press("Search");
    expect(m.scanHdAccounts).toHaveBeenLastCalledWith("w1", "", 43);
    expect(rows()).toHaveLength(1);
    expect(button("Add account 42")).toBeTruthy();

    fireEvent.change(field(), { target: { value: "60" } });
    expect(screen.getByText("Only accounts 0 to 49 can be scanned")).toBeTruthy();
    expect(button("Search").hasAttribute("disabled")).toBe(true);
    expect(m.scanHdAccounts).toHaveBeenCalledTimes(2);
  });

  it("balances are read only when asked, and a node that does not answer offers Retry", async () => {
    m.getBalance.mockImplementation(async (address: string) => {
      if (address === addressAt(3)) throw new Error("timeout");
      return { balance: address === addressAt(2) ? 1_500_000 : 0, nonce: 0 };
    });
    await openScanner();
    await pressScan();
    expect(m.getBalance).not.toHaveBeenCalled();

    await press("Show balances");
    expect(m.getBalance).toHaveBeenCalledTimes(19);
    expect(m.getBalance).toHaveBeenCalledWith(addressAt(2), "mainnet");
    expect(button("Account 2").parentElement?.textContent).toContain("1.5OCT");
    expect(screen.getByText("Node did not answer")).toBeTruthy();

    m.getBalance.mockResolvedValue({ balance: 0, nonce: 0 });
    await press("Retry");
    expect(m.getBalance).toHaveBeenCalledTimes(20);
    expect(screen.queryByText("Node did not answer")).toBeNull();
  });

  it("with several recovery phrases the parent is picked first", async () => {
    held.wallets = [MAIN, SECOND];
    await openScanner();
    expect(noButton("Scan accounts")).toBe(true);
    fireEvent.click(within(scanner()!).getByRole("button", { name: /Wallet 2/ }));
    await pressScan();
    expect(m.scanHdAccounts).toHaveBeenCalledWith("w2", "", 20);
  });
});
