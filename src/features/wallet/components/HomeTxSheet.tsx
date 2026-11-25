import { useCallback, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "src/lib/router";
import { useWallet } from "src/contexts/useWallet";
import { useEscapeKey } from "src/hooks/ui/useEscapeKey";
import { useTransactionDetail } from "src/hooks/transactions/useTransactionHistory";
import { NETWORKS } from "src/services/network/config";
import { formatDateTime, formatOCT, truncateAddress } from "src/lib/format";
import type { Transaction } from "src/types/transaction";

export interface HomeTxView {
  tx: Transaction;
  label: string;
  amount: string;
  credit: boolean;
}

function Row({ label, value, copy }: { label: string; value: string; copy?: string }) {
  const [copied, setCopied] = useState(false);
  const body = (
    <span className="grid text-right tabular-nums">
      <span className={`col-start-1 row-start-1 ${copied ? "invisible" : ""}`}>{value}</span>
      {copied && <span className="col-start-1 row-start-1 text-content-secondary">Copied</span>}
    </span>
  );
  return (
    <div className="flex items-baseline justify-between gap-6 py-2 text-meta">
      <span className="text-content-muted shrink-0">{label}</span>
      {copy ? (
        <button
          type="button"
          title="Copy"
          onClick={() => {
            navigator.clipboard.writeText(copy);
            setCopied(true);
            setTimeout(() => setCopied(false), 1400);
          }}
          className="text-content hover:opacity-80 transition-opacity cursor-pointer"
        >
          {body}
        </button>
      ) : (
        <span className="text-content">{body}</span>
      )}
    </div>
  );
}

export default function HomeTxSheet({ view, onClose }: { view: HomeTxView; onClose: () => void }) {
  const navigate = useNavigate();
  const { networkId, showBalanceValues } = useWallet();
  const { tx } = view;
  const { data: detail } = useTransactionDetail(tx.hash);
  const close = useCallback(() => onClose(), [onClose]);
  useEscapeKey(true, close);

  const explorerUrl = NETWORKS[networkId]?.explorerUrl;
  const status = detail?.status ?? tx.status;
  const failed = status === "failed" || status === "rejected";
  const statusText = failed ? "Failed" : status === "pending" ? "Pending" : "Confirmed";
  const ts = tx.timestamp < 1e12 ? tx.timestamp * 1000 : tx.timestamp;
  const fee = detail?.ou ?? (tx.fee ? String(tx.fee) : undefined);
  const reason = detail?.reject_reason ?? tx.reject_reason;
  const [figure, unit] = view.amount ? view.amount.replace(/^[+-]/, "").split(" ") : ["", ""];

  const sheet = (
    <div data-look="ext" className="absolute inset-0 z-50 flex items-center justify-center">
      <div
        className="absolute inset-0 bg-(--overlay) animate-in fade-in duration-200"
        onClick={close}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={view.label}
        className="look-raise relative w-full max-w-md mx-4 bg-surface-card rounded-[22px] px-6 pt-6 pb-5 animate-in fade-in zoom-in-95 duration-200"
      >
        <div className="flex items-baseline justify-between gap-4">
          <span className="tab-caps text-content-muted">{view.label}</span>
          <span
            className={`text-meta font-medium ${failed ? "text-danger" : status === "pending" ? "text-content-secondary" : "text-positive"}`}
          >
            {statusText}
          </span>
        </div>
        <div className="mt-4 flex items-baseline gap-2 min-h-11">
          {figure ? (
            <>
              <span
                className={`look-figure text-[2.5rem] ${view.credit ? "text-positive" : "text-content"}`}
              >
                {showBalanceValues ? figure : "••••"}
              </span>
              <span className="text-lead font-medium text-content-muted">{unit}</span>
            </>
          ) : (
            <span className="look-figure text-[2.5rem] text-content-muted">0</span>
          )}
        </div>
        {ts > 0 && <p className="mt-2 text-meta text-content-muted">{formatDateTime(ts)}</p>}

        {reason && <p className="mt-4 text-meta text-danger leading-relaxed">{reason}</p>}

        <div className="mt-5 bg-surface rounded-2xl px-4 py-1.5">
          <Row label="From" value={truncateAddress(tx.from, 10, 8)} copy={tx.from} />
          <Row label="To" value={truncateAddress(tx.to, 10, 8)} copy={tx.to} />
          <Row label="Hash" value={truncateAddress(tx.hash, 10, 8)} copy={tx.hash} />
          {fee && <Row label="Fee" value={`${formatOCT(parseInt(fee) || 0)} OCT`} />}
          {(detail?.block_height ?? tx.block_height) != null && (
            <Row label="Block" value={String(detail?.block_height ?? tx.block_height)} />
          )}
          {detail?.epoch != null && <Row label="Epoch" value={String(detail.epoch)} />}
        </div>

        {explorerUrl && (
          <button
            type="button"
            onClick={() =>
              navigate(`/browser?url=${encodeURIComponent(`${explorerUrl}${tx.hash}`)}`)
            }
            className="mt-4 w-full h-11 rounded-full bg-surface-highlight text-body font-medium text-content hover:bg-(--bg-3) transition-colors cursor-pointer"
          >
            View on explorer
          </button>
        )}
      </div>
    </div>
  );

  const target = document.getElementById("content-area");
  return target ? createPortal(sheet, target) : sheet;
}
