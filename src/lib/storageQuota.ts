// WKWebView has a tight localStorage budget: on overflow, drop recomputable caches and retry once.
// User data (address book, bookmarks, settings, networks, NFT lists, pending key-switch) is never evicted.
const EVICTABLE_PREFIXES = [
  "0xio-query-cache",
  "0xio_nft_cache_v",
  "0xio_nft_tokens_v",
  "0xio_nft_market_v",
  "0xio_nft_traits_v",
  "0xio_tx_cache_v",
  "0xio_tx_total_v",
  "0xio_token_prices",
  "0xio_price_history",
];

function isQuotaError(e: unknown): boolean {
  return (
    e instanceof DOMException &&
    (e.name === "QuotaExceededError" ||
      e.name === "NS_ERROR_DOM_QUOTA_REACHED" ||
      e.code === 22 ||
      e.code === 1014)
  );
}

function evictRecomputableCaches(): void {
  for (const key of Object.keys(localStorage)) {
    if (EVICTABLE_PREFIXES.some((p) => key.startsWith(p))) {
      try {
        localStorage.removeItem(key);
      } catch {}
    }
  }
}

let installed = false;

export function installStorageQuotaGuard(): void {
  if (installed || typeof Storage === "undefined") return;
  installed = true;
  const raw = Storage.prototype.setItem;
  Storage.prototype.setItem = function (key: string, value: string) {
    try {
      raw.call(this, key, value);
    } catch (e) {
      if (!isQuotaError(e)) throw e;
      evictRecomputableCaches();
      raw.call(this, key, value);
    }
  };
}
