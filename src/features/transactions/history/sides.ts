import { NETWORKS, isCustomNetwork } from "src/services/network/config";

type Translate = (key: string, options?: Record<string, unknown>) => string;

export type Side = "mainnet" | "testnet";

// Devnet and Devnet 2 are the same chain through different RPCs.
export const isTestnetId = (networkId: string): boolean =>
  networkId === "devnet" || networkId === "devnet2";

// A custom node sits on Mainnet, as in the extension.
export const sideOf = (networkId: string): Side => (isTestnetId(networkId) ? "testnet" : "mainnet");

export const chainOf = (networkId: string): string =>
  isTestnetId(networkId) ? "devnet" : networkId;

export function readNetworks(side: Side, activeId: string): string[] {
  if (side === "testnet") return [activeId === "devnet2" ? "devnet2" : "devnet"];
  return isCustomNetwork(activeId) && NETWORKS[activeId] ? ["mainnet", activeId] : ["mainnet"];
}

export function networkLabel(networkId: string, t: Translate): string {
  if (networkId === "mainnet")
    return t("history.networkMainnet", { defaultValue: "Octra Mainnet" });
  if (isTestnetId(networkId)) {
    return t("history.networkTestnet", { defaultValue: "Octra Testnet" });
  }
  return (
    NETWORKS[networkId]?.name || t("history.customNetwork", { defaultValue: "Custom network" })
  );
}

export function explorerTxUrl(networkId: string, hash: string): string | null {
  const base = NETWORKS[networkId]?.explorerUrl;
  return base && hash ? `${base}${hash}` : null;
}
