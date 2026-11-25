import { useSyncExternalStore } from "react";
import { useQueries, useQuery } from "src/lib/query";
import { invoke } from "@tauri-apps/api/core";
import {
  getChainHead,
  pingNetwork,
  rpcTimingsFor,
  rpcUrlFor,
  subscribeRpcTimings,
} from "src/services/network/networkService";
import { getLastUpdateCheck, getUpdateSnapshot, subscribeUpdates } from "src/services/app/updater";

/** Gentle on octra.network, which limits requests per address. */
const HEAD_EVERY_MS = 15_000;

export function useChainHead(networkId: string) {
  return useQuery({
    queryKey: ["settingsChainHead", networkId],
    queryFn: () => getChainHead(networkId),
    refetchInterval: HEAD_EVERY_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: HEAD_EVERY_MS,
    gcTime: 60_000,
  });
}

export function useRpcTimings(networkId: string): readonly number[] {
  const url = rpcUrlFor(networkId);
  return useSyncExternalStore(subscribeRpcTimings, () => rpcTimingsFor(url));
}

/** One ping per network when the tab opens, never on a loop. */
export function useNetworkPings(networkIds: string[]) {
  return useQueries({
    queries: networkIds.map((id) => ({
      queryKey: ["settingsPing", id],
      queryFn: () => pingNetwork(id),
      staleTime: 30_000,
      gcTime: 60_000,
      retry: false,
      refetchOnWindowFocus: false,
    })),
  });
}

interface SystemInfo {
  proof_threads: number;
  cores: number;
  log_bytes: number | null;
}

export function useSystemInfo() {
  return useQuery({
    queryKey: ["settingsSystemInfo"],
    queryFn: () => invoke<SystemInfo>("system_info"),
    staleTime: 0,
    gcTime: 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
}

export function useLastUpdateCheck(): number | null {
  return useSyncExternalStore(subscribeUpdates, getLastUpdateCheck);
}

export function useUpdateState() {
  return useSyncExternalStore(subscribeUpdates, getUpdateSnapshot).update;
}
