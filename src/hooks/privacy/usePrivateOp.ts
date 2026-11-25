import { useCallback, useState } from "react";
import { useTranslation } from "src/i18n/react";
import { useQueryClient, type QueryClient } from "src/lib/query";
import { useWallet } from "src/contexts/useWallet";
import { useBalance } from "src/hooks/wallet/useBalance";
import { useFee, useFeeRecheck } from "src/hooks/transactions/useFees";
import { usePersistedOU } from "src/hooks/transactions/usePersistedOU";
import { useTransactionAuth } from "src/hooks/transactions/useTransactionAuth";
import { captureScope, type TxScope } from "src/services/network/networkService";
import { decryptJob, encryptJob } from "src/features/privacy/services/proofJobs";
import { enqueue, type JobSpec } from "src/features/privacy/services/proofQueue";
import { formatOCT, parseOCTInput } from "src/lib/format";
import { showProgress } from "src/services/notices/activity";
import { feeOu } from "src/services/transactions/reviewedFee";
import { spendCheck } from "src/services/transactions/spendLimit";
import { feeText } from "src/services/transactions/feeText";

/** The guards a private operation stops at before any proof: setup and layer state. */
const GATE_ERRORS = new Set(["PvacSetupPending", "PvacCompactNeeded", "PvacNotSpendable"]);

export function refreshAfterJob(qc: QueryClient, scope: Pick<TxScope, "address" | "networkId">) {
  const { address, networkId } = scope;
  for (const key of ["balance", "privateBalance", "pvacSetup", "txHistory"])
    void qc.invalidateQueries({ queryKey: [key, address, networkId] });
}

/** Adds the gate refresh and the balance reads to a job before it goes into the queue. */
export function withRefresh(
  qc: QueryClient,
  job: JobSpec,
  extra: Pick<JobSpec, "onDone" | "onFail"> = {},
): JobSpec {
  return {
    ...job,
    onDone: (r) => {
      refreshAfterJob(qc, job.scope);
      extra.onDone?.(r);
    },
    onFail: (err) => {
      if (err instanceof Error && GATE_ERRORS.has(err.name))
        void qc.invalidateQueries({
          queryKey: ["pvacSetup", job.scope.address, job.scope.networkId],
        });
      return extra.onFail?.(err);
    },
  };
}

/**
 * Encrypt or decrypt from the move field: the amount and its checks, the live fee, the review
 * pop-up, then the fee read again, Touch ID or the password, the job into the proof queue and its
 * progress in the pop-up's place.
 */
export function usePrivateOp(kind: "encrypt" | "decrypt") {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { activeWallet } = useWallet();
  const { publicBalance, privateBalance, isLoading } = useBalance();
  const quote = useFee(kind);
  const [ou, setOU] = usePersistedOU(kind, "", quote.fee ?? undefined);
  const recheck = useFeeRecheck(kind, quote, setOU);
  const txAuth = useTransactionAuth();
  const [amount, setAmount] = useState("");
  const [review, setReview] = useState<{ scope: TxScope; amount: number } | null>(null);

  const amountMicro = parseOCTInput(amount);
  const publicKnown = isLoading ? null : publicBalance;
  const fee = quote.status === "ok" ? feeOu(ou) : null;
  const from = kind === "encrypt" ? publicKnown : privateBalance;
  const spend = spendCheck({
    kind,
    balance: from,
    publicMicro: publicKnown,
    feeOu: fee,
    amount: amountMicro,
  });

  let error: string | null = spend.error ? feeText(spend.error) : null;
  if (kind === "decrypt") {
    if (privateBalance === null) error = t("decrypt.privateBalanceLoading");
    else if (privateBalance === 0) error = t("decrypt.noPrivateBalance");
    else if (amountMicro > privateBalance)
      error = t("decrypt.exceedsBalance", { max: formatOCT(privateBalance) });
  }
  const amountError = amountMicro > 0 ? error : null;

  const openReview = useCallback(() => {
    if (!activeWallet || !spend.ok) return;
    recheck.setError("");
    setReview({ scope: captureScope(activeWallet.address), amount: amountMicro });
  }, [activeWallet, spend.ok, recheck, amountMicro]);

  const reject = useCallback(() => {
    if (!recheck.checking) setReview(null);
  }, [recheck.checking]);

  const confirm = useCallback(async () => {
    if (!review || !activeWallet || fee === null) return;
    if (await recheck.check(review.scope.networkId, String(fee))) return;
    const title =
      kind === "encrypt" ? t("encrypt.confirmEncryption") : t("decrypt.confirmDecryption");
    if (!(await txAuth.requestAuth(title))) return;
    const build = kind === "encrypt" ? encryptJob : decryptJob;
    const id = enqueue(
      withRefresh(
        qc,
        build({
          scope: review.scope,
          walletId: activeWallet.id,
          amount: review.amount,
          ou: String(fee),
        }),
      ),
    );
    setReview(null);
    setAmount("");
    showProgress(id);
  }, [review, activeWallet, fee, recheck, kind, t, txAuth, qc]);

  return {
    kind,
    amount,
    setAmount,
    amountMicro,
    publicKnown,
    privateBalance,
    quote,
    ou,
    setOU,
    fee,
    spend,
    amountError,
    review,
    openReview,
    reject,
    confirm,
    recheck,
    txAuth,
  };
}

export type PrivateOp = ReturnType<typeof usePrivateOp>;
