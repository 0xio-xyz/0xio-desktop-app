import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "src/i18n/react";
import { useQueryClient } from "src/lib/query";
import { useWallet } from "src/contexts/useWallet";
import { useTransactionAuth } from "src/hooks/transactions/useTransactionAuth";
import { refreshAfterJob } from "src/hooks/privacy/usePrivateOp";
import { captureScope, type TxScope } from "src/services/network/networkService";
import { enqueue } from "src/features/privacy/services/proofQueue";
import { useBatchSend } from "src/features/wallet/hooks/useBatchSend";
import { exactTokenSpend, isAddress, type SendForm } from "src/features/wallet/hooks/useSendForm";
import type { TokenInfo } from "src/types/contract";
import { spendCheck } from "src/services/transactions/spendLimit";
import { decimalToRaw, isPositiveDecimal, truncateAddress } from "src/lib/format";

interface BulkSnapshot {
  scope: TxScope;
  ou: string;
  token: TokenInfo | null;
  isPrivate: boolean;
  rows: { id: string; address: string; amount: string }[];
  total: number;
  totalRaw: string;
}

type BulkPhase = "edit" | "review" | "sending" | "done";

export function parseRows(
  text: string,
  split: RegExp = /[,\t]/,
): { address: string; amount: string }[] {
  const lines = text.trim().split("\n");
  const start = lines[0]?.toLowerCase().includes("address") ? 1 : 0;
  const out: { address: string; amount: string }[] = [];
  for (let i = start; i < lines.length; i++) {
    const cols = lines[i].split(split).map((c) => c.trim().replace(/^"|"$/g, ""));
    if (cols.length >= 2 && isAddress(cols[0]) && isPositiveDecimal(cols[1]))
      out.push({ address: cols[0], amount: cols[1] });
  }
  return out;
}

export function useBulkFlow(form: SendForm) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { activeWallet, showMessage } = useWallet();
  const batch = useBatchSend();
  const txAuth = useTransactionAuth();
  const [phase, setPhase] = useState<BulkPhase>("edit");
  const [result, setResult] = useState<{ success: number; failed: number; capped: number } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [snap, setSnap] = useState<BulkSnapshot | null>(null);
  const inFlight = useRef(false);

  const pending = batch.rows.filter((r) => r.status === "pending");
  const decimals = form.token ? form.token.decimals : 6;
  const totalRaw = useMemo(
    () => pending.reduce((s, r) => s + BigInt(decimalToRaw(r.amount, decimals)), 0n),
    [pending, decimals],
  );
  const total = Number(totalRaw) / 10 ** decimals;
  const duplicates = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of batch.rows) counts.set(r.address, (counts.get(r.address) || 0) + 1);
    return new Set([...counts].filter(([, n]) => n > 1).map(([a]) => a));
  }, [batch.rows]);
  const checked = spendCheck({
    kind: form.spendKind,
    balance: form.spendBalance,
    publicMicro: form.publicKnown,
    feeOu: form.fee,
    amount: form.isToken ? total : Number(totalRaw),
    count: pending.length,
  });
  const spend = form.token
    ? exactTokenSpend(checked, totalRaw.toString(), form.token.balance)
    : checked;
  const ready = pending.length > 0 && spend.ok;

  const run = useCallback(
    async (s: BulkSnapshot) => {
      if (!activeWallet) return;
      const recheck = await form.recheck.check(s.scope.networkId, s.ou);
      if (recheck) {
        setError(recheck);
        setPhase("review");
        return;
      }
      setPhase("sending");
      setResult(null);
      if (!s.isPrivate) {
        const r = await batch.execute(activeWallet.id, s.scope, s.token, s.ou);
        setResult({ ...r, capped: 0 });
        setPhase("done");
        refreshAfterJob(qc, s.scope);
        return;
      }
      enqueue({
        kind: "bulk",
        scope: s.scope,
        amount: Number(s.totalRaw),
        steps: s.rows.map((r) => truncateAddress(r.address, 10, 8)),
        run: async (step) => {
          const r = await batch.executePrivate(activeWallet.id, s.scope, s.ou, step);
          setResult(r);
          return {};
        },
        onDone: () => {
          setPhase("done");
          refreshAfterJob(qc, s.scope);
        },
        onFail: (err) => {
          setError(err instanceof Error ? err.message : t("send.txFailed"));
          setPhase("done");
          return false;
        },
      });
    },
    [activeWallet, batch, form.recheck, qc, t],
  );

  const openReview = useCallback(() => {
    if (!activeWallet || !ready || form.fee === null) return;
    setError(null);
    form.recheck.setError("");
    setSnap({
      scope: captureScope(activeWallet.address),
      ou: String(form.fee),
      token: form.token,
      isPrivate: form.isPrivate,
      rows: pending.map((r) => ({ id: r.id, address: r.address, amount: r.amount })),
      total,
      totalRaw: totalRaw.toString(),
    });
    setPhase("review");
  }, [activeWallet, ready, form, pending, total, totalRaw]);

  const reject = useCallback(() => {
    if (inFlight.current) return;
    setPhase("edit");
  }, []);

  // Touch ID or the password after Send; nothing is signed before it.
  const confirm = useCallback(async () => {
    if (!snap || inFlight.current) return;
    inFlight.current = true;
    try {
      if (!(await txAuth.requestAuth(t("send.confirmTransaction")))) return;
      await run(snap);
    } finally {
      inFlight.current = false;
    }
  }, [snap, txAuth, t, run]);

  const addText = useCallback(
    (text: string, csv = false) => {
      const entries = parseRows(text, csv ? /,/ : undefined);
      if (entries.length === 0) {
        showMessage("error", t(csv ? "send.noValidRowsCsv" : "send.noValidRows"));
        return false;
      }
      batch.addRows(entries);
      return true;
    },
    [batch, showMessage, t],
  );

  return {
    batch,
    phase,
    review: phase === "edit" ? null : snap,
    result,
    error,
    pending,
    total,
    duplicates,
    spend,
    ready,
    openReview,
    reject,
    confirm,
    addText,
    stop: batch.cancel,
    retryFailed: () => {
      batch.resetFailed();
      setResult(null);
      setPhase("edit");
    },
    newSend: () => {
      batch.clearRows();
      setResult(null);
      setPhase("edit");
    },
    txAuth,
  };
}

export type BulkFlow = ReturnType<typeof useBulkFlow>;
