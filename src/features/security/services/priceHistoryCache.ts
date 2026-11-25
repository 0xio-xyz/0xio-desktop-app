import type { PricePoint } from "src/hooks/wallet/useTokenPrice";
import type { LockPriceRange } from "src/features/settings/services/appearance";

const KEY = "0xio_price_history_";
const MAX_POINTS = 240;

export const HISTORY_REFRESH_MS: Record<LockPriceRange, number> = {
  "24h": 5 * 60_000,
  "7d": 30 * 60_000,
  "30d": 60 * 60_000,
};

interface Entry {
  at: number;
  points: PricePoint[];
}

function read(range: LockPriceRange): Entry | null {
  try {
    const entry = JSON.parse(localStorage.getItem(KEY + range) || "null");
    return entry && Array.isArray(entry.points) ? entry : null;
  } catch {
    return null;
  }
}

export function cachedHistory(range: LockPriceRange): PricePoint[] {
  return read(range)?.points ?? [];
}

export function historyIsStale(range: LockPriceRange): boolean {
  const entry = read(range);
  return !entry || Date.now() - entry.at >= HISTORY_REFRESH_MS[range];
}

export function storeHistory(range: LockPriceRange, raw: PricePoint[]): PricePoint[] | null {
  const curve = raw
    .map((p) => ({ time: p.time > 1e12 ? p.time : p.time * 1000, value: p.value }))
    .filter((p) => p.value > 0)
    .sort((a, b) => a.time - b.time);
  if (curve.length < 2) return null;
  const stride = Math.max(1, Math.ceil(curve.length / MAX_POINTS));
  const points =
    stride === 1 ? curve : curve.filter((_, i) => i % stride === 0 || i === curve.length - 1);
  try {
    localStorage.setItem(KEY + range, JSON.stringify({ at: Date.now(), points }));
  } catch {}
  return points;
}
