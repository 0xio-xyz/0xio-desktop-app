import { isCustomNetwork, NETWORKS } from "src/services/network/config";
import { isTestnetId } from "src/features/transactions/history/sides";
import { networkShortName } from "src/shared/layout/WalletMenu";

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  }
}

export function explorerBase(url: string): string {
  return url.replace(/\/tx\.html.*/, "").replace(/\?.*$/, "");
}

export function netColor(id: string): string {
  if (id === "mainnet") return "var(--pos)";
  if (isCustomNetwork(id)) return NETWORKS[id]?.color ?? "var(--fg-3)";
  return "var(--fg-3)";
}

export function netName(id: string): string {
  return isCustomNetwork(id) ? (NETWORKS[id]?.name ?? id) : networkShortName(id);
}

export function netHost(id: string): string {
  const net = NETWORKS[id];
  if (!net) return "";
  return hostOf(net.rpcEndpoint ?? net.rpcUrl);
}

export { isTestnetId };
