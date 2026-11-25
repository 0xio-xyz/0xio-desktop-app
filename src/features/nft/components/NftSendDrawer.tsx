import { useState, useRef } from "react";
import { useTranslation } from "src/i18n/react";
import { BookUser } from "src/shared/ui/icons";
import NftDrawer from "src/features/nft/components/NftDrawer";
import Mascot from "src/shared/ui/Mascot";
import AddressBookPicker from "src/features/wallet/components/AddressBookPicker";
import TransactionAuthModal from "src/features/wallet/components/TransactionAuthModal";
import FeePicker from "src/shared/ui/FeePicker";
import { Btn, Caps, EASE, FOCUS, KV, Pair } from "src/shared/ui/look";
import { useReviewFee } from "src/hooks/transactions/useFees";
import { feeText } from "src/services/transactions/feeText";
import { captureScope, jsonRpcCall } from "src/services/network/networkService";
import { callContract } from "src/services/contracts/contractService";
import { useTransactionAuth } from "src/hooks/transactions/useTransactionAuth";
import { isLivingProgramUri } from "src/features/nft/services/euint/protocol";
import { type NftTokenDetail, nftDisplayName } from "src/features/nft/services/data";
import { truncateAddress } from "src/lib/format";
import { logger } from "src/lib/logger";

type Step = "form" | "review" | "sending" | "success";

interface NftSendDrawerProps {
  open: boolean;
  onClose: () => void;
  detail: NftTokenDetail;
  collectionName: string;
  contractAddress: string;
  walletAddress: string;
  walletId: string;
  onSent: () => void;
}

export default function NftSendDrawer({
  open,
  onClose,
  detail,
  collectionName,
  contractAddress,
  walletAddress,
  walletId,
  onSent,
}: NftSendDrawerProps) {
  const { t } = useTranslation();
  const txAuth = useTransactionAuth();
  const [step, setStep] = useState<Step>("form");
  const [recipient, setRecipient] = useState("");
  const fee = useReviewFee("call", "nft_send");
  const [error, setError] = useState("");
  const [showPicker, setShowPicker] = useState(false);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [copiedTx, setCopiedTx] = useState(false);
  const inFlightRef = useRef(false);

  const trimmed = recipient.trim();
  const valid = trimmed.startsWith("oct") && trimmed.length === 47;
  const toShort = trimmed ? truncateAddress(trimmed, 10, 6) : "-";
  const displayName = nftDisplayName(detail);
  const living = isLivingProgramUri(detail.animationUrl);

  const reset = () => {
    setStep("form");
    setRecipient("");
    setError("");
    setTxHash(null);
    setCopiedTx(false);
    fee.recheck.setError("");
  };

  const close = () => {
    const sent = step === "success";
    reset();
    onClose();
    if (sent) onSent();
  };

  const handleConfirm = async () => {
    if (inFlightRef.current || fee.quote.status !== "ok" || !fee.ou) return;
    const scope = captureScope(walletAddress);
    if (await fee.recheck.check(scope.networkId, fee.ou)) return;
    const ou = fee.ou;
    const approved = await txAuth.requestAuth(t("nft.confirmTransfer"));
    if (!approved) return;
    inFlightRef.current = true;
    setStep("sending");
    setError("");
    try {
      let method = "transfer";
      let params: (string | number)[] = [trimmed, parseInt(detail.tokenId)];
      try {
        const abi = (await jsonRpcCall("octra_contractAbi", [contractAddress])) as {
          methods?: { name: string }[];
        } | null;
        const methods = (abi?.methods || []).map((m) => m.name);
        if (methods.includes("transfer")) {
          method = "transfer";
          params = [trimmed, parseInt(detail.tokenId)];
        } else if (methods.includes("transfer_to")) {
          method = "transfer_to";
          params = [trimmed];
        }
        logger.info("nft", `Transfer using ${method}() - ABI has ${methods.length} methods`);
      } catch {
        logger.debug("nft", "ABI fetch failed, defaulting to transfer()");
      }
      const hash = await callContract({
        contract: contractAddress,
        method,
        params,
        from: walletAddress,
        walletId,
        ou,
        scope,
      });
      setTxHash(hash);
      setStep("success");
    } catch (err) {
      logger.error("nft", `Transfer failed: ${err}`);
      setError(err instanceof Error ? err.message : t("nft.transferFailed"));
      setStep("form");
    } finally {
      inFlightRef.current = false;
    }
  };

  const assetChip = (
    <div className="mb-5 flex items-center gap-3.5 rounded-2xl bg-surface-highlight p-3">
      <div className="grid size-13 shrink-0 place-items-center overflow-hidden rounded-xl bg-(--bg-3)">
        {living ? (
          <span className="text-micro font-semibold tracking-widest text-content-secondary">
            {t("nft.live")}
          </span>
        ) : detail.image ? (
          <img src={detail.image} alt={displayName} className="size-full object-cover" />
        ) : (
          <span className="font-mono text-micro text-content-muted">#{detail.tokenId}</span>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-body font-semibold text-content">{displayName}</p>
        <p className="truncate text-meta text-content-muted">
          {collectionName} #{detail.tokenId}
        </p>
      </div>
    </div>
  );

  const stepTitle =
    step === "form"
      ? t("nft.transferTitle")
      : step === "review"
        ? t("nft.reviewTitle")
        : step === "sending"
          ? t("nft.transferring")
          : t("nft.transferred");

  return (
    <>
      <NftDrawer open={open} title={stepTitle} onClose={close}>
        {step === "form" && (
          <div>
            {assetChip}
            <Caps>{t("sendFlow.recipient")}</Caps>
            <div className="mt-2.5 flex h-11.5 items-center gap-1 rounded-xl bg-surface-highlight pr-1.5 pl-4">
              <input
                value={recipient}
                onChange={(e) => {
                  setRecipient(e.target.value);
                  setError("");
                }}
                placeholder="oct..."
                aria-label={t("sendFlow.recipient")}
                autoComplete="off"
                spellCheck={false}
                className="min-w-0 flex-1 bg-transparent font-mono text-[0.8125rem] text-content placeholder:text-content-muted focus:outline-none"
              />
              <button
                type="button"
                onClick={() => setShowPicker(true)}
                aria-label={t("nav.addressBook")}
                className={`grid size-8.5 cursor-pointer place-items-center rounded-full text-content-muted hover:bg-(--bg-3) hover:text-content ${EASE} ${FOCUS}`}
              >
                <BookUser size={15} />
              </button>
              <Btn
                size="sm"
                onClick={async () => {
                  try {
                    const text = await navigator.clipboard.readText();
                    if (text) {
                      setRecipient(text.trim());
                      setError("");
                    }
                  } catch {}
                }}
              >
                {t("nft.paste")}
              </Btn>
            </div>
            <p role="alert" className="mt-2 min-h-5 text-[0.8125rem] text-danger">
              {error || (trimmed && !valid ? t("addressBook.invalidPrefix") : "")}
            </p>

            <KV label={t("sendFlow.networkFee")} className="mt-1">
              <FeePicker quote={fee.quote} ou={fee.ou} onChange={fee.setOU} />
            </KV>

            <Btn
              weight="primary"
              className="look-key mt-5 w-full"
              onClick={() => valid && setStep("review")}
              disabled={!valid}
            >
              {t("nft.reviewTitle")}
            </Btn>
          </div>
        )}

        {step === "review" && (
          <div>
            {assetChip}
            <KV label={t("sendFlow.from")}>
              <span className="font-mono text-meta">{truncateAddress(walletAddress, 10, 6)}</span>
            </KV>
            <KV label={t("sendFlow.to")}>
              <span className="font-mono text-meta">{toShort}</span>
            </KV>
            <KV label={t("sendFlow.networkFee")}>
              <FeePicker
                quote={fee.quote}
                ou={fee.ou}
                onChange={fee.setOU}
                disabled={fee.recheck.checking}
              />
            </KV>
            <p
              role={fee.recheck.error ? "alert" : undefined}
              className="mt-2 min-h-5 text-[0.8125rem] text-danger"
            >
              {feeText(fee.recheck.error)}
            </p>
            <Pair
              className="mt-3"
              left={
                <Btn
                  onClick={() => {
                    fee.recheck.setError("");
                    setStep("form");
                  }}
                  disabled={fee.recheck.checking}
                >
                  {t("common.reject")}
                </Btn>
              }
              right={
                <Btn
                  weight="primary"
                  onClick={() => void handleConfirm()}
                  disabled={fee.quote.status !== "ok" || !fee.ou || fee.recheck.checking}
                >
                  {t("nft.transfer")}
                </Btn>
              }
            />
          </div>
        )}

        {step === "sending" && (
          <div className="flex flex-col items-center py-17.5 text-center">
            <Mascot id="nft-sending" phase="ld" size={64} />
            <p className="mt-5 text-lead font-semibold text-content">{t("nft.transferring")}</p>
          </div>
        )}

        {step === "success" && (
          <div className="flex flex-col items-center py-14 text-center animate-in fade-in-0 zoom-in-95 duration-250 ease-out motion-reduce:animate-none">
            <Mascot id="nft-sent" phase="ok" size={76} />
            <p className="mt-4.5 text-lead font-semibold text-content">{t("nft.transferred")}</p>
            <p className="mt-1.5 font-mono text-meta text-content-muted">{toShort}</p>
            {txHash && (
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard.writeText(txHash);
                  setCopiedTx(true);
                  setTimeout(() => setCopiedTx(false), 2000);
                }}
                className={`mt-4 inline-flex h-8 cursor-pointer items-center gap-2 rounded-full bg-surface-highlight px-3 font-mono text-micro text-content-secondary hover:text-content ${EASE} ${FOCUS}`}
              >
                {copiedTx ? t("common.copied") : truncateAddress(txHash, 6, 4)}
              </button>
            )}
            <Btn weight="primary" className="look-key mt-6 w-full" onClick={close}>
              {t("nft.done")}
            </Btn>
          </div>
        )}
      </NftDrawer>

      {showPicker && (
        <AddressBookPicker
          onSelect={(addr) => {
            setRecipient(addr);
            setError("");
            setShowPicker(false);
          }}
          onClose={() => setShowPicker(false)}
        />
      )}

      <TransactionAuthModal
        isOpen={txAuth.isOpen}
        onResult={txAuth.handleResult}
        title={txAuth.title}
      />
    </>
  );
}
