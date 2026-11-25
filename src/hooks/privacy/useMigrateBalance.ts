import { useEffect, useState } from "react";
import * as networkService from "src/services/network/networkService";
import {
  clearPendingKeySwitch,
  getPendingKeySwitch,
  STAGED_WINDOW_MS,
} from "src/features/privacy/services/keySwitchService";
import {
  cachedPayloadIsLive,
  refreshFeeQuote,
  refreshReviewed,
} from "src/features/privacy/services/balanceRefresh";
import {
  SetupReviewError,
  readReviewFee,
  setupScopeError,
} from "src/features/privacy/services/setupReview";
import { useWallet } from "src/contexts/useWallet";
import { enqueue } from "src/features/privacy/services/proofQueue";
import { showProgress } from "src/services/notices/activity";
import { STEPS } from "src/features/privacy/services/proofJobs";
import { useTransactionAuth } from "src/hooks/transactions/useTransactionAuth";
import { FEE_UNAVAILABLE } from "src/services/transactions/feeCopy";
import { logger } from "src/lib/logger";

// Devnet drops an unincluded key_switch after ~10 min (TTL); past this window an unresolved
// pending migration record is treated as expired and Migrate is offered again.
export const MIGRATION_PENDING_WINDOW_MS = STAGED_WINDOW_MS;

const SETTLED_STATUSES = new Set([
  "confirmed",
  "accepted",
  "rejected",
  "failed",
  "dropped",
  "expired",
]);

/**
 * A review with the live key_switch fee and public-balance check, a payload cache so a
 * TTL-expired submit retries in seconds at the fast tier, and an in-flight guard so a staged
 * key_switch can never be submitted twice. The work runs in the proof queue.
 */
export function useMigrateBalance(params: {
  address: string;
  walletId: string;
  networkId: string;
  /** Raw micro-OCT. */
  publicRaw: number | null;
  showMessage: (type: "success" | "error" | "info" | "processing", text: string) => void;
  /** Fired when a migration confirms on chain. */
  onMigrated?: () => void;
  /** How the queue names it: a refresh of a balance at the layer limit, or a migration. */
  kind?: "refresh" | "migrate";
}) {
  const { address, walletId, networkId, publicRaw, showMessage, onMigrated, kind } = params;
  const { activeWallet } = useWallet();
  const txAuth = useTransactionAuth();

  const [showPopup, setShowPopup] = useState(false);
  // The wallet and network the popup showed, pinned when it opened.
  const [pinned, setPinned] = useState({ walletId: "", address: "", networkId: "", name: "" });
  const [feeOct, setFeeOct] = useState("");
  const [feeRaw, setFeeRaw] = useState("");
  const [feeFailed, setFeeFailed] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [feeShort, setFeeShort] = useState(false);
  const [reusing, setReusing] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [upgrading, setUpgrading] = useState(false);
  const [progress, setProgress] = useState("");

  /** `stuck` false clears the in-progress state. */
  const resolvePendingRecord = async (stuck: boolean): Promise<boolean> => {
    if (!stuck || !address) {
      setUpgrading(false);
      return false;
    }
    let inFlight = false;
    const rec = getPendingKeySwitch(networkId, address);
    if (rec) {
      const age = Date.now() - rec.submittedAt;
      let status = "";
      try {
        const detail = await networkService.getTransactionDetails(rec.txHash, networkId);
        status = String(detail?.status ?? "").toLowerCase();
      } catch {
        // Unknown: stays in progress within the window.
      }
      const settled = SETTLED_STATUSES.has(status);
      logger.debug(
        "migrate",
        `pending record: tx=${rec.txHash.slice(0, 8)}... status=${status || "unknown"} age=${Math.round(age / 1000)}s -> ${settled ? "settled, clearing" : age >= MIGRATION_PENDING_WINDOW_MS ? "window elapsed, clearing" : "staged, CTA=Upgrade in progress"}`,
      );
      if (settled || age >= MIGRATION_PENDING_WINDOW_MS) {
        // Guarded: a resubmit may have replaced the record while this check awaited.
        clearPendingKeySwitch(networkId, address, rec.txHash);
      } else {
        inFlight = true;
      }
    }
    setUpgrading(inFlight);
    return inFlight;
  };

  // effect:audited - every instance resolves the stored pending record, or only the one that
  // submitted would know a key_switch is staged and the others would offer Migrate again.
  useEffect(() => {
    if (address) void resolvePendingRecord(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, networkId]);

  const open = async () => {
    if (!address || !walletId || verifying) return;
    // A key_switch already in staging means a second submit would burn a fee racing itself.
    try {
      const rec = getPendingKeySwitch(networkId, address);
      if (rec && Date.now() - rec.submittedAt < MIGRATION_PENDING_WINDOW_MS) {
        let status = "";
        try {
          const detail = await networkService.getTransactionDetails(rec.txHash, networkId);
          status = String(detail?.status ?? "").toLowerCase();
        } catch (e) {
          logger.warn(
            "migrate",
            `in-flight lookup failed for ${rec.txHash.slice(0, 8)}... (${e}) - assuming still staged`,
          );
        }
        const settled = SETTLED_STATUSES.has(status);
        logger.info(
          "migrate",
          `in-flight check: tx=${rec.txHash.slice(0, 8)}... age=${Math.round((Date.now() - rec.submittedAt) / 1000)}s status=${status || "unknown"} -> ${settled ? "settled, offering Migrate" : "staged, blocking"}`,
        );
        if (!settled) {
          setUpgrading(true);
          showMessage("info", "A balance upgrade is already staged - waiting for it to confirm");
          return;
        }
        clearPendingKeySwitch(networkId, address, rec.txHash);
      }
    } catch (e) {
      logger.warn("migrate", `in-flight check failed (${e}) - continuing to popup`);
    }
    setPinned({ walletId, address, networkId, name: activeWallet?.name ?? "" });
    setShowPopup(true);
    setRefusal(null);
    const reuse = await cachedPayloadIsLive(address, walletId, networkId);
    setReusing(reuse);
    await quoteFee(reuse, networkId);
  };

  const showFee = (raw: string) => {
    const fee = Number(raw) / 1_000_000;
    setFeeRaw(raw);
    setFeeOct(String(parseFloat(fee.toFixed(6))));
    setFeeShort(publicRaw !== null && publicRaw < Number(raw));
  };

  /** The strict live fee the popup shows and signs. A failed read blocks with Retry. */
  const quoteFee = async (reuse: boolean, net: string) => {
    setFeeRaw("");
    setFeeOct("");
    setFeeShort(false);
    setFeeFailed(false);
    try {
      const raw = await readReviewFee(() => refreshFeeQuote(reuse, net));
      logger.info(
        "migrate",
        `fee quote: ${raw} raw (tier=${reuse ? "fast" : "recommended"}) publicRaw=${publicRaw ?? "?"}`,
      );
      showFee(raw);
    } catch (e) {
      logger.warn("migrate", `fee quote failed (${e}) - blocking until a retry reads it`);
      setFeeFailed(true);
    }
  };

  const retryFee = () => {
    setRefusal(null);
    void quoteFee(reusing, pinned.networkId);
  };

  const scopeError = showPopup
    ? setupScopeError(pinned, { walletId: walletId || null, address: address || null, networkId })
    : null;

  /** Confirm, then Touch ID or password, then the build (or reuse), submit and confirm run in the
   *  proof queue, signing exactly the fee the review showed on the wallet and network it showed. */
  const submit = async () => {
    if (!pinned.address || !pinned.walletId || verifying || !feeRaw || feeFailed || scopeError)
      return;
    const review = { ...pinned, feeRaw, reuse: reusing };
    setRefusal(null);
    if (!(await txAuth.requestAuth("Migrate balance"))) return;
    setVerifying(true);
    setShowPopup(false);
    const id = enqueue({
      kind: kind ?? "refresh",
      scope: { networkId: review.networkId, address: review.address },
      amount: 0,
      steps: STEPS.refresh,
      run: async (step) => {
        const exec = await refreshReviewed(review, publicRaw, {
          onProgress: (msg) => {
            setProgress(msg);
            if (/^Submitting/.test(msg)) step(1);
            else if (/^Confirming/.test(msg)) step(2);
          },
          onSubmitted: () => setUpgrading(true),
        });
        if (exec.status === "rejected") {
          setUpgrading(false);
          throw new Error(`Migration rejected on-chain: ${exec.reason || "unknown reason"}`);
        }
        return { txHash: exec.txHash };
      },
      onDone: () => {
        setVerifying(false);
        setProgress("");
        void resolvePendingRecord(true).then((staged) => {
          if (!staged) onMigrated?.();
        });
      },
      onFail: (err) => {
        setVerifying(false);
        setProgress("");
        if (!(err instanceof SetupReviewError)) {
          logger.error("migrate", `failed: ${err instanceof Error ? err.message : String(err)}`);
          return false;
        }
        logger.info("migrate", `refused before signing: ${err.message}`);
        if (err.liveFeeRaw) showFee(err.liveFeeRaw);
        setRefusal(err.message);
        setShowPopup(true);
        return true;
      },
    });
    showProgress(id);
  };

  return {
    showPopup,
    closePopup: () => setShowPopup(false),
    open,
    submit,
    resolvePendingRecord,
    verifying,
    upgrading,
    progress,
    feeOct,
    feeShort,
    reusing,
    review: {
      walletName: pinned.name,
      address: pinned.address,
      networkId: pinned.networkId,
      feeFailed,
      /** Wallet or network moved, or no fee to sign: Migrate stays off. A refusal does not
       *  block: Migrate then reviews the new fee it shows. */
      blocked: scopeError !== null || feeFailed,
      message: scopeError ?? (feeFailed ? FEE_UNAVAILABLE : refusal),
      retryFee,
      auth: txAuth,
    },
  };
}
