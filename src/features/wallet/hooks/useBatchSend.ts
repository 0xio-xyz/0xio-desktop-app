import { useState, useCallback, useRef } from "react";
import i18n from "src/i18n/core";
import { callContract } from "src/services/contracts/contractService";
import { buildTransferTx, broadcastSignedTx } from "src/services/network/transactionBuilder";
import * as privacyService from "src/features/privacy/services/privacyService";
import { pvacBridge } from "src/services/pvac/pvacBridge";
import { assertScope, type TxScope } from "src/services/network/networkService";
import { decimalToRaw, parseOCTInput } from "src/lib/format";
import type { TokenInfo } from "src/types/contract";
import { logger } from "src/lib/logger";

export interface BatchRow {
  id: string;
  address: string;
  amount: string;
  status: "pending" | "sending" | "success" | "failed";
  txHash?: string;
  error?: string;
  phase?: number;
}

interface BatchStats {
  total: number;
  pending: number;
  success: number;
  failed: number;
}

export function useBatchSend() {
  const [rows, setRows] = useState<BatchRow[]>([]);
  const [isExecuting, setIsExecuting] = useState(false);
  const [currentRowIndex, setCurrentRowIndex] = useState(-1);
  const cancelRef = useRef(false);

  const addRow = useCallback((address: string, amount: string) => {
    setRows((prev) => [...prev, { id: crypto.randomUUID(), address, amount, status: "pending" }]);
  }, []);

  const addRows = useCallback((entries: { address: string; amount: string }[]) => {
    setRows((prev) => [
      ...prev,
      ...entries.map((e) => ({
        id: crypto.randomUUID(),
        address: e.address,
        amount: e.amount,
        status: "pending" as const,
      })),
    ]);
  }, []);

  const removeRow = useCallback((id: string) => {
    setRows((prev) => prev.filter((r) => r.id !== id));
  }, []);

  const clearRows = useCallback(() => {
    setRows([]);
  }, []);

  const updateRow = useCallback((id: string, updates: Partial<BatchRow>) => {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...updates } : r)));
  }, []);

  const resetFailed = useCallback(() => {
    setRows((prev) =>
      prev.map((r) =>
        r.status === "failed"
          ? { ...r, status: "pending" as const, error: undefined, txHash: undefined }
          : r,
      ),
    );
  }, []);

  const stats: BatchStats = {
    total: rows.length,
    pending: rows.filter((r) => r.status === "pending" || r.status === "sending").length,
    success: rows.filter((r) => r.status === "success").length,
    failed: rows.filter((r) => r.status === "failed").length,
  };

  const execute = useCallback(
    async (walletId: string, scope: TxScope, token: TokenInfo | null, ou: string) => {
      const walletAddress = scope.address;
      cancelRef.current = false;
      setIsExecuting(true);

      let success = 0;
      let failed = 0;
      try {
        const pendingRows = rows.filter((r) => r.status === "pending");

        for (const row of pendingRows) {
          if (cancelRef.current) break;
          assertScope(scope);

          updateRow(row.id, { status: "sending" });

          try {
            if (token) {
              const rawAmount = decimalToRaw(row.amount, token.decimals);
              if (rawAmount === "0") throw new Error(i18n.t("sendFlow.enterAmount"));
              await callContract({
                contract: token.contractAddress,
                method: "transfer",
                params: [row.address, rawAmount],
                from: walletAddress,
                walletId,
                ou,
                scope,
              });
              updateRow(row.id, { status: "success" });
            } else {
              const amountMicro = parseOCTInput(row.amount);
              const tx = await buildTransferTx({
                from: walletAddress,
                to: row.address,
                amount: amountMicro,
                walletId,
                ou,
                scope,
              });
              const txHash = await broadcastSignedTx(tx, scope);
              updateRow(row.id, { status: "success", txHash });
            }
            success++;
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : "Transaction failed";
            updateRow(row.id, { status: "failed", error: msg });
            failed++;
          }
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Batch execution failed";
        rows
          .filter((r) => r.status === "pending")
          .forEach((r) => {
            updateRow(r.id, { status: "failed", error: msg });
            failed++;
          });
      } finally {
        setIsExecuting(false);
      }
      return { success, failed };
    },
    [rows, updateRow],
  );

  const executePrivate = useCallback(
    async (walletId: string, scope: TxScope, ou: string, onRow?: (index: number) => void) => {
      const walletAddress = scope.address;
      cancelRef.current = false;
      setIsExecuting(true);

      let success = 0;
      let failed = 0;
      let capped = 0;
      try {
        if (!pvacBridge.isInitializedFor(walletAddress))
          await privacyService.initPvac(walletId, walletAddress);

        const allPending = rows.filter((r) => r.status === "pending");

        // Each stealth send adds two base layers and past six even the migrate proof is unprovable, so
        // the batch is capped at floor((6 - B) / 2) from a fresh cipher read.
        const budget = await privacyService.getStealthSendBudget(
          walletAddress,
          walletId,
          scope.networkId,
        );
        let pendingRows = allPending;
        // Fails closed when the layers cannot be read: sends are broadcast only, so nothing later can
        // catch up mid burst.
        if (budget.cap === null) {
          throw new Error(
            "Could not read the balance's layer count - private batch send is paused. Try again.",
          );
        }
        {
          if (budget.cap === 0) {
            throw new Error("Migrate your balance first, then send privately");
          }
          if (allPending.length > budget.cap) {
            pendingRows = allPending.slice(0, budget.cap);
            capped = allPending.length - pendingRows.length;
            logger.warn(
              "batchSend",
              `capping batch to ${budget.cap} of ${allPending.length} private sends (baseLayers=${budget.baseLayers}) - balance must stay migratable`,
            );
          }
        }

        for (let i = 0; i < pendingRows.length; i++) {
          const row = pendingRows[i];
          if (cancelRef.current) break;
          assertScope(scope);

          setCurrentRowIndex(i);
          onRow?.(i);
          updateRow(row.id, { status: "sending", phase: 0 });

          try {
            const amountMicro = parseOCTInput(row.amount);
            logger.info(
              "batchSend",
              `Private send ${i + 1}/${pendingRows.length}: ${row.amount} OCT -> ${row.address.slice(0, 12)}...`,
            );

            const result = await privacyService.sendStealth({
              scope,
              recipient: row.address,
              amount: amountMicro,
              walletId,
              ou,
              onProgress: (step) => updateRow(row.id, { phase: step }),
            });
            updateRow(row.id, {
              status: "success",
              txHash: result.txHash || undefined,
              phase: undefined,
            });
            success++;
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : "Stealth send failed";
            updateRow(row.id, { status: "failed", error: msg, phase: undefined });
            failed++;
          }
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Failed to initialize stealth send";
        rows
          .filter((r) => r.status === "pending")
          .forEach((r) => {
            updateRow(r.id, { status: "failed", error: msg });
            failed++;
          });
      } finally {
        setIsExecuting(false);
        setCurrentRowIndex(-1);
      }
      return { success, failed, capped };
    },
    [rows, updateRow],
  );

  const cancel = useCallback(() => {
    cancelRef.current = true;
  }, []);

  return {
    rows,
    stats,
    isExecuting,
    currentRowIndex,
    addRow,
    addRows,
    removeRow,
    clearRows,
    updateRow,
    resetFailed,
    execute,
    executePrivate,
    cancel,
  };
}
