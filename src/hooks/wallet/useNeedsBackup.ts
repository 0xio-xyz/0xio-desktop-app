import { useCallback } from "react";
import { useWallet, type WalletData } from "src/contexts/useWallet";
import { walletBridge } from "src/services/wallet/walletBridge";

/** The route of the deferred backup: password first, then the words. */
export const BACKUP_ROUTE = "/backup";

/**
 * A wallet made by Create that has not been written down yet. The flag lives in the encrypted
 * vault per wallet (Rust `needs_backup`), so it survives a reload and never mixes wallets.
 */
export function walletNeedsBackup(wallet: WalletData | null | undefined): boolean {
  return !!wallet && wallet.needs_backup === true && wallet.wallet_type !== "watch";
}

export type WalletSecret = "phrase" | "key";

export function walletSecrets(wallet: WalletData | null | undefined): WalletSecret[] {
  if (!wallet || wallet.wallet_type === "watch" || wallet.exportable === false) return [];
  if (wallet.seal_pending) return ["phrase"];
  return wallet.source === "private_key" ? ["key"] : ["phrase", "key"];
}

export function backupLink(walletId: string, kind?: WalletSecret): string {
  const wallet = `wallet=${encodeURIComponent(walletId)}`;
  return `${BACKUP_ROUTE}?${kind ? `${wallet}&kind=${kind}` : wallet}`;
}

/**
 * A wallet the user asked to seal whose phrase was not shown yet (the app quit during that step,
 * or it was made under the seal from the Wallets screen). Nothing else opens until it is done.
 */
function walletSealPending(wallet: WalletData | null | undefined): boolean {
  return !!wallet && wallet.seal_pending === true && wallet.wallet_type !== "watch";
}

export function pendingSealWallet(wallets: WalletData[] | null | undefined): WalletData | null {
  return wallets?.find(walletSealPending) ?? null;
}

/**
 * Where the app must go first: an unlocked vault holding a wallet that waits for its seal opens
 * the backup screen, and nothing else, until the seal is on. Null when nothing is pending.
 */
export function sealGate(
  o: { isInitialized: boolean; isLocked: boolean; wallets: WalletData[] | null | undefined },
  pathname: string,
): string | null {
  if (!o.isInitialized || o.isLocked || pathname === BACKUP_ROUTE) return null;
  return pendingSealWallet(o.wallets) ? BACKUP_ROUTE : null;
}

export function useNeedsBackup() {
  const { activeWallet, refreshWallets } = useWallet();
  const markBackedUp = useCallback(
    async (walletId: string) => {
      refreshWallets(await walletBridge.markBackedUp(walletId));
    },
    [refreshWallets],
  );
  /** The phrase of a wallet waiting for its seal was written down: seal it in Rust. */
  const finishSeal = useCallback(
    async (walletId: string) => {
      refreshWallets(await walletBridge.finishSeal(walletId));
    },
    [refreshWallets],
  );
  return { needsBackup: walletNeedsBackup(activeWallet), markBackedUp, finishSeal };
}
