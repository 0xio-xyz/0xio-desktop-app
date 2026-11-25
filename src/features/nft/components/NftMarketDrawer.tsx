// Changing a price cancels, approves again when needed and relists: up to three signatures, all
// shown on the review before anything is signed.
import { useRef, useState } from "react";
import { useTranslation } from "src/i18n/react";
import NftDrawer from "src/features/nft/components/NftDrawer";
import TransactionAuthModal from "src/features/wallet/components/TransactionAuthModal";
import { captureScope } from "src/services/network/networkService";
import { ReviewFee } from "src/features/wallet/components/FeeStatusValue";
import { Btn, KV, Pair } from "src/shared/ui/look";
import { recheckReviewedFee, type FeeQuote } from "src/hooks/transactions/useFees";
import { feeText } from "src/services/transactions/feeText";
import { useTransactionAuth } from "src/hooks/transactions/useTransactionAuth";
import { MICRO_OCT } from "src/features/nft/services/xpectrum/config";
import { isApprovedFor, type Listing } from "src/features/nft/services/xpectrum/market";
import {
  listNft,
  cancelListing,
  approve as approveMarket,
} from "src/features/nft/services/xpectrum/tx";
import { waitForReceipt } from "src/features/nft/services/xpectrum/confirm";
import { type NftTokenDetail, nftDisplayName } from "src/features/nft/services/data";
import { logger } from "src/lib/logger";

export type MarketMode = "list" | "reprice" | "cancel";
type Stage = "price" | "review" | "running" | "done" | "failed";
type Op = "cancel" | "approve" | "list" | "verify";

const OP_LABEL: Record<Op, string> = {
  cancel: "nft.market.opCancel",
  approve: "nft.market.opApprove",
  list: "nft.market.opList",
  verify: "nft.market.opVerify",
};

const TITLE: Record<MarketMode, string> = {
  list: "nft.market.list",
  reprice: "nft.market.reprice",
  cancel: "nft.market.cancel",
};

const fmtOct = (n: number) => `${parseFloat(n.toFixed(6))} OCT`;

interface Props {
  mode: MarketMode | null;
  onClose: () => void;
  detail: NftTokenDetail;
  thumb: string | null;
  collectionName: string;
  contract: string;
  tokenId: string;
  market: string;
  listing: Listing | null;
  approved: boolean | null;
  octUsd: number | null;
  wallet: { address: string; id: string };
  ou: string;
  feeQuote: FeeQuote;
  refreshListing: () => Promise<Listing | null>;
  onApproved: () => void;
  onDone: (message: string) => void;
}

export default function NftMarketDrawer(props: Props) {
  if (!props.mode) return null;
  return <MarketFlow key={props.mode} {...props} mode={props.mode} />;
}

function MarketFlow({
  mode,
  onClose,
  detail,
  thumb,
  collectionName,
  contract,
  tokenId,
  market,
  listing,
  approved,
  octUsd,
  wallet,
  ou,
  feeQuote,
  refreshListing,
  onApproved,
  onDone,
}: Props & { mode: MarketMode }) {
  const { t } = useTranslation();
  const txAuth = useTransactionAuth();
  const [stage, setStage] = useState<Stage>(mode === "cancel" ? "review" : "price");
  const [entered, setEntered] = useState("");
  const [currency, setCurrency] = useState<"OCT" | "USD">("OCT");
  const [error, setError] = useState("");
  const [current, setCurrent] = useState<Op | null>(null);
  const [needApprove, setNeedApprove] = useState(approved !== true);
  const inFlight = useRef(false);

  const name = nftDisplayName(detail);
  const n = parseFloat(entered);
  const priceOct =
    Number.isFinite(n) && n > 0 ? (currency === "USD" && octUsd ? n / octUsd : n) : null;
  const ops: Op[] =
    mode === "cancel"
      ? ["cancel", "verify"]
      : [
          ...(mode === "reprice" ? (["cancel"] as Op[]) : []),
          ...(needApprove ? (["approve"] as Op[]) : []),
          "list",
          "verify",
        ];
  const signatures = ops.filter((o) => o !== "verify").length;
  const busy = stage === "running";

  const toReview = async () => {
    if (priceOct == null) {
      setError(t("nft.market.enterPrice", { currency }));
      return;
    }
    // A cancel clears the market's approval, so a new price always approves again.
    if (mode === "list" && approved !== true) {
      const a = await isApprovedFor(contract, parseInt(tokenId), market).catch(() => false);
      setNeedApprove(!a);
    } else if (mode === "reprice") {
      setNeedApprove(true);
    }
    setError("");
    setStage("review");
  };

  const run = async () => {
    if (inFlight.current || feeQuote.status !== "ok" || !ou) return;
    const scope = captureScope(wallet.address);
    inFlight.current = true;
    const recheck = await recheckReviewedFee("call", scope.networkId, ou).finally(() => {
      inFlight.current = false;
    });
    if (recheck.error) {
      feeQuote.retry();
      setError(recheck.error);
      return;
    }
    const ok = await txAuth.requestAuth(t(TITLE[mode]));
    if (!ok) return;
    inFlight.current = true;
    setStage("running");
    setError("");
    const ctx = { from: wallet.address, walletId: wallet.id, ou, scope };
    const tid = parseInt(tokenId);
    const settle = async (hash: string, what: string) => {
      const rec = await waitForReceipt(hash);
      if (rec.status !== "confirmed") throw new Error(rec.reason || `${what} ${rec.status}`);
    };
    try {
      for (const op of ops) {
        setCurrent(op);
        if (op === "cancel") {
          if (!listing) throw new Error(t("nft.market.notListed"));
          await settle(await cancelListing(ctx, market, listing.id), "Cancel");
          if (mode === "cancel") {
            // Confirmed is not executed: the listing must be gone.
            if (await refreshListing()) throw new Error(t("nft.market.stillActive"));
          }
        } else if (op === "approve") {
          // After a cancel the market may still hold the approval: no signature then.
          if (await isApprovedFor(contract, tid, market).catch(() => false)) continue;
          await settle(await approveMarket(ctx, contract, market, tid), "Approval");
          onApproved();
        } else if (op === "list") {
          await settle(
            await listNft(ctx, market, contract, tid, Math.round(priceOct! * MICRO_OCT)),
            "Listing",
          );
        } else if (op === "verify" && mode !== "cancel") {
          if (!(await refreshListing())) throw new Error(t("nft.market.noEffect"));
        }
      }
      setCurrent(null);
      setStage("done");
    } catch (e) {
      logger.error("nft", `${mode} failed: ${e}`);
      setError(e instanceof Error ? e.message : t("nft.market.failed"));
      setStage("failed");
      // A step may have landed before the failure (a cancel before a failed relist).
      void refreshListing();
    } finally {
      inFlight.current = false;
    }
  };

  const close = () => {
    if (busy) return;
    if (stage === "done")
      onDone(
        mode === "cancel"
          ? t("nft.market.cancelled")
          : t("nft.market.listedAt", { price: fmtOct(priceOct ?? 0) }),
      );
    onClose();
  };

  return (
    <NftDrawer open title={t(TITLE[mode])} onClose={close}>
      <div className="mb-6 flex items-center gap-3.5">
        <div className="size-12 shrink-0 overflow-hidden rounded-xl bg-surface-highlight">
          {thumb && <img src={thumb} alt="" className="size-full object-cover" />}
        </div>
        <div className="min-w-0">
          <p className="truncate text-body font-semibold text-content">{name}</p>
          <p className="truncate text-meta text-content-muted">{collectionName}</p>
        </div>
      </div>

      {stage === "price" && (
        <div>
          <div className="flex flex-col items-center py-4">
            <div className="flex items-baseline gap-2">
              <input
                value={entered}
                onChange={(e) => {
                  setEntered(e.target.value.replace(/[^0-9.]/g, ""));
                  setError("");
                }}
                onKeyDown={(e) => e.key === "Enter" && void toReview()}
                placeholder="0"
                aria-label={t("nft.market.price")}
                inputMode="decimal"
                autoComplete="off"
                autoFocus
                size={Math.max(1, entered.length)}
                className="look-figure bg-transparent text-right text-[2.75rem] text-content tabular-nums placeholder:text-content-muted focus:outline-none"
              />
              <span className="text-title text-content-muted">{currency}</span>
            </div>
            <p className="mt-1 h-5 text-meta text-content-muted tabular-nums">
              {priceOct != null &&
                (currency === "USD"
                  ? fmtOct(priceOct)
                  : octUsd
                    ? `$${(priceOct * octUsd).toFixed(2)}`
                    : "")}
            </p>
            <div className="mt-3 flex rounded-full bg-surface-highlight p-1">
              {(["OCT", "USD"] as const).map((c) => (
                <button
                  key={c}
                  type="button"
                  disabled={c === "USD" && !octUsd}
                  onClick={() => {
                    setCurrency(c);
                    setError("");
                  }}
                  className={`h-7.5 cursor-pointer rounded-full px-3.5 text-micro font-semibold transition-colors duration-200 ease-out disabled:opacity-40 ${
                    currency === c ? "bg-(--bg-3) text-content" : "text-content-muted"
                  }`}
                >
                  {c}
                </button>
              ))}
            </div>
            {mode === "reprice" && listing && (
              <div className="mt-4 w-full">
                <KV label={t("nft.market.was")}>{fmtOct(listing.price / MICRO_OCT)}</KV>
              </div>
            )}
          </div>
          <p role="alert" className="mb-2 min-h-5 text-center text-[0.8125rem] text-danger">
            {error}
          </p>
          <Btn
            weight="primary"
            className="look-key mt-2 w-full"
            onClick={() => void toReview()}
            disabled={priceOct == null}
          >
            {t("nft.market.review")}
          </Btn>
        </div>
      )}

      {stage !== "price" && (
        <div>
          {mode === "cancel" && listing ? (
            <KV label={t("nft.market.listedAtLabel")}>{fmtOct(listing.price / MICRO_OCT)}</KV>
          ) : (
            priceOct != null && (
              <KV label={t("nft.market.price")}>
                {fmtOct(priceOct)}
                {octUsd ? (
                  <span className="text-content-muted">${(priceOct * octUsd).toFixed(2)}</span>
                ) : null}
              </KV>
            )
          )}
          {mode === "reprice" && listing && (
            <KV label={t("nft.market.was")}>{fmtOct(listing.price / MICRO_OCT)}</KV>
          )}
          <KV label={t("nft.market.market")}>Xpectrum</KV>
          <KV label={t("nft.market.signatures")}>
            {mode === "reprice" ? t("nft.market.upTo", { count: signatures }) : String(signatures)}
          </KV>
          <KV label={t("sendFlow.networkFee")}>
            <ReviewFee quote={feeQuote} ou={ou} />
            {feeQuote.status === "ok" && signatures > 1 && (
              <span className="text-content-muted">{t("nft.market.each")}</span>
            )}
          </KV>

          <ol className="mt-5 space-y-3">
            {ops.map((op) => {
              const i = ops.indexOf(op);
              const at = current ? ops.indexOf(current) : stage === "done" ? ops.length : -1;
              const state =
                stage === "failed" && op === current
                  ? "failed"
                  : i < at
                    ? "done"
                    : op === current
                      ? "active"
                      : "todo";
              return (
                <li key={op} className="flex items-center gap-3">
                  <span
                    className={`size-2 shrink-0 rounded-full ${
                      state === "done"
                        ? "bg-content"
                        : state === "active"
                          ? "animate-pulse bg-content"
                          : state === "failed"
                            ? "bg-danger"
                            : "bg-(--bg-3)"
                    }`}
                  />
                  <span
                    className={`text-meta ${
                      state === "failed"
                        ? "text-danger"
                        : state === "todo"
                          ? "text-content-muted"
                          : "text-content"
                    }`}
                  >
                    {t(OP_LABEL[op])}
                  </span>
                </li>
              );
            })}
          </ol>

          <p role="alert" className="mt-4 min-h-5 text-[0.8125rem] text-danger">
            {feeText(error)}
          </p>

          {stage === "review" && (
            <Pair
              className="mt-3"
              left={
                <Btn onClick={() => (mode === "cancel" ? onClose() : setStage("price"))}>
                  {t("common.reject")}
                </Btn>
              }
              right={
                <Btn
                  weight="primary"
                  onClick={() => void run()}
                  disabled={feeQuote.status !== "ok" || !ou}
                >
                  {t(TITLE[mode])}
                </Btn>
              }
            />
          )}
          {stage === "running" && <div className="mt-3 h-11.5" />}
          {(stage === "done" || stage === "failed") && (
            <div className="mt-3 flex gap-2.5">
              {stage === "failed" && (
                <Btn
                  className="flex-1"
                  onClick={() => {
                    setCurrent(null);
                    setError("");
                    setStage(mode === "cancel" ? "review" : "price");
                  }}
                >
                  {t("fee.tryAgain")}
                </Btn>
              )}
              <Btn weight="primary" className="flex-1" onClick={close}>
                {stage === "done" ? t("nft.done") : t("common.close")}
              </Btn>
            </div>
          )}
        </div>
      )}

      <TransactionAuthModal
        isOpen={txAuth.isOpen}
        onResult={txAuth.handleResult}
        title={txAuth.title}
      />
    </NftDrawer>
  );
}
