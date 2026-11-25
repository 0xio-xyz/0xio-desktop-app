import { useState, useCallback } from "react";
import { useTranslation } from "src/i18n/react";
import FeePicker from "src/shared/ui/FeePicker";
import ReviewPopup from "src/shared/ui/ReviewPopup";
import { Btn, Caps, EASE, FOCUS, KV, Pair } from "src/shared/ui/look";
import { useReviewFee } from "src/hooks/transactions/useFees";
import { useTransactionAuth } from "src/hooks/transactions/useTransactionAuth";
import TransactionAuthModal from "src/features/wallet/components/TransactionAuthModal";
import { BookUser } from "src/shared/ui/icons";
import AddressBookPicker from "src/features/wallet/components/AddressBookPicker";
import CopyButton from "src/shared/ui/CopyButton";
import LoadingSpinner from "src/shared/ui/LoadingSpinner";
import { useWallet } from "src/contexts/useWallet";
import * as contractService from "src/services/contracts/contractService";
import { captureScope, type TxScope } from "src/services/network/networkService";
import { useTokens } from "src/hooks/wallet/useTokens";
import { truncateAddress, formatTokenAmount } from "src/lib/format";
import { validateContractAddress } from "src/features/contracts/hooks/useContractInteraction";

function TokenLogo({ symbol, logoURI }: { symbol: string; logoURI?: string }) {
  const [imgError, setImgError] = useState(false);

  if (logoURI && !imgError) {
    return (
      <img
        src={logoURI}
        alt={symbol}
        className="w-9 h-9 rounded-full object-cover"
        onError={() => setImgError(true)}
      />
    );
  }

  return (
    <div
      className="w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold"
      style={{ color: "var(--text-content)" }}
    >
      {symbol.charAt(0).toUpperCase()}
    </div>
  );
}

export default function TokensTab() {
  const { t } = useTranslation();
  const { activeWallet, showMessage } = useWallet();
  const { tokens, isLoading, refetch } = useTokens();

  const [transferTarget, setTransferTarget] = useState<string | null>(null);
  const [showPicker, setShowPicker] = useState(false);
  const [recipient, setRecipient] = useState("");
  const [transferAmount, setTransferAmount] = useState("");
  const fee = useReviewFee("call", "token_transfer");
  const txAuth = useTransactionAuth();
  const [review, setReview] = useState<{
    contract: string;
    symbol: string;
    decimals: number;
    to: string;
    amount: string;
    scope: TxScope;
  } | null>(null);
  const [transferring, setTransferring] = useState(false);

  const walletId = activeWallet?.id ?? "";

  const recipientError = (() => {
    const trimmed = recipient.trim();
    if (!trimmed) return null;
    return validateContractAddress(trimmed);
  })();

  const openReview = useCallback(
    (contract: string, symbol: string, decimals: number) => {
      if (!activeWallet) return;
      if (!recipient.trim() || !transferAmount.trim()) {
        showMessage("error", t("contracts.tokens.needBoth"));
        return;
      }
      const addrErr = validateContractAddress(recipient.trim());
      if (addrErr) {
        showMessage("error", addrErr);
        return;
      }
      if (!/^\d+$/.test(transferAmount.trim()) || /^0+$/.test(transferAmount.trim())) {
        showMessage("error", t("contracts.tokens.wholeNumber"));
        return;
      }
      fee.recheck.setError("");
      setReview({
        contract,
        symbol,
        decimals,
        to: recipient.trim(),
        amount: transferAmount.trim(),
        scope: captureScope(activeWallet.address),
      });
    },
    [activeWallet, recipient, transferAmount, showMessage, fee.recheck, t],
  );

  const confirmTransfer = useCallback(async () => {
    if (!activeWallet || !review || transferring || fee.quote.status !== "ok" || !fee.ou) return;
    if (await fee.recheck.check(review.scope.networkId, fee.ou)) return;
    if (!(await txAuth.requestAuth(t("send.confirmTokenTransfer", { symbol: review.symbol }))))
      return;
    setReview(null);
    setTransferring(true);
    try {
      const txHash = await contractService.callContract({
        contract: review.contract,
        method: "transfer",
        params: [review.to, review.amount],
        from: activeWallet.address,
        walletId,
        ou: fee.ou,
        scope: review.scope,
      });
      showMessage(
        "success",
        t("contracts.tokens.submitted", { hash: truncateAddress(txHash, 8, 6) }),
      );
      setTransferTarget(null);
      setRecipient("");
      setTransferAmount("");
      setTimeout(() => refetch(), 3000);
    } catch (err) {
      showMessage("error", err instanceof Error ? err.message : t("nft.transferFailed"));
    } finally {
      setTransferring(false);
    }
  }, [
    activeWallet,
    review,
    transferring,
    fee.quote.status,
    fee.ou,
    fee.recheck,
    walletId,
    showMessage,
    refetch,
    t,
  ]);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Caps>{t("contracts.tokens.title")}</Caps>
        <Btn weight="text" size="sm" onClick={() => refetch()} disabled={isLoading}>
          {t("contracts.tokens.refresh")}
        </Btn>
      </div>

      {isLoading && tokens.length === 0 && <LoadingSpinner />}

      {!isLoading && tokens.length === 0 && (
        <p className="py-10 text-center text-meta text-content-muted">
          {t("contracts.tokens.none")}
        </p>
      )}

      {tokens.map((token) => (
        <div
          key={token.contractAddress}
          className="rounded-2xl px-4 py-3.5 hover:bg-surface-highlight/50"
        >
          <div className="flex items-center justify-between gap-4">
            <div className="flex min-w-0 items-center gap-3">
              <TokenLogo symbol={token.symbol} logoURI={token.logoURI} />
              <div className="min-w-0">
                <p className="truncate text-body font-semibold text-content">{token.symbol}</p>
                <p className="truncate text-meta text-content-muted">{token.name}</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <div className="text-right">
                <p className="font-mono text-body font-semibold text-content">
                  {formatTokenAmount(token.balance, token.decimals)}
                </p>
                <span className="inline-flex items-center gap-1 font-mono text-micro text-content-muted">
                  {truncateAddress(token.contractAddress)}
                  <CopyButton text={token.contractAddress} size={10} />
                </span>
              </div>
              {transferTarget !== token.contractAddress && (
                <Btn size="sm" onClick={() => setTransferTarget(token.contractAddress)}>
                  {t("contracts.tokens.transfer")}
                </Btn>
              )}
            </div>
          </div>

          {transferTarget === token.contractAddress && (
            <div className="mt-3 space-y-2">
              <div className="flex h-11.5 items-center gap-1 rounded-xl bg-surface-highlight pr-1.5 pl-4">
                <input
                  value={recipient}
                  onChange={(e) => setRecipient(e.target.value)}
                  placeholder="oct..."
                  aria-label={t("sendFlow.recipient")}
                  className="min-w-0 flex-1 bg-transparent font-mono text-meta text-content placeholder:text-content-muted focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => setShowPicker(true)}
                  aria-label={t("nav.addressBook")}
                  className={`grid size-8.5 cursor-pointer place-items-center rounded-full text-content-muted hover:bg-(--bg-3) hover:text-content ${EASE} ${FOCUS}`}
                >
                  <BookUser size={15} />
                </button>
              </div>
              <p role="alert" className="min-h-5 text-[0.8125rem] text-danger">
                {recipientError ?? ""}
              </p>
              <input
                value={transferAmount}
                onChange={(e) => setTransferAmount(e.target.value)}
                placeholder={t("contracts.tokens.amountRaw", { decimals: token.decimals })}
                aria-label={t("sendFlow.amount")}
                inputMode="numeric"
                className="h-11.5 w-full rounded-xl bg-surface-highlight px-4 font-mono text-meta text-content placeholder:text-content-muted focus:outline-none"
              />
              <KV label={t("sendFlow.networkFee")}>
                <FeePicker quote={fee.quote} ou={fee.ou} onChange={fee.setOU} />
              </KV>
              <Pair
                left={<Btn onClick={() => setTransferTarget(null)}>{t("common.cancel")}</Btn>}
                right={
                  <Btn
                    weight="primary"
                    onClick={() => openReview(token.contractAddress, token.symbol, token.decimals)}
                    disabled={transferring || !recipient.trim() || !transferAmount.trim()}
                  >
                    {t("contracts.tokens.review")}
                  </Btn>
                }
              />
            </div>
          )}
        </div>
      ))}

      <ReviewPopup
        open={!!review}
        label={t("nft.reviewTitle")}
        caption={t("nft.reviewTitle")}
        verb={t("common.send")}
        onReject={() => !fee.recheck.checking && setReview(null)}
        onConfirm={() => void confirmTransfer()}
        confirmDisabled={fee.quote.status !== "ok" || !fee.ou}
        busy={fee.recheck.checking}
        error={fee.recheck.error}
      >
        {review && (
          <>
            <KV label={t("contracts.tokens.token")}>{review.symbol}</KV>
            <KV label={t("sendFlow.to")}>
              <span className="font-mono text-meta">{truncateAddress(review.to, 12, 8)}</span>
            </KV>
            <KV label={t("sendFlow.amount")}>
              {formatTokenAmount(review.amount, review.decimals)} {review.symbol}
            </KV>
            <KV label={t("sendFlow.networkFee")}>
              <FeePicker
                quote={fee.quote}
                ou={fee.ou}
                onChange={fee.setOU}
                disabled={fee.recheck.checking}
              />
            </KV>
          </>
        )}
      </ReviewPopup>

      <TransactionAuthModal
        isOpen={txAuth.isOpen}
        onResult={txAuth.handleResult}
        title={txAuth.title}
      />

      {showPicker && (
        <AddressBookPicker
          onSelect={(addr) => {
            setRecipient(addr);
            setShowPicker(false);
          }}
          onClose={() => setShowPicker(false)}
        />
      )}
    </div>
  );
}
