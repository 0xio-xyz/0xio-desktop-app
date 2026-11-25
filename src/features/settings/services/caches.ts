export const SETTINGS_TAB_KEY = "0xio_settings_tab";

const KEEP = [
  "0xio_network",
  "0xio_theme",
  "0xio_fiat_currency",
  "0xio_auto_lock_minutes",
  "app_language",
  "0xio_pvac_cache_ttl_minutes",
  "0xio_custom_networks",
  "0xio_tx_timeout_seconds",
  "0xio_rpc_timeout_seconds",
  "0xio_developer_mode",
  "0xio_proof_threads",
  "0xio_browser_bookmarks",
  "0xio_update_checked_at",
  SETTINGS_TAB_KEY,
];

export type CacheId = "history" | "nft" | "prices" | "balances" | "methods" | "queries";

const RULES: { id: CacheId; match: (key: string) => boolean }[] = [
  { id: "history", match: (k) => k.startsWith("0xio_tx_cache_") || k.startsWith("0xio_tx_total_") },
  { id: "nft", match: (k) => k.startsWith("0xio_nft_") || k.startsWith("0xio_ignored_nfts") },
  {
    id: "prices",
    match: (k) => k === "0xio_token_prices" || k.startsWith("0xio_price_history"),
  },
  { id: "balances", match: (k) => k.startsWith("0xio_bal_hist_") },
  { id: "methods", match: (k) => k.startsWith("0xio_contract_methods") },
  { id: "queries", match: (k) => k === "0xio-query-cache" },
];

interface CacheSize {
  id: CacheId;
  bytes: number;
}

/** UTF-16 in web storage: two bytes a character. */
export function measureCaches(): CacheSize[] {
  const sizes = new Map<CacheId, number>(RULES.map((r) => [r.id, 0]));
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || KEEP.includes(key)) continue;
      const rule = RULES.find((r) => r.match(key));
      if (!rule) continue;
      const value = localStorage.getItem(key) ?? "";
      sizes.set(rule.id, (sizes.get(rule.id) ?? 0) + (key.length + value.length) * 2);
    }
  } catch {}
  return RULES.map((r) => ({ id: r.id, bytes: sizes.get(r.id) ?? 0 }));
}

export function clearCaches() {
  for (const key of Object.keys(localStorage)) {
    if (!KEEP.includes(key)) localStorage.removeItem(key);
  }
}

export function formatBytes(bytes: number): { value: string; unit: string } {
  if (bytes < 1024) return { value: String(bytes), unit: "B" };
  if (bytes < 1_048_576) return { value: String(Math.round(bytes / 1024)), unit: "KB" };
  return { value: (bytes / 1_048_576).toFixed(1), unit: "MB" };
}
