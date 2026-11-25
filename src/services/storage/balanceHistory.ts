const STORAGE_PREFIX = "0xio_bal_hist_";
const MAX_POINTS = 2880;
const MIN_INTERVAL_S = 25;

interface BalanceSnapshot {
  time: number;
  bal: number;
  pub?: number;
  priv?: number;
}

function storageKey(address: string, network: string): string {
  // Full address: a prefix would collide between wallets.
  return `${STORAGE_PREFIX}${network}_${address}`;
}

export function appendSnapshot(address: string, network: string, pub: number, priv: number): void {
  const key = storageKey(address, network);
  const now = Math.floor(Date.now() / 1000);

  try {
    const raw = localStorage.getItem(key);
    const points: BalanceSnapshot[] = raw ? JSON.parse(raw) : [];

    if (points.length > 0 && now - points[points.length - 1].time < MIN_INTERVAL_S) return;

    points.push({ time: now, bal: pub + priv, pub, priv });
    if (points.length > MAX_POINTS) points.splice(0, points.length - MAX_POINTS);

    localStorage.setItem(key, JSON.stringify(points));
  } catch {}
}

export function getSnapshots(address: string, network: string, hoursBack = 24): BalanceSnapshot[] {
  const key = storageKey(address, network);
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const points: BalanceSnapshot[] = JSON.parse(raw);
    const cutoff = Math.floor(Date.now() / 1000) - hoursBack * 3600;
    return points.filter((p) => p.time >= cutoff);
  } catch {
    return [];
  }
}
