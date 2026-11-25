import { useCallback, useRef, useState } from "react";
import { useTranslation } from "src/i18n/react";
import { useQueryClient } from "src/lib/query";
import { useWallet } from "src/contexts/useWallet";
import { useTransactionAuth } from "src/hooks/transactions/useTransactionAuth";
import { withRefresh, refreshAfterJob } from "src/hooks/privacy/usePrivateOp";
import { callContract } from "src/services/contracts/contractService";
import { buildTransferTx, broadcastSignedTx } from "src/services/network/transactionBuilder";
import { captureScope, type TxScope } from "src/services/network/networkService";
import { ONS_FORWARD_TTL_MS } from "src/services/names/onsService";
import { checkName } from "src/features/wallet/services/nameCheck";
import { onsReasonKey } from "src/hooks/wallet/useOns";
import { sendJob } from "src/features/privacy/services/proofJobs";
import { enqueue, remove, retry } from "src/features/privacy/services/proofQueue";
import { isAddress, type SendForm } from "src/features/wallet/hooks/useSendForm";
import type { TokenInfo } from "src/types/contract";
import { formatTokenAmount } from "src/lib/format";
import { logger } from "src/lib/logger";
import { endSend, showProgress, startSend, stepSend, toast } from "src/services/notices/activity";

type SendPhase = "edit" | "review" | "sending" | "failed";

/** Pinned when the review opened: this is what runs. */
interface SendSnapshot {
  scope: TxScope;
  recipient: string;
  name: string | null;
  amountMicro: number;
  tokenAmount: number;
  tokenRaw: string;
  token: TokenInfo | null;
  isPrivate: boolean;
  message: string;
}

const PUBLIC_STEPS = ["proofs.step.signing", "proofs.step.broadcasting"];

interface NameMoved {
  was: string;
  now: string;
}

export function useSendFlow(form: SendForm) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { activeWallet } = useWallet();
  const txAuth = useTransactionAuth();
  const [phase, setPhase] = useState<SendPhase>("edit");
  const [snap, setSnap] = useState<SendSnapshot | null>(null);
  const [marks, setMarks] = useState<number[]>([]);
  const [endedAt, setEndedAt] = useState<number | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [signedOu, setSignedOu] = useState<number | null>(null);
  const [nameMoved, setNameMoved] = useState<NameMoved | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [nameChecking, setNameChecking] = useState(false);
  const inFlight = useRef(false);

  const openReview = useCallback(() => {
    if (!activeWallet || !form.ready) return;
    form.recheck.setError("");
    setNameMoved(null);
    setNameError(null);
    setSnap({
      scope: captureScope(activeWallet.address),
      recipient: form.recipient,
      name: form.recipientName,
      amountMicro: form.amountMicro,
      tokenAmount: form.tokenAmount,
      tokenRaw: form.tokenRaw,
      token: form.token,
      isPrivate: form.isPrivate,
      message: form.isPrivate || form.isToken ? "" : form.message.trim(),
    });
    setPhase("review");
  }, [activeWallet, form]);

  const reject = useCallback(() => {
    if (form.recheck.checking || inFlight.current) return;
    setPhase("edit");
  }, [form.recheck]);

  const acceptNewAddress = useCallback(() => {
    if (!snap || !nameMoved || inFlight.current) return;
    form.setRecipient(nameMoved.now, snap.name);
    setSnap({ ...snap, recipient: nameMoved.now });
    setNameMoved(null);
  }, [snap, nameMoved, form]);

  const nameHolds = useCallback(
    async (s: SendSnapshot): Promise<boolean> => {
      if (!s.name) return true;
      setNameError(null);
      setNameChecking(true);
      try {
        const check = await checkName(s.name, s.recipient, s.scope.networkId);
        if (check.holds) return true;
        if ("moved" in check) setNameMoved({ was: s.recipient, now: check.moved });
        else setNameError(t(onsReasonKey(check.reason)));
        return false;
      } finally {
        setNameChecking(false);
      }
    },
    [t],
  );

  const finish = useCallback(() => {
    form.clear();
    setSnap(null);
    setJobId(null);
    setError(null);
    setPhase("edit");
  }, [form]);

  const runPublic = useCallback(
    async (s: SendSnapshot, ou: string) => {
      if (!activeWallet) return;
      const start = Date.now();
      const ref = `send-${start}`;
      setMarks([start]);
      setEndedAt(null);
      startSend({
        id: ref,
        amount: s.token ? s.tokenAmount * 1_000_000 : s.amountMicro,
        unit: s.token?.symbol ?? "OCT",
        to: s.recipient,
        steps: PUBLIC_STEPS,
        marks: [start],
      });
      showProgress(ref);
      try {
        let txHash: string;
        if (s.token) {
          txHash = await callContract({
            contract: s.token.contractAddress,
            method: "transfer",
            params: [s.recipient, s.tokenRaw],
            from: activeWallet.address,
            walletId: activeWallet.id,
            ou,
            scope: s.scope,
          });
          setMarks([start, Date.now()]);
          stepSend(ref, [start, Date.now()]);
        } else {
          const tx = await buildTransferTx({
            from: activeWallet.address,
            to: s.recipient,
            amount: s.amountMicro,
            walletId: activeWallet.id,
            ou,
            message: s.message || undefined,
            scope: s.scope,
          });
          setMarks([start, Date.now()]);
          stepSend(ref, [start, Date.now()]);
          txHash = await broadcastSignedTx(tx, s.scope);
        }
        logger.info("send", `sent - to=${s.recipient} hash=${txHash}`);
        setEndedAt(Date.now());
        endSend(ref);
        toast({
          title: s.token ? "activity.sentToken" : "activity.sent",
          values: s.token
            ? { amount: formatTokenAmount(s.tokenRaw, s.token.decimals), unit: s.token.symbol }
            : { amount: s.amountMicro },
          who: s.recipient,
          view: { hash: txHash, network: s.scope.networkId },
          scope: s.scope,
        });
        refreshAfterJob(qc, s.scope);
        finish();
      } catch (err) {
        const msg = err instanceof Error ? err.message : t("send.txFailed");
        logger.error("send", `failed - to=${s.recipient}: ${msg}`);
        setError(msg);
        setEndedAt(Date.now());
        endSend(ref);
        toast({
          title: "activity.sendFailed",
          values: s.token ? undefined : { amount: s.amountMicro },
          who: s.recipient,
          failed: true,
          retry: { route: "/send", ref: "public" },
          scope: s.scope,
        });
        setPhase("failed");
      }
    },
    [activeWallet, qc, t, finish],
  );

  const runPrivate = useCallback(
    (s: SendSnapshot, ou: string) => {
      if (!activeWallet) return;
      const id = enqueue(
        withRefresh(
          qc,
          sendJob({
            scope: s.scope,
            walletId: activeWallet.id,
            amount: s.amountMicro,
            ou,
            recipient: s.recipient,
            name: s.name,
          }),
          {
            onDone: () => finish(),
            onFail: (err) => {
              setError(err instanceof Error ? err.message : t("send.txFailed"));
              setPhase("failed");
              return false;
            },
          },
        ),
      );
      setJobId(id);
      showProgress(id);
    },
    [activeWallet, qc, t, finish],
  );

  const confirm = useCallback(async () => {
    if (!snap || !activeWallet || form.fee === null || inFlight.current || nameMoved) return;
    inFlight.current = true;
    try {
      const ou = String(form.fee);
      if (!isAddress(snap.recipient)) return;
      if (!(await nameHolds(snap))) return;
      const resolvedAt = Date.now();
      if (await form.recheck.check(snap.scope.networkId, ou)) return;
      const title = snap.token
        ? t("send.confirmTokenTransfer", { symbol: snap.token.symbol })
        : snap.isPrivate
          ? t("send.confirmPrivateTransfer")
          : t("send.confirmTransaction");
      if (!(await txAuth.requestAuth(title))) {
        logger.info("send", `auth denied - to=${snap.recipient}`);
        return;
      }
      if (snap.name && Date.now() - resolvedAt >= ONS_FORWARD_TTL_MS) {
        setNameError(t("ons.checkAgain"));
        return;
      }
      setSignedOu(form.fee);
      setError(null);
      setPhase("sending");
      if (snap.isPrivate) runPrivate(snap, ou);
      else await runPublic(snap, ou);
    } finally {
      inFlight.current = false;
    }
  }, [snap, activeWallet, form, t, txAuth, runPrivate, runPublic, nameMoved, nameHolds]);

  const retryFailed = useCallback(async () => {
    if (!snap) return;
    if (!snap.isPrivate || !jobId) {
      setPhase("review");
      return;
    }
    if (!(await txAuth.requestAuth(t("send.confirmPrivateTransfer")))) return;
    setError(null);
    setPhase("sending");
    retry(jobId);
    showProgress(jobId);
  }, [snap, jobId, txAuth, t]);

  const removeFailed = useCallback(() => {
    if (jobId) remove(jobId);
    setJobId(null);
    setPhase("edit");
  }, [jobId]);

  const edit = useCallback(() => {
    setError(null);
    setPhase("edit");
  }, []);

  return {
    phase,
    snap,
    marks,
    endedAt,
    jobId,
    error,
    signedOu,
    nameMoved,
    nameError,
    nameChecking,
    acceptNewAddress,
    openReview,
    reject,
    confirm,
    retryFailed,
    removeFailed,
    edit,
    txAuth,
  };
}

export type SendFlow = ReturnType<typeof useSendFlow>;
