import type { NetworkConfig } from "src/types/network";

export const NETWORKS: Record<string, NetworkConfig> = {
  mainnet: {
    id: "mainnet",
    name: "Octra Mainnet",
    rpcUrl: "https://octra.network",
    explorerUrl: "https://octrascan.io/tx.html?hash=",
    explorerAddressUrl: "https://octrascan.io/address.html?addr=",
    indexerUrl: "https://octrascan.io",
    supportsPrivacy: true,
    color: "#f59e0b",
  },
  devnet: {
    id: "devnet",
    name: "Octra Devnet",
    rpcUrl: "https://devnet.octrascan.io",
    explorerUrl: "https://devnet.octrascan.io/tx.html?hash=",
    explorerAddressUrl: "https://devnet.octrascan.io/address.html?addr=",
    indexerUrl: "https://devnet.octrascan.io",
    supportsPrivacy: true,
    color: "#8b5cf6",
  },
  devnet2: {
    id: "devnet2",
    name: "Octra Devnet 2",
    rpcUrl: "https://rpc-proxy.0xio.xyz",
    rpcEndpoint: "https://rpc-proxy.0xio.xyz/rpc/devnet",
    explorerUrl: "https://devnet.octrascan.io/tx.html?hash=",
    explorerAddressUrl: "https://devnet.octrascan.io/address.html?addr=",
    indexerUrl: "https://devnet.octrascan.io",
    supportsPrivacy: true,
    color: "#8b5cf6",
  },
};

export const DEFAULT_NETWORK = "mainnet";

const CUSTOM_NETWORKS_KEY = "0xio_custom_networks";

export function loadCustomNetworks(): NetworkConfig[] {
  try {
    const raw = localStorage.getItem(CUSTOM_NETWORKS_KEY);
    return raw ? (JSON.parse(raw) as NetworkConfig[]) : [];
  } catch {
    return [];
  }
}

/** Merged into NETWORKS so a custom network resolves app-wide, not only inside Settings. */
function syncCustomNetworks() {
  for (const id of Object.keys(NETWORKS)) {
    if (id.startsWith("custom_")) delete NETWORKS[id];
  }
  for (const cn of loadCustomNetworks()) NETWORKS[cn.id] = cn;
}

export function saveCustomNetworks(nets: NetworkConfig[]) {
  localStorage.setItem(CUSTOM_NETWORKS_KEY, JSON.stringify(nets));
  syncCustomNetworks();
}

syncCustomNetworks();

/** A user's own node, rather than one of the networks 0xio hosts infrastructure for. */
export function isCustomNetwork(id: string): boolean {
  return id.startsWith("custom_");
}

/**
 * A custom node is not a second mainnet: the shared token list is not its list, and features
 * that need a contract or service 0xio deploys per network are not there. Privacy comes from the
 * config the user added.
 */
interface NetworkCapabilities {
  privacy: boolean;
  market: boolean;
  swap: boolean;
  bridge: boolean;
  tokenListTag?: "octra-mainnet" | "octra-devnet";
}

export function networkCapabilities(id: string): NetworkCapabilities {
  const supportsPrivacy = NETWORKS[id]?.supportsPrivacy ?? false;
  if (isCustomNetwork(id)) {
    return {
      privacy: supportsPrivacy,
      market: false,
      swap: false,
      bridge: false,
      tokenListTag: undefined,
    };
  }
  const devnet = id !== "mainnet";
  return {
    privacy: supportsPrivacy,
    market: true,
    swap: devnet,
    bridge: !devnet,
    tokenListTag: devnet ? "octra-devnet" : "octra-mainnet",
  };
}

export const ADDRESS_PREFIX = "oct";

/**
 * Gates both the Automations screen and the auto-encrypt runner: a wallet must never keep
 * spending fees on a schedule the user cannot reach a switch to stop.
 */
export const AUTOMATIONS_ENABLED = false;

export const POLL_INTERVALS = {
  balance: 30_000,
  history: 60_000,
} as const;

export const FINANCE = {
  MICRO_OCT_MULTIPLIER: 1_000_000,
  DECIMALS: 6,
} as const;
