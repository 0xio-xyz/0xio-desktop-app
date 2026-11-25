import { useCallback } from "react";
import { useWallet, type WalletData } from "src/contexts/useWallet";
import { walletBridge } from "src/services/wallet/walletBridge";
import { pvacBridge } from "src/services/pvac/pvacBridge";
import { logger } from "src/lib/logger";

/** Makes `wallet` the open one, as the sidebar menu and the command palette both do. */
export function useSwitchWallet() {
  const { wallets, activeWallet, refreshWallets, showMessage } = useWallet();
  return useCallback(
    async (wallet: WalletData) => {
      if (wallet.id === activeWallet?.id) return;
      try {
        pvacBridge.destroy().catch(() => {});
        await walletBridge.setActive(wallet.id);
        refreshWallets(wallets.map((w) => ({ ...w, is_active: w.id === wallet.id })));
        showMessage("success", `Switched to ${wallet.name}`);
      } catch (err: unknown) {
        logger.error("wallet", `switch failed: ${err}`);
        showMessage("error", err instanceof Error ? err.message : "Failed to switch wallet");
      }
    },
    [wallets, activeWallet?.id, refreshWallets, showMessage],
  );
}
