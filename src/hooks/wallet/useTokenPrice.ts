import { useQuery } from "src/lib/query";
import { logger } from "src/lib/logger";

const ORACLE_BASE = "https://oracle.0xio.xyz";
const ORACLE_URL = `${ORACLE_BASE}/api/prices`;
const POLL_INTERVAL = 30_000;
const SLOW_POLL_INTERVAL = 5 * 60_000;
const HISTORY_STALE_MS = 5 * 60_000;
const CACHE_KEY = "0xio_token_prices";
const HISTORY_CACHE_KEY = "0xio_price_history";
const UPDATED_KEY = "0xio_token_prices_at";
const HEADERS = { Accept: "application/json", "x-0xio-client": "desktop" };

const PRICE_QUERY = "tokenPrices";

interface PriceData {
  [symbol: string]: number;
}

export interface PricePoint {
  value: number;
  time: number;
}

interface PriceRead {
  prices: PriceData;
  at: number | null;
}

function stored<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) || "null") ?? fallback;
  } catch {
    return fallback;
  }
}

function storedRead(): PriceRead {
  return { prices: stored<PriceData>(CACHE_KEY, {}), at: Number(stored(UPDATED_KEY, 0)) || null };
}

let lastPrices: PriceData | null = null;

async function readPrices(): Promise<PriceRead> {
  const resp = await fetch(ORACLE_URL, { headers: HEADERS });
  if (!resp.ok) throw new Error(`price read failed: ${resp.status}`);
  const data: PriceData = await resp.json();
  const at = Date.now();
  localStorage.setItem(UPDATED_KEY, String(at));

  const prev = lastPrices ?? stored<PriceData>(CACHE_KEY, {});
  const changed = Object.entries(data).some(([sym, price]) => {
    const old = prev[sym];
    return !old || Math.abs(price - old) / old > 0.001;
  });
  if (!changed && Object.keys(prev).length > 0) {
    lastPrices = prev;
    return { prices: prev, at };
  }

  logger.debug("price", `update - OCT=${data.OCT ?? "?"} (changed=${changed})`);
  try {
    const detailResp = await fetch(`${ORACLE_BASE}/api/price/oct/details`, { headers: HEADERS });
    if (detailResp.ok) {
      const detail = await detailResp.json();
      if (detail.priceChange24h !== undefined) data.OCT_24H_CHANGE = detail.priceChange24h;
    }
  } catch {}
  lastPrices = data;
  localStorage.setItem(CACHE_KEY, JSON.stringify(data));
  return { prices: data, at };
}

async function readHistory(): Promise<PricePoint[]> {
  const resp = await fetch(`${ORACLE_BASE}/api/chart/history?pair=OCT`, { headers: HEADERS });
  if (!resp.ok) throw new Error(`price history read failed: ${resp.status}`);
  const data: PricePoint[] = await resp.json();
  if (data.length === 0) throw new Error("no price history");
  localStorage.setItem(HISTORY_CACHE_KEY, JSON.stringify(data));
  return data;
}

async function fetchHistoryRange(range: string): Promise<PricePoint[]> {
  try {
    const resp = await fetch(`${ORACLE_BASE}/api/chart/history?pair=OCT&range=${range}`, {
      headers: HEADERS,
    });
    if (!resp.ok) return [];
    return await resp.json();
  } catch {
    return [];
  }
}

const NO_HISTORY: PricePoint[] = [];

/** Token prices from the 0xio oracle: one shared read every 30s, cached in localStorage. */
export function useTokenPrice(opts: { history?: boolean; slow?: boolean } = {}) {
  const query = useQuery({
    queryKey: [PRICE_QUERY],
    queryFn: readPrices,
    initialData: storedRead,
    initialDataUpdatedAt: 0,
    staleTime: POLL_INTERVAL,
    refetchInterval: opts.slow ? SLOW_POLL_INTERVAL : POLL_INTERVAL,
    retry: false,
  });
  const historyQuery = useQuery({
    queryKey: ["priceRange", "OCT", "all"],
    queryFn: readHistory,
    enabled: opts.history === true,
    initialData: () => stored<PricePoint[]>(HISTORY_CACHE_KEY, []),
    initialDataUpdatedAt: 0,
    staleTime: HISTORY_STALE_MS,
    retry: false,
  });

  const prices = query.data.prices;
  const getPrice = (symbol: string): number | undefined => prices[symbol.toUpperCase()];

  const getUsdValue = (symbol: string, amount: number): string | undefined => {
    const price = getPrice(symbol);
    if (!price || price <= 0) return undefined;
    const value = amount * price;
    if (value < 0.01) return "< $0.01";
    if (value < 1) return `$${value.toFixed(4)}`;
    if (value < 1000) return `$${value.toFixed(2)}`;
    return `$${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  };

  const formatPrice = (symbol: string): string => {
    const price = getPrice(symbol);
    if (!price) return "--";
    if (price < 0.001) return `$${price.toFixed(8)}`;
    if (price < 1) return `$${price.toFixed(6)}`;
    if (price < 100) return `$${price.toFixed(4)}`;
    return `$${price.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  };

  return {
    prices,
    priceHistory: opts.history ? historyQuery.data : NO_HISTORY,
    getPrice,
    getUsdValue,
    formatPrice,
    fetchHistoryRange,
    checked: query.isFetched,
    failed: query.isError,
    updatedAt: query.data.at,
    refresh: () => query.refetch().then(() => undefined),
  };
}
