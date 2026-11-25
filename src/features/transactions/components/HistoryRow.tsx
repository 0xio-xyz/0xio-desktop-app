import { useTranslation } from "src/i18n/react";
import type { Transaction } from "src/types/transaction";
import { isTestnetId, networkLabel } from "src/features/transactions/history/sides";
import { isDead, isPendingState } from "src/features/transactions/history/outcome";
import { middleOf, whenOf } from "src/features/transactions/history/callRows";
import type { TxView } from "src/features/transactions/history/txView";
import NamedAddress from "src/shared/ui/NamedAddress";
import OutlineTag from "./OutlineTag";

export default function HistoryRow({
  tx,
  view,
  network,
  onOpen,
  selected,
}: {
  tx: Transaction;
  view: TxView;
  network: string;
  onOpen: (tx: Transaction) => void;
  selected?: boolean;
}) {
  const { t } = useTranslation();
  const dead = isDead(view.state);
  const pending = isPendingState(view.state);
  const other = view.contract
    ? (view.contract.name ?? middleOf(view.contract.address, 8, 6))
    : view.counterparty
      ? view.received
        ? t("history.fromAddress", {
            address: middleOf(view.counterparty, 8, 6),
            defaultValue: "From {{address}}",
          })
        : t("history.toAddress", {
            address: middleOf(view.counterparty, 8, 6),
            defaultValue: "To {{address}}",
          })
      : "";
  const otherIsAddress = !view.contract?.name;
  const party = view.contract ? null : view.counterparty;
  const [lead, tail] = party
    ? t(view.received ? "history.fromAddress" : "history.toAddress", {
        address: "\u0001",
        defaultValue: view.received ? "From \u0001" : "To \u0001",
      }).split("\u0001")
    : ["", ""];

  return (
    <button
      type="button"
      onClick={() => onOpen(tx)}
      aria-current={selected ? "true" : undefined}
      data-testid="history-row"
      data-network={network}
      className={`w-full h-17 flex items-center gap-4 rounded-2xl px-5 text-left transition-colors cursor-pointer ${
        selected ? "bg-surface-highlight" : "bg-surface hover:bg-surface-highlight"
      }`}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 min-w-0 h-5">
          <span className="text-body font-semibold text-content truncate" data-testid="row-title">
            {view.title}
          </span>
          {isTestnetId(network) && <OutlineTag label={t("history.testnet")} />}
          {dead && (
            <span className="text-micro text-danger shrink-0">
              {t("history.failed", { defaultValue: "Failed" })}
            </span>
          )}
          {pending && (
            <span className="text-micro text-content-secondary shrink-0">
              {t("history.pending")}
            </span>
          )}
        </div>
        <div className="flex items-baseline gap-3 mt-1 min-w-0 h-4">
          <span className="text-micro font-mono tabular-nums text-content-faint shrink-0">
            {tx.timestamp ? whenOf(tx.timestamp) : ""}
          </span>
          {party ? (
            <NamedAddress
              address={party}
              networkId={network}
              before={lead.trim() ? <span className="shrink-0">{lead.trim()}</span> : null}
              className="font-mono text-micro text-content-secondary"
            >
              <span data-testid="row-other">
                {middleOf(party, 8, 6)}
                {tail}
              </span>
            </NamedAddress>
          ) : (
            <span
              className={`text-micro text-content-secondary truncate ${otherIsAddress ? "font-mono" : ""}`}
              data-testid="row-other"
            >
              {other}
            </span>
          )}
        </div>
      </div>
      <div className="shrink-0 flex flex-col items-end">
        <span
          className={`h-5 text-body font-mono tabular-nums whitespace-nowrap ${
            dead ? "text-content-secondary" : view.sign === "+" ? "text-positive" : "text-content"
          }`}
          data-testid="row-amount"
        >
          {view.amount != null ? (
            <>
              {view.sign}
              {view.amount} <span className="text-micro text-content-secondary">{view.unit}</span>
            </>
          ) : (
            " "
          )}
        </span>
        <span className="h-4 mt-1 text-micro text-content-secondary whitespace-nowrap">
          {networkLabel(network, t)}
        </span>
      </div>
    </button>
  );
}
