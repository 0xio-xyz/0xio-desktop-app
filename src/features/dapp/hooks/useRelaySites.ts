import { useEffect, useState, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  relaySites,
  relaySitesVersion,
  setRelaySites,
  subscribeRelaySites,
  type RelayRecord,
} from "src/features/dapp/services/relaySites";
import { logger } from "src/lib/logger";

export function useRelaySites() {
  useSyncExternalStore(subscribeRelaySites, relaySitesVersion);
  const list = relaySites();

  const disconnect = async (r: RelayRecord) => {
    try {
      setRelaySites(
        await invoke<RelayRecord[]>("site_disconnect", {
          network: r.network,
          origin: r.origin,
          clientId: r.client_id,
        }),
      );
    } catch (err) {
      logger.warn("sites", "could not disconnect the site", err);
    }
  };

  return { list, disconnect };
}

const countOf = (q: unknown): number => {
  const items = (q as { items?: unknown } | null)?.items;
  return Array.isArray(items) ? items.length : 0;
};

export function useWaitingSiteRequests(): number | null {
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    void invoke("site_queue")
      .then((q) => alive && setCount(countOf(q)))
      .catch(() => alive && setCount(0));
    const off = listen<unknown>("site-queue", ({ payload }) => setCount(countOf(payload)));
    return () => {
      alive = false;
      void off.then((f) => f());
    };
  }, []);
  return count;
}

export const recordKey = (r: Pick<RelayRecord, "network" | "origin" | "client_id">) =>
  `${r.network}|${r.client_id}|${r.origin}`;
