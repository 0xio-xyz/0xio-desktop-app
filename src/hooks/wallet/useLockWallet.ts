import { useCallback } from "react";
import { useNavigate } from "src/lib/router";
import { useWallet } from "src/contexts/useWallet";
import { walletBridge } from "src/services/wallet/walletBridge";
import { pvacBridge } from "src/services/pvac/pvacBridge";

/** Locks the wallet now: drops the proof context, locks the vault and shows the lock screen. */
export function useLockWallet() {
  const { setIsLocked } = useWallet();
  const navigate = useNavigate();
  return useCallback(async () => {
    pvacBridge.destroy().catch(() => {});
    await walletBridge.lock();
    setIsLocked(true);
    navigate("/lock");
  }, [setIsLocked, navigate]);
}
