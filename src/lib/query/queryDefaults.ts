import { defaultShouldDehydrateQuery } from "src/lib/query/core";
import { RpcError } from "src/services/network/submitErrors";

const NO_PERSIST = new Set([
  "txHistory",
  "priceRange",
  "tokenPrices",
  "transactionHistory",
  "txDetail",
  "tokens",
  "nftCollections",
  "stagingView",
  "claimOutputs",
  "privateBalance",
  "fee",
  "privateSetupTag",
  "settingsChainHead",
  "settingsPing",
  "settingsSystemInfo",
  "onsPrimary",
  "onsResolve",
]);

export const PERSIST_BUSTER = "scope-v2";

export function shouldPersistQuery(query: { queryKey: readonly unknown[] }): boolean {
  if (NO_PERSIST.has(String(query.queryKey?.[0] ?? ""))) return false;
  return defaultShouldDehydrateQuery(
    query as unknown as Parameters<typeof defaultShouldDehydrateQuery>[0],
  );
}

const MAX_QUERY_RETRIES = 1;

export function retryQuery(failureCount: number, error: unknown): boolean {
  if (error instanceof RpcError && error.httpStatus === 429) return false;
  return failureCount < MAX_QUERY_RETRIES;
}
