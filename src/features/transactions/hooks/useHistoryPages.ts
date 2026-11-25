import { useCallback, useMemo, useState } from "react";
import { useQueries } from "src/lib/query";
import * as networkService from "src/services/network/networkService";
import type { StagingTransaction } from "src/services/network/networkService";
import {
  fetchHistoryPage,
  historyQueryKey,
  HISTORY_PAGE_SIZE,
} from "src/hooks/transactions/useTransactionHistory";
import { POLL_INTERVALS } from "src/services/network/config";
import { keepWithinScope } from "src/lib/query/queryScope";
import type { Transaction } from "src/types/transaction";
import { readNetworks, sideOf, type Side } from "src/features/transactions/history/sides";

const STAGING_OPS: Record<string, Transaction["type"]> = {
  call: "contract_call",
  deploy: "contract_deploy",
  encrypt: "encrypt",
  decrypt: "decrypt",
  claim: "claim",
  private_transfer: "stealth_send",
  stealth: "stealth_send",
  key_switch: "key_switch",
};

function stagingToRow(tx: StagingTransaction, network: string): Transaction {
  const ts = Number(tx.timestamp) || 0;
  return {
    hash: tx.hash,
    type: STAGING_OPS[tx.op_type ?? ""] ?? "send",
    amount: parseInt(tx.amount) || 0,
    fee: 0,
    from: tx.from,
    to: tx.to,
    timestamp: ts > 0 && ts < 1e12 ? ts * 1000 : ts,
    status: "pending",
    nonce: tx.nonce,
    op_type: tx.op_type,
    network,
  };
}

// Reads every network of both pages; never touches the active network.
export function useHistoryPages(address: string, activeId: string, side: Side) {
  const [count, setCount] = useState(HISTORY_PAGE_SIZE);
  const networks = useMemo(
    () => [
      ...new Set([...readNetworks("mainnet", activeId), ...readNetworks("testnet", activeId)]),
    ],
    [activeId],
  );
  const pageNetworks = useMemo(() => readNetworks(side, activeId), [side, activeId]);

  const histories = useQueries({
    queries: networks.map((net) => ({
      queryKey: historyQueryKey(address, net, count),
      queryFn: () => fetchHistoryPage(address, count, net),
      enabled: !!address,
      staleTime: POLL_INTERVALS.history,
      refetchInterval: POLL_INTERVALS.history,
      placeholderData: keepWithinScope(address, net),
    })),
  });

  const staging = useQueries({
    queries: pageNetworks.map((net) => ({
      queryKey: ["stagingView", net],
      queryFn: () => networkService.getStagingView(net),
      enabled: !!address,
      staleTime: 20_000,
      refetchInterval: 20_000,
    })),
  });

  const listed = new Map<string, Transaction[]>();
  networks.forEach((net, i) => {
    const rows = (histories[i]?.data?.transactions ?? []).map((tx) => ({ ...tx, network: net }));
    listed.set(net, rows);
  });

  const rowsOf = (s: Side) =>
    networks
      .filter((net) => sideOf(net) === s)
      .flatMap((net) => listed.get(net) ?? [])
      .sort((a, b) => b.timestamp - a.timestamp);

  const pageRows = rowsOf(side);
  const listedHashes = new Set(pageRows.map((tx) => `${tx.network}:${tx.hash}`));
  const pending = pageNetworks
    .flatMap((net, i) =>
      (staging[i]?.data ?? [])
        .filter((tx) => tx.from === address && tx.hash)
        .map((tx) => stagingToRow(tx, net)),
    )
    .filter((tx) => !listedHashes.has(`${tx.network}:${tx.hash}`));

  const pageIdx = networks.map((net, i) => (sideOf(net) === side ? i : -1)).filter((i) => i >= 0);
  const isLoading = pageIdx.some((i) => histories[i]?.isLoading);
  const isFetching = pageIdx.some((i) => histories[i]?.isFetching);
  const hasMore = pageIdx.some((i) => histories[i]?.data?.hasMore);

  const refetch = useCallback(() => {
    histories.forEach((q) => void q.refetch());
    staging.forEach((q) => void q.refetch());
  }, [histories, staging]);

  return {
    rows: pageRows,
    pending,
    counts: { mainnet: rowsOf("mainnet").length, testnet: rowsOf("testnet").length },
    allRows: [...rowsOf("mainnet"), ...rowsOf("testnet")],
    isLoading,
    isFetching,
    hasMore,
    loadMore: () => setCount((c) => c + HISTORY_PAGE_SIZE),
    refetch,
  };
}
