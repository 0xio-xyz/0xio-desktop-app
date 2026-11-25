import { useQuery } from "src/lib/query";
import { useState, useCallback } from "react";
import { useWallet } from "src/contexts/useWallet";
import * as networkService from "src/services/network/networkService";
import { POLL_INTERVALS } from "src/services/network/config";
import { logger } from "src/lib/logger";
import type { Transaction, TransactionDetail } from "src/types/transaction";

const PAGE_SIZE = 20;

const tokenSymbolCache = new Map<string, { symbol: string; decimals: number }>();

async function resolveTokenSymbols(txs: Transaction[], networkId: string): Promise<void> {
  const key = (contract: string) => `${networkId}:${contract}`;
  const unknowns = new Set<string>();
  for (const tx of txs) {
    if (tx.token_transfer && !tokenSymbolCache.has(key(tx.token_transfer.contract_address))) {
      unknowns.add(tx.token_transfer.contract_address);
    }
  }

  if (unknowns.size > 0) {
    await Promise.all(
      Array.from(unknowns).map(async (addr) => {
        const [symbol, decimals] = await Promise.all([
          networkService.getContractStorage(addr, "symbol", networkId),
          networkService.getContractStorage(addr, "decimals", networkId),
        ]);
        tokenSymbolCache.set(key(addr), {
          symbol: symbol?.slice(0, 32) || "",
          decimals: parseInt(decimals || "0") || 0,
        });
      }),
    );
  }

  for (const tx of txs) {
    if (tx.token_transfer) {
      const cached = tokenSymbolCache.get(key(tx.token_transfer.contract_address));
      if (cached) {
        tx.token_transfer.symbol = cached.symbol;
        tx.token_transfer.decimals = cached.decimals;
      }
    }
  }
}

/** One address's newest `count` rows on one network, token symbols filled in. Every row carries `network`. */
export async function fetchHistoryPage(
  address: string,
  count: number,
  networkId: string,
): Promise<networkService.TxHistoryResult> {
  const start = performance.now();
  const result = await networkService.getTransactionHistory(address, count, 0, networkId);
  await resolveTokenSymbols(result.transactions, networkId);
  logger.debug(
    "history",
    `fetched ${result.transactions.length} txs on ${networkId}, hasMore=${result.hasMore} (${(performance.now() - start).toFixed(0)}ms)`,
  );
  return result;
}

/** The query key History and Home share for one address on one network. */
export const historyQueryKey = (address: string | undefined, networkId: string, count: number) =>
  ["txHistory", address, networkId, count] as const;

export const HISTORY_PAGE_SIZE = PAGE_SIZE;

export function useTransactionHistory() {
  const { activeWallet, networkId } = useWallet();
  const address = activeWallet?.address;
  const [displayCount, setDisplayCount] = useState(PAGE_SIZE);

  const query = useQuery({
    queryKey: historyQueryKey(address, networkId, displayCount),
    queryFn: () => fetchHistoryPage(address!, displayCount, networkId),
    enabled: !!address,
    staleTime: POLL_INTERVALS.history,
    refetchInterval: POLL_INTERVALS.history,
  });

  const loadMore = useCallback(() => {
    setDisplayCount((prev) => prev + PAGE_SIZE);
  }, []);

  return {
    transactions: query.data?.transactions ?? [],
    hasMore: query.data?.hasMore ?? false,
    isLoading: query.isLoading,
    isRefetching: query.isRefetching,
    failed: query.isError,
    updatedAt: query.dataUpdatedAt || null,
    refetch: query.refetch,
    loadMore,
  };
}

/** One transaction as octra_transaction reads it, on `network` (the active network when omitted). */
export function useTransactionDetail(hash: string | null, network?: string) {
  const { networkId } = useWallet();
  const net = network ?? networkId;
  return useQuery<TransactionDetail | null>({
    queryKey: ["txDetail", hash, net],
    queryFn: () => networkService.getTransactionDetails(hash!, net),
    enabled: !!hash,
    staleTime: 60_000,
  });
}
