// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

const m = vi.hoisted(() => ({
  mark: vi.fn(),
  seal: vi.fn(),
  refresh: vi.fn(),
  active: null as Record<string, unknown> | null,
}));
vi.mock("src/services/wallet/walletBridge", () => ({
  walletBridge: {
    markBackedUp: (...a: unknown[]) => m.mark(...a),
    finishSeal: (...a: unknown[]) => m.seal(...a),
  },
}));
vi.mock("src/contexts/useWallet", () => ({
  useWallet: () => ({ activeWallet: m.active, refreshWallets: m.refresh }),
}));

import {
  backupLink,
  pendingSealWallet,
  sealGate,
  useNeedsBackup,
  walletNeedsBackup,
  walletSecrets,
} from "src/hooks/wallet/useNeedsBackup";

const wallet = (over: Record<string, unknown>) => ({
  id: "w1",
  name: "Wallet 1",
  address: `oct${"A".repeat(44)}`,
  wallet_type: "hd",
  is_active: true,
  created_at: 0,
  source: "mnemonic",
  ...over,
});

beforeEach(() => {
  m.mark.mockReset();
  m.refresh.mockReset();
});

describe("what a wallet can show", () => {
  it("a phrase wallet has both entries, a key wallet only its key", () => {
    expect(walletSecrets(wallet({}) as never)).toEqual(["phrase", "key"]);
    expect(walletSecrets(wallet({ source: "derived" }) as never)).toEqual(["phrase", "key"]);
    expect(walletSecrets(wallet({ source: "private_key" }) as never)).toEqual(["key"]);
  });

  it("a watch only or sealed wallet has neither, one waiting for its seal only the phrase", () => {
    expect(walletSecrets(wallet({ wallet_type: "watch", source: "address" }) as never)).toEqual([]);
    expect(walletSecrets(wallet({ exportable: false }) as never)).toEqual([]);
    expect(walletSecrets(wallet({ seal_pending: true }) as never)).toEqual(["phrase"]);
    expect(walletSecrets(null)).toEqual([]);
  });

  it("a key wallet that was not written down asks for its backup", () => {
    expect(walletNeedsBackup(wallet({ source: "private_key", needs_backup: true }) as never)).toBe(
      true,
    );
    expect(walletNeedsBackup(wallet({ source: "private_key" }) as never)).toBe(false);
  });

  it("links to the one surface by wallet and entry", () => {
    expect(backupLink("w 1")).toBe("/backup?wallet=w%201");
    expect(backupLink("w1", "phrase")).toBe("/backup?wallet=w1&kind=phrase");
    expect(backupLink("w1", "key")).toBe("/backup?wallet=w1&kind=key");
  });
});

describe("backed-up flag", () => {
  it("is per wallet: only the wallet flagged by Create asks for a backup", () => {
    expect(walletNeedsBackup(wallet({ needs_backup: true }))).toBe(true);
    expect(walletNeedsBackup(wallet({ id: "w2", needs_backup: false }))).toBe(false);
    expect(walletNeedsBackup(wallet({ id: "w3" }))).toBe(false);
    expect(walletNeedsBackup(wallet({ wallet_type: "watch", needs_backup: true }))).toBe(false);
    expect(walletNeedsBackup(null)).toBe(false);
  });

  it("follows the active wallet", () => {
    m.active = wallet({ needs_backup: true });
    const { result, rerender } = renderHook(() => useNeedsBackup());
    expect(result.current.needsBackup).toBe(true);
    m.active = wallet({ id: "w2", needs_backup: false });
    rerender();
    expect(result.current.needsBackup).toBe(false);
  });

  it("clears the flag of that wallet in the vault and refreshes the list", async () => {
    const list = [wallet({ needs_backup: false }), wallet({ id: "w2", needs_backup: true })];
    m.mark.mockResolvedValue(list);
    m.active = wallet({ needs_backup: true });
    const { result } = renderHook(() => useNeedsBackup());
    await act(() => result.current.markBackedUp("w1"));
    expect(m.mark).toHaveBeenCalledWith("w1");
    expect(m.refresh).toHaveBeenCalledWith(list);
  });
});

describe("a sealed Create the app quit on", () => {
  const waiting = wallet({ id: "w9", needs_backup: true, seal_pending: true });
  const open = { isInitialized: true, isLocked: false };

  it("finds the wallet that waits for its seal", () => {
    expect(pendingSealWallet([wallet({}), waiting])?.id).toBe("w9");
    expect(pendingSealWallet([wallet({ needs_backup: true })])).toBeNull();
    expect(pendingSealWallet([wallet({ wallet_type: "watch", seal_pending: true })])).toBeNull();
    expect(pendingSealWallet(undefined)).toBeNull();
  });

  it("opens the backup first on the next launch, once unlocked, from anywhere", () => {
    for (const path of ["/", "/send", "/settings", "/wallets"]) {
      expect(sealGate({ ...open, wallets: [waiting] }, path)).toBe("/backup");
    }
    expect(sealGate({ ...open, wallets: [waiting] }, "/backup")).toBeNull();
    expect(sealGate({ ...open, isLocked: true, wallets: [waiting] }, "/")).toBeNull();
    expect(sealGate({ ...open, isInitialized: false, wallets: [waiting] }, "/")).toBeNull();
    expect(sealGate({ ...open, wallets: [wallet({ needs_backup: true })] }, "/")).toBeNull();
  });

  it("seals in Rust and refreshes the list", async () => {
    const list = [wallet({ exportable: false, needs_backup: false, seal_pending: false })];
    m.seal.mockResolvedValue(list);
    m.active = waiting;
    const { result } = renderHook(() => useNeedsBackup());
    await act(() => result.current.finishSeal("w9"));
    expect(m.seal).toHaveBeenCalledWith("w9");
    expect(m.refresh).toHaveBeenCalledWith(list);
  });
});
