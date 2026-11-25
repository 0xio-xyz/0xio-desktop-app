import { createContext, useContext } from "react";

// Kept apart from the provider: react-refresh only hot-swaps a module that exports components or
// non-components, never both, and a shared file broke every consumer on each provider edit.

export interface WalletData {
  id: string;
  name: string;
  address: string;
  wallet_type: string;
  is_active: boolean;
  created_at: number;
  source: string;
  exportable?: boolean;
  /** Made by Create and not yet written down (kept in the vault, per wallet). */
  needs_backup?: boolean;
  /** Asked to be sealed; the seal goes on once its phrase was shown (Rust `seal_pending`). */
  seal_pending?: boolean;
}

export interface MessageState {
  id: number;
  type: "success" | "error" | "warning" | "info" | "processing";
  text: string;
}

interface WalletContextType {
  isInitialized: boolean;
  isLocked: boolean;
  isLoading: boolean;
  activeWallet: WalletData | null;
  wallets: WalletData[];
  networkId: string;
  showBalanceValues: boolean;
  pvacForeign: boolean;
  setPvacForeign: (v: boolean) => void;
  // Encrypted balance was written by an older pvac-rs build (pre-canonical-parity H): readable
  // via the legacy fallback keys, but canonical private ops must not touch it.
  pvacLegacy: boolean;
  setPvacLegacy: (v: boolean) => void;
  setIsInitialized: (v: boolean) => void;
  setIsLocked: (v: boolean) => void;
  setActiveWallet: (w: WalletData | null) => void;
  setWallets: (ws: WalletData[]) => void;
  setNetworkId: (id: string) => void;
  toggleBalanceVisibility: () => void;
  showMessage: (type: MessageState["type"], text: string) => void;
  refreshWallets: (walletList: WalletData[]) => void;
}

export const WalletContext = createContext<WalletContextType>(null!);

export const useWallet = () => {
  const ctx = useContext(WalletContext);
  // The default is null: fail with the real cause instead of an opaque destructuring error.
  if (!ctx) throw new Error("useWallet must be used within <WalletProvider>");
  return ctx;
};
