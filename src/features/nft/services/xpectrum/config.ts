// The source of truth is the remote config at VITE_XPECTRUM_CONFIG_URL ({ [networkId]: config });
// SEED is only the offline fallback.

interface XpectrumConfig {
  market: string;
}

const SEED: Record<string, XpectrumConfig> = {
  mainnet: {
    market: "octGoeTjaF8MiKTP5ad5FJfWMCZmmEdnrfxTow6UUVmBj6h",
  },
  devnet: {
    market: "octBQG94WAh4dqwtp3dBSMdd7RqL5oBQG74t6nxLzGaYK2m",
  },
};

const overrides: Record<string, XpectrumConfig> = {};

export function xpectrumConfig(networkId: string): XpectrumConfig | null {
  return overrides[networkId] ?? SEED[networkId] ?? null;
}

function setXpectrumConfig(map: Record<string, XpectrumConfig>): void {
  for (const [net, cfg] of Object.entries(map)) {
    if (cfg && cfg.market) overrides[net] = cfg;
  }
}

let loaded = false;
async function loadRemoteXpectrumConfig(url?: string): Promise<void> {
  const u = url ?? (import.meta.env?.VITE_XPECTRUM_CONFIG_URL as string | undefined);
  if (!u || loaded) return;
  loaded = true;
  try {
    const r = await fetch(u, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return;
    const map = (await r.json()) as Record<string, XpectrumConfig>;
    if (map && typeof map === "object") setXpectrumConfig(map);
  } catch {}
}

void loadRemoteXpectrumConfig();

export const MICRO_OCT = 1_000_000;
