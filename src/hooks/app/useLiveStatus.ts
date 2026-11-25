import { useSyncExternalStore } from "react";
import { useQueryClient, type Query } from "src/lib/query";

/** The reads a screen's balances and lists come from; the header refreshes these. */
const LIVE = new Set([
  "balance",
  "privateBalance",
  "pvacSetup",
  "claimOutputs",
  "pvacKeyStatus",
  "fee",
  "txHistory",
]);

export const isLive = (q: { queryKey: readonly unknown[] }) => LIVE.has(String(q.queryKey[0]));

interface LiveStatus {
  /** When the reads on screen last brought data; null before the first. */
  updatedAt: number | null;
  /** A read that had worked failed on its latest try. */
  failed: boolean;
}

function snapshot(all: Query[]): string {
  const shown = all.filter((q) => q.getObserversCount() > 0);
  const live = shown.filter(isLive);
  let at = 0;
  let failed = false;
  for (const q of live.length ? live : shown) {
    const s = q.state;
    if (s.dataUpdatedAt > at) at = s.dataUpdatedAt;
    if (
      s.status === "error" &&
      s.fetchStatus === "idle" &&
      s.dataUpdatedAt > 0 &&
      s.errorUpdatedAt > s.dataUpdatedAt
    )
      failed = true;
  }
  return `${at}|${failed ? 1 : 0}`;
}

export function useLiveStatus(): LiveStatus {
  const cache = useQueryClient().getQueryCache();
  const snap = useSyncExternalStore(
    (onChange) => cache.subscribe(onChange),
    () => snapshot(cache.getAll()),
  );
  const [at, failed] = snap.split("|");
  return { updatedAt: Number(at) || null, failed: failed === "1" };
}
