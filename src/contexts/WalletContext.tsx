import { useState, useCallback, useEffect, useRef, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useQueryClient } from "src/lib/query";
import { walletBridge } from "src/services/wallet/walletBridge";
import { syncInternalWallets } from "src/services/storage/addressBookService";
import { pvacBridge } from "src/services/pvac/pvacBridge";
import * as networkService from "src/services/network/networkService";
import { logger } from "src/lib/logger";
import { dismiss, toast } from "src/services/notices/activity";
import { feeText } from "src/services/transactions/feeText";
import { WalletContext, type WalletData, type MessageState } from "src/contexts/useWallet";
import { watchAutoLock } from "src/features/security/services/autoLock";
import { dropLockedData } from "src/features/security/services/lockCleanup";
import { bootVault } from "src/features/security/services/bootSession";
import { rememberVault } from "src/services/app/startup";

const AUTO_LOCK_STORAGE_KEY = "0xio_auto_lock_minutes";
const DEFAULT_AUTO_LOCK_MINUTES = 15;

export function WalletProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [isInitialized, setInitializedState] = useState(false);
  const [isLocked, setLockedState] = useState(true);
  const [isLoading, setIsLoading] = useState(true);
  const [activeWallet, setActiveWalletState] = useState<WalletData | null>(null);
  const [wallets, setWallets] = useState<WalletData[]>([]);
  const [networkId, setNetworkIdState] = useState(
    () => localStorage.getItem("0xio_network") || "mainnet",
  );
  const [showBalanceValues, setShowBalance] = useState(true);
  const [pvacForeign, setPvacForeign] = useState(false);
  const [pvacLegacy, setPvacLegacy] = useState(false);
  const working = useRef<number | null>(null);

  const setIsInitialized = useCallback((v: boolean) => {
    rememberVault(v);
    setInitializedState(v);
  }, []);

  const toggleBalanceVisibility = useCallback(() => setShowBalance((p) => !p), []);

  const showMessage = useCallback((type: MessageState["type"], text: string) => {
    if (working.current !== null) dismiss(working.current);
    const id = toast({ title: "", text: feeText(text), tone: type });
    working.current = type === "processing" ? id : null;
  }, []);

  // Every network switch goes through here, so RPC, the UI and the PVAC context always move together.
  const setNetworkId = useCallback((id: string) => {
    setNetworkIdState(id);
    networkService.setNetwork(id);
    // The FHE context is bound to a chain, so it must not survive a network change.
    pvacBridge.destroy().catch(() => {});
    setPvacForeign(false);
    setPvacLegacy(false);
  }, []);

  const activeAddressRef = useRef<string | null>(null);
  const setActiveWallet = useCallback((w: WalletData | null) => {
    const address = w?.address ?? null;
    if (activeAddressRef.current !== address) {
      setPvacForeign(false);
      setPvacLegacy(false);
    }
    activeAddressRef.current = address;
    networkService.setActiveAddress(address);
    setActiveWalletState(w);
  }, []);

  const refreshWallets = useCallback(
    (walletList: WalletData[]) => {
      setWallets(walletList);
      const active = walletList.find((w) => w.is_active) || walletList[0] || null;
      setActiveWallet(active);
    },
    [setActiveWallet],
  );

  // effect:audited - mirrors wallets into the network's address book as internal contacts on every
  // entry path (unlock, onboarding, network switch). An empty list is skipped so the pre-unlock state
  // never wipes them.
  useEffect(() => {
    if (wallets.length === 0) return;
    syncInternalWallets(
      networkId,
      wallets.map((w) => ({ name: w.name, address: w.address })),
    );
  }, [wallets, networkId]);

  const [autoLockMinutes, setAutoLockMinutes] = useState(() => {
    const saved = localStorage.getItem(AUTO_LOCK_STORAGE_KEY);
    return saved !== null ? Number(saved) : DEFAULT_AUTO_LOCK_MINUTES;
  });

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === AUTO_LOCK_STORAGE_KEY) {
        const val = e.newValue !== null ? Number(e.newValue) : DEFAULT_AUTO_LOCK_MINUTES;
        setAutoLockMinutes(val);
        logger.info("wallet", `auto-lock setting changed to ${val} minutes`);
      }
    };
    window.addEventListener("storage", onStorage);

    // The storage event only fires cross-tab, so same-tab changes are polled.
    const poll = setInterval(() => {
      const saved = localStorage.getItem(AUTO_LOCK_STORAGE_KEY);
      const val = saved !== null ? Number(saved) : DEFAULT_AUTO_LOCK_MINUTES;
      setAutoLockMinutes((prev) => (prev !== val ? val : prev));
    }, 5_000);

    return () => {
      window.removeEventListener("storage", onStorage);
      clearInterval(poll);
    };
  }, []);

  const setIsLocked = useCallback(
    (v: boolean) => {
      if (v) {
        networkService.clearPvacPubkeyCache();
        dropLockedData(queryClient);
      }
      setLockedState(v);
    },
    [queryClient],
  );

  useEffect(() => {
    if (isLocked || !isInitialized) return;
    if (autoLockMinutes <= 0) logger.info("wallet", "auto-lock disabled (set to 0)");

    const watch = watchAutoLock({
      minutes: Math.max(0, autoLockMinutes),
      lock: () => {
        logger.info("wallet", `auto-locking after ${autoLockMinutes} min inactivity`);
        pvacBridge.destroy().catch(() => {});
        walletBridge.lock().catch(() => {});
        setIsLocked(true);
      },
      report: (r) => void invoke("wallet_idle_report", { ...r }).catch(() => {}),
    });
    window.addEventListener("mousemove", watch.activity);
    window.addEventListener("keydown", watch.activity);

    return () => {
      window.removeEventListener("mousemove", watch.activity);
      window.removeEventListener("keydown", watch.activity);
      watch.stop();
    };
  }, [isLocked, isInitialized, autoLockMinutes, setIsLocked]);

  useEffect(() => {
    const off = listen("wallet-idle-locked", () => {
      logger.info("wallet", "idle deadline passed - locked");
      pvacBridge.destroy().catch(() => {});
      setIsLocked(true);
    });
    return () => {
      void off.then((f) => f());
    };
  }, [setIsLocked]);

  useEffect(() => {
    (async () => {
      try {
        const initialized = await bootVault();
        setIsInitialized(initialized);
        setIsLocked(initialized);
      } catch {
        setInitializedState(false);
      } finally {
        setIsLoading(false);
      }
    })();
  }, []);

  return (
    <WalletContext.Provider
      value={{
        isInitialized,
        isLocked,
        isLoading,
        activeWallet,
        wallets,
        networkId,
        showBalanceValues,
        pvacForeign,
        setPvacForeign,
        pvacLegacy,
        setPvacLegacy,
        setIsInitialized,
        setIsLocked,
        setActiveWallet,
        setWallets,
        setNetworkId,
        toggleBalanceVisibility,
        showMessage,
        refreshWallets,
      }}
    >
      {children}
    </WalletContext.Provider>
  );
}
