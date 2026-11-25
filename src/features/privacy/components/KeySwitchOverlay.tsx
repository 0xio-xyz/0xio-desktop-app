import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "src/lib/query";
import { useWallet } from "src/contexts/useWallet";
import { Row } from "src/shared/ui/flat";
import TransactionAuthModal from "src/features/wallet/components/TransactionAuthModal";
import { useTransactionAuth } from "src/hooks/transactions/useTransactionAuth";
import { keySwitchModeQuery, keyUpdateReviewed } from "src/features/privacy/services/keyUpdate";
import {
  keyModeSignal,
  keyUpdateMovesBalance,
} from "src/features/privacy/services/keyUpdatePolicy";
import { SetupReviewError, readSetupFee } from "src/features/privacy/services/setupReview";
import { NETWORKS } from "src/services/network/config";
import { FEE_UNAVAILABLE } from "src/services/transactions/feeCopy";
import { formatOCT, truncateAddress } from "src/lib/format";
import { logger } from "src/lib/logger";
import {
  loadBlockedAck,
  saveBlockedAck,
  clearBlockedAck,
} from "src/features/privacy/services/keySwitchService";
import { feeText } from "src/services/transactions/feeText";
import { recordDone } from "src/features/privacy/services/proofQueue";

const KEY_UPDATE_FEE_QUERY = "keyUpdateFee";

export default function KeySwitchOverlay() {
  const { pvacForeign, setPvacForeign, activeWallet, showMessage, networkId } = useWallet();
  const qc = useQueryClient();
  const txAuth = useTransactionAuth();
  const [isKeySwitching, setIsKeySwitching] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const address = activeWallet?.address;
  const walletId = activeWallet?.id;
  const net = networkId ?? "";

  const { data: mode } = useQuery({
    ...keySwitchModeQuery({ id: walletId ?? "", address: address ?? "" }, net),
    enabled: !!address && !!walletId && pvacForeign,
  });

  const blockedReason = mode?.mode === "blocked" ? mode.reason : null;
  const blocked = blockedReason != null;
  const unavailable = mode?.mode === "key_bound_unavailable";
  const keyCurrent = mode?.mode === "key_bound_unavailable" && mode.keyCurrent;
  const unactionable = blocked || unavailable;
  const ackReason = blockedReason ?? (unavailable ? "key_bound_unavailable" : null);
  const acked = address ? loadBlockedAck(net, address) != null : false;
  // The ack covers the unactionable state, not the reason: the node flip-flops its reason while
  // its history index is incomplete, so a reason-keyed ack would re-nag on every change.
  const suppressedByAck = unactionable && acked;
  const signal = mode ? keyModeSignal(mode) : null;
  const update = signal?.kind === "update" ? signal : null;

  const feeKey = [KEY_UPDATE_FEE_QUERY, net, address ?? ""];
  const fee = useQuery({
    queryKey: feeKey,
    enabled: !!address && pvacForeign && !!update,
    queryFn: () => readSetupFee(net),
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const feeRaw = fee.data ?? null;
  const feeFailed = fee.isError && !fee.isFetching;

  // effect:audited - reacts to the async mode query: fold an acknowledged unactionable state back to
  useEffect(() => {
    if (!address || !mode) return;
    if (suppressedByAck) {
      setPvacForeign(false);
    } else if (acked && !unactionable) {
      clearBlockedAck(net, address);
    }
  }, [address, net, mode, unactionable, acked, suppressedByAck, setPvacForeign]);

  const handleDismiss = () => {
    if (isKeySwitching || txAuth.isOpen) return;
    if (ackReason != null && address) {
      saveBlockedAck(net, address, ackReason);
    }
    setPvacForeign(false);
    setConfirmed(false);
    setError(null);
  };

  // effect:audited - Escape closes the dialog, the keyboard pair of clicking the backdrop.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") handleDismiss();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  if (!pvacForeign || suppressedByAck) return null;
  // Never render before the mode resolves: the default copy is the actionable one, wrong for a
  // held account, and a dismiss in that window records no ack, so it would re-nag forever.
  if (!mode) return null;

  const migrating = !!update && keyUpdateMovesBalance(update.mode);
  const migrationAmount = migrating && update ? update.amountMicro : 0;
  const message = feeFailed ? FEE_UNAVAILABLE : error;

  const retryFee = () => {
    setError(null);
    void fee.refetch();
  };

  const handleKeySwitch = async () => {
    if (!activeWallet) {
      showMessage("error", "No active wallet");
      return;
    }
    if (!update || !feeRaw || feeFailed) return;
    // Everything the review showed, pinned at confirm: the fee signed is this one or none.
    const review = {
      walletId: activeWallet.id,
      address: activeWallet.address,
      networkId: net,
      feeRaw,
      expect: { mode: update.mode, amountMicro: update.amountMicro },
    };
    setError(null);
    if (!(await txAuth.requestAuth("Update encryption key"))) return;
    setIsKeySwitching(true);
    try {
      logger.info("keySwitch", `Starting key switch for ${review.address.slice(0, 8)}...`);
      const publicRaw =
        qc.getQueryData<{ balance: number }>(["balance", review.address, review.networkId])
          ?.balance ?? null;
      const { txHash } = await keyUpdateReviewed(review, publicRaw);

      logger.info("keySwitch", `Key switch broadcast OK -> ${txHash} (ou=${review.feeRaw})`);
      recordDone({ networkId: review.networkId, address: review.address }, "keyUpdate", 0);
      setPvacForeign(false);
      setConfirmed(false);
      void qc.invalidateQueries({
        queryKey: ["keySwitchMode", review.address, review.networkId],
      });
    } catch (err) {
      if (err instanceof SetupReviewError && err.liveFeeRaw)
        qc.setQueryData(feeKey, err.liveFeeRaw);
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("keySwitch", `Key switch failed: ${msg}`);
      // Shown inside the overlay: toasts render behind this modal's backdrop.
      setError(msg);
    } finally {
      setIsKeySwitching(false);
    }
  };

  // The auth prompt renders in the content area, below this dialog's layer: show it alone.
  if (txAuth.isOpen) {
    return <TransactionAuthModal isOpen onResult={txAuth.handleResult} title={txAuth.title} />;
  }

  const verbOff = isKeySwitching || !confirmed || !feeRaw || fee.isFetching;
  return (
    <div
      // Clicking the backdrop dismisses exactly like Not now: mousedown rather than click, so a
      // selection dragged out of the dialog does not count as clicking outside it.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) handleDismiss();
      }}
      className="fixed inset-0 z-100 flex items-center justify-center bg-black/70 backdrop-blur-sm animate-in fade-in duration-200"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="key-switch-title"
        className="relative w-100 rounded-[22px] bg-surface-card p-6 shadow-2xl animate-in zoom-in-95 duration-200 motion-reduce:animate-none"
      >
        <div className="flex flex-col gap-5">
          <div>
            <h3 id="key-switch-title" className="mb-2 text-base font-semibold text-content">
              {keyCurrent
                ? "Private balance awaiting migration"
                : unactionable
                  ? "Encryption key update on hold"
                  : "Encryption key update required"}
            </h3>
            <p className="text-sm leading-relaxed text-content-secondary">
              {keyCurrent
                ? "Your encryption key is fine. This account's private balance was sealed under the network's previous scheme and waits for a network migration."
                : unactionable
                  ? "The network moved to a new encryption scheme, but this account can't be updated yet."
                  : "The network upgraded its encryption scheme. Your key must be re-registered before you can encrypt or decrypt."}
            </p>
          </div>

          {blocked && mode?.mode === "blocked" && (
            <div className="w-full rounded-2xl bg-surface p-4 text-left">
              <p className="mb-1 text-xs font-semibold text-content">
                Can't update this account yet
              </p>
              <p className="text-xs leading-relaxed text-content-secondary">{mode.reason}</p>
              <p className="mt-2 text-xs leading-relaxed text-content-muted">
                The node won't process a key update for this account until it resolves the state
                above. Your balances stay readable in the wallet; nothing is lost. Check back later.
              </p>
            </div>
          )}

          {unavailable && (
            <div className="w-full rounded-2xl bg-surface p-4 text-left">
              <p className="mb-1 text-xs font-semibold text-content">
                {keyCurrent ? "Waiting on the network" : "Not available in the app yet"}
              </p>
              <p className="text-xs leading-relaxed text-content-muted">
                {keyCurrent
                  ? "Your key is registered and current - nothing is wrong with it. The private balance itself needs a key-bound migration (equality proofs) that the network hasn't opened to wallets yet, and the node currently refuses key updates for this account. Your public balance is unaffected and nothing is lost in the meantime."
                  : "This account's private balance is locked to the network's previous encryption scheme and needs a key-bound migration to move to the new one. That migration isn't available in the 0xio wallet yet (including 0xio Desktop) - it's planned for a future update. Your public balance is unaffected and nothing is lost in the meantime."}
              </p>
            </div>
          )}

          {migrating && (
            <div className="w-full rounded-2xl bg-surface p-4 text-left">
              <p className="mb-1 text-xs font-semibold text-content">
                Private balance migrates with it
              </p>
              <p className="text-xs leading-relaxed text-content-secondary">
                Your private balance of {formatOCT(migrationAmount)} OCT is re-encrypted under the
                new key inside the same transaction. Nothing is lost.
              </p>
            </div>
          )}

          {update && activeWallet && (
            <div className="w-full rounded-2xl bg-surface px-5 py-3 text-left">
              <Row
                label="Wallet"
                value={activeWallet.name || truncateAddress(activeWallet.address)}
                mono={false}
              />
              <Row label="Address" value={truncateAddress(activeWallet.address)} />
              <Row label="Network" value={NETWORKS[net]?.name ?? net} mono={false} />
              <Row
                label="Network fee"
                value={feeRaw !== null ? `${formatOCT(Number(feeRaw))} OCT` : "..."}
                tone={feeRaw !== null ? "default" : "muted"}
              />
            </div>
          )}

          {message && (
            <p
              role="alert"
              className="w-full text-left text-xs leading-relaxed wrap-break-word text-content"
            >
              {feeText(message)}
            </p>
          )}

          {!unactionable && (
            <label className="flex w-full cursor-pointer items-start gap-2 text-left">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
                className="mt-0.5 cursor-pointer accent-(--fg)"
                disabled={isKeySwitching}
              />
              <span className="text-xs leading-relaxed text-content-muted">
                {migrating
                  ? "I understand my key will be re-registered and my private balance migrated in one transaction."
                  : "I understand my encryption key will be re-registered on-chain."}
              </span>
            </label>
          )}

          <div className={unactionable ? "" : "grid grid-cols-2 gap-2.5"}>
            <button
              onClick={handleDismiss}
              disabled={isKeySwitching}
              className="h-11.5 w-full cursor-pointer rounded-full bg-surface-highlight text-sm font-semibold text-content transition-colors duration-200 ease-out hover:opacity-90 disabled:cursor-default disabled:opacity-40"
            >
              {unactionable ? "Close" : "Not now"}
            </button>
            {!unactionable && feeFailed && (
              <button
                onClick={retryFee}
                className="h-11.5 w-full cursor-pointer rounded-full bg-content text-sm font-semibold text-surface transition-opacity duration-200 ease-out hover:opacity-90"
              >
                Retry
              </button>
            )}
            {!unactionable && !feeFailed && (
              <button
                onClick={handleKeySwitch}
                disabled={verbOff}
                className="h-11.5 w-full cursor-pointer rounded-full bg-content text-sm font-semibold text-surface transition-opacity duration-200 ease-out hover:opacity-90 disabled:cursor-default disabled:opacity-40"
              >
                {isKeySwitching
                  ? migrating
                    ? "Migrating and switching key"
                    : "Switching key"
                  : migrating
                    ? "Migrate Balance & Switch Key"
                    : "Switch Encryption Key"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
