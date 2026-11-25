import { useCallback, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "src/lib/router";
import { useTranslation } from "src/i18n/react";
import { ChevronRight, Copy, ExternalLink } from "src/shared/ui/icons";
import type { Transaction } from "src/types/transaction";
import { useWallet } from "src/contexts/useWallet";
import { useTransactionDetail } from "src/hooks/transactions/useTransactionHistory";
import { useEscapeKey } from "src/hooks/ui/useEscapeKey";
import { peekTokenList } from "src/hooks/wallet/useTokens";
import { knownOctraContract } from "src/features/transactions/history/callReading";
import { knownCallArgs } from "src/features/transactions/history/callArgs";
import {
  callMethod,
  knownArgPlaceholders,
  middleOf,
  octraArgRows,
  octraCallArgs,
  ouToOct,
  whenOf,
  type CallData,
  type TxDetailRow,
} from "src/features/transactions/history/callRows";
import { methodKey, useContractMethods } from "src/features/transactions/history/contractMethods";
import {
  contractKey,
  useAbiNames,
  useTokenFacts,
} from "src/features/transactions/history/contractFacts";
import { octraContractName } from "src/features/transactions/history/tokenNames";
import { rowFromDetail, txView } from "src/features/transactions/history/txView";
import { isDead } from "src/features/transactions/history/outcome";
import { explorerTxUrl, isTestnetId, networkLabel } from "src/features/transactions/history/sides";
import { useCopied } from "src/features/transactions/history/useCopied";
import NamedAddress from "src/shared/ui/NamedAddress";
import OutlineTag from "./OutlineTag";
import CallDataPage from "./CallDataPage";

interface TxDetailsPanelProps {
  hash: string;
  /** The network the transaction ran on, never assumed from the active one. */
  network: string;
  tx?: Transaction | null;
  onClose: () => void;
  inline?: boolean;
}

export default function TxDetailsPanel(props: TxDetailsPanelProps) {
  if (props.inline) return <PanelBody key={`${props.network}:${props.hash}`} {...props} />;
  const target = typeof document !== "undefined" ? document.getElementById("content-area") : null;
  const panel = (
    <div
      className={`${target ? "absolute" : "fixed"} inset-0 z-50 flex justify-end`}
      data-testid="tx-details-panel"
    >
      <div
        className="absolute inset-0 bg-black/40 animate-in fade-in duration-200"
        onClick={props.onClose}
        data-testid="tx-details-scrim"
      />
      <aside
        role="dialog"
        aria-modal="true"
        className="relative h-full w-110 max-w-[calc(100%-48px)] bg-surface-card shadow-[-20px_0_60px_rgba(0,0,0,0.35)] flex flex-col animate-in slide-in-from-right duration-200"
      >
        <PanelBody key={`${props.network}:${props.hash}`} {...props} />
      </aside>
    </div>
  );
  return target ? createPortal(panel, target) : panel;
}

function ValueBar() {
  return (
    <span className="inline-block h-3.5 w-24 rounded bg-surface-highlight animate-pulse align-middle" />
  );
}

function PanelBody({ hash, network, tx, onClose }: TxDetailsPanelProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { activeWallet } = useWallet();
  const me = activeWallet?.address ?? "";
  const [callPage, setCallPage] = useState(false);
  const { copy, isCopied } = useCopied();

  const detailQ = useTransactionDetail(hash, network);
  const detail = detailQ.data ?? null;
  const detailLoading = detailQ.isLoading;
  const row: Transaction | null = tx ?? (detail ? rowFromDetail(detail, network, me) : null);
  const isCall = row?.type === "contract_call" && !!row.to;

  const methods = useContractMethods(isCall && !row?.methodName ? [{ network, hash }] : NO_CALLS);
  const method = row?.methodName ?? methods[methodKey(network, hash)] ?? null;
  const args = (row && octraCallArgs(row.message)) ?? octraCallArgs(detail?.message) ?? null;
  const known = isCall ? knownOctraContract(network, row!.to) : null;
  const specs = isCall ? knownCallArgs(known?.calls, method) : null;
  const abi = useAbiNames(
    network,
    isCall && !specs && method && args?.length ? row!.to : null,
    method,
  );
  const facts = useTokenFacts(isCall ? [{ network, address: row!.to }] : NO_CONTRACTS);

  const back = useCallback(() => setCallPage(false), []);
  const onEscape = useCallback(() => (callPage ? back() : onClose()), [callPage, back, onClose]);
  useEscapeKey(true, onEscape);

  if (!row) {
    return (
      <div className="flex-1 overflow-y-auto px-6 py-5">
        <h3 className="text-lead font-semibold text-content mb-4">
          {t("history.transactionDetails")}
        </h3>
        {detailLoading ? (
          <div className="space-y-2">
            <div className="h-24 rounded-2xl bg-surface animate-pulse" />
            <div className="h-48 rounded-2xl bg-surface animate-pulse" />
          </div>
        ) : (
          <p className="text-meta text-content-secondary">{t("history.txNotFound")}</p>
        )}
      </div>
    );
  }

  const listed = peekTokenList();
  const view = txView(
    row,
    {
      me,
      network,
      method,
      facts: isCall ? facts[contractKey(network, row.to)] : null,
      listed,
      detailStatus: detail?.status,
      args,
    },
    t,
  );
  const dead = isDead(view.state);
  const tt = row.token_transfer;

  const argsLoading = isCall && !args && detailLoading;
  const argView =
    isCall && args
      ? octraArgRows(args, specs, abi.names, t)
      : { rows: isCall && specs && argsLoading ? knownArgPlaceholders(specs, t) : [], args: [] };
  const callDataPending =
    isCall && (argsLoading || (!specs && !!args?.length && !!method && abi.loading));
  const callData: CallData | null =
    isCall && !callDataPending && argView.args.length > 0
      ? { ...callMethod(method), contract: view.contract, args: argView.args }
      : null;

  const statusWord: Record<typeof view.state, string> = {
    confirmed: t("txDetail.confirmed", { defaultValue: "Confirmed" }),
    pending: t("history.pending"),
    stillPending: t("txDetail.stillPending", { defaultValue: "Still pending" }),
    failed: t("history.failed", { defaultValue: "Failed" }),
    dropped: t("txDetail.dropped", { defaultValue: "Replaced or dropped" }),
  };
  const fee = ouToOct(detail?.ou ?? (row.fee > 0 ? row.fee : null));
  const nonce = detail?.nonce || row.nonce || 0;
  const reason = row.drop_detail ?? row.reject_reason ?? detail?.reject_reason ?? null;
  const memo = !isCall && row.message && !octraCallArgs(row.message) ? row.message : null;

  const rows: TxDetailRow[] = [
    {
      label: t("history.status"),
      value: statusWord[view.state],
      tone: dead ? "danger" : view.state === "confirmed" ? undefined : "muted",
    },
    { label: t("history.type"), value: view.title },
    ...(view.method
      ? [{ label: t("txDetail.method", { defaultValue: "Method" }), value: view.method }]
      : []),
    ...(view.contract
      ? [
          {
            label: t("txDetail.contract", { defaultValue: "Contract" }),
            value: view.contract.name ?? middleOf(view.contract.address),
            mono: !view.contract.name,
            copy: view.contract.address,
          },
        ]
      : view.counterparty
        ? [
            {
              label: view.received ? t("history.fromLabel") : t("history.toLabel"),
              value: middleOf(view.counterparty),
              mono: true,
              copy: view.counterparty,
              named: view.counterparty,
            },
          ]
        : []),
    ...(tt
      ? [
          {
            label: t("txDetail.token", { defaultValue: "Token" }),
            value:
              octraContractName(network, tt.contract_address, { symbol: tt.symbol }, listed) ??
              middleOf(tt.contract_address),
            mono: true,
            copy: tt.contract_address,
          },
        ]
      : []),
    ...argView.rows,
    ...(!view.received && (fee || detailLoading)
      ? [
          {
            label: t("txDetail.fee", { defaultValue: "Network fee" }),
            value: fee ? `${fee} OCT` : "",
            pending: !fee,
          },
        ]
      : []),
    { label: t("txDetail.network", { defaultValue: "Network" }), value: networkLabel(network, t) },
    ...(detail?.epoch ? [{ label: t("history.epoch"), value: String(detail.epoch) }] : []),
    ...(nonce > 0 ? [{ label: t("history.nonce"), value: String(nonce) }] : []),
  ];

  const explorer = explorerTxUrl(network, hash);
  const hero = view.amount != null ? `${view.sign}${view.amount} ${view.unit}` : view.title;
  const note =
    view.state === "dropped"
      ? t("txDetail.droppedNote", {
          defaultValue:
            "Another transaction from this address took its place, or the network dropped it. Check your balance before sending again.",
        })
      : view.state === "stillPending"
        ? t("txDetail.stillPendingNote", {
            defaultValue:
              "Not confirmed yet. It may still confirm. Check the explorer before sending again.",
          })
        : null;

  return (
    <div className="flex-1 overflow-y-auto scrollbar-hide px-6 py-5">
      {callPage && callData ? (
        <CallDataPage data={callData} onBack={back} />
      ) : (
        <div className="space-y-2" data-testid="tx-details">
          <h3 className="text-lead font-semibold text-content mb-2">
            {t("history.transactionDetails")}
          </h3>

          <div className="@container bg-surface rounded-2xl px-5 py-4">
            <div className="flex flex-wrap items-center gap-2 min-w-0">
              <span
                className={`min-w-0 text-lg @2xs:text-2xl tabular-nums [overflow-wrap:anywhere] ${
                  dead
                    ? "text-content-secondary"
                    : view.amount != null && view.sign === "+"
                      ? "text-positive"
                      : "text-content"
                } ${view.amount != null ? "font-mono" : "font-semibold"}`}
                data-testid="tx-hero"
              >
                {hero}
              </span>
              {isTestnetId(network) && <OutlineTag label={t("history.testnet")} />}
            </div>
            <p className="text-micro font-mono text-content-secondary mt-1.5 h-4">
              {row.timestamp ? whenOf(row.timestamp) : ""}
            </p>
          </div>

          <div className="bg-surface rounded-2xl px-5 py-1.5">
            {rows.map((r, i) => {
              const id = `row-${i}`;
              const text = isCopied(id) ? t("history.copied", { defaultValue: "Copied" }) : r.value;
              const body = (
                <span
                  className={`text-meta truncate tabular-nums ${r.mono && !isCopied(id) ? "font-mono" : ""} ${
                    r.tone === "danger"
                      ? "text-danger"
                      : r.tone === "muted"
                        ? "text-content-secondary"
                        : "text-content"
                  }`}
                >
                  {text}
                </span>
              );
              return (
                <div
                  key={`${r.label}-${i}`}
                  className="flex items-center justify-between gap-4 min-h-8.5 py-1.5"
                  data-testid="detail-row"
                >
                  <span className="text-meta text-content-secondary shrink-0">{r.label}</span>
                  {r.pending ? (
                    <ValueBar />
                  ) : r.copy ? (
                    <button
                      type="button"
                      onClick={() => void copy(r.copy!, id)}
                      title={r.copy}
                      className="flex min-w-0 hover:opacity-80 transition-opacity cursor-pointer"
                    >
                      {r.named ? (
                        <NamedAddress address={r.named} networkId={network} className="text-meta">
                          {body}
                        </NamedAddress>
                      ) : (
                        body
                      )}
                    </button>
                  ) : (
                    body
                  )}
                </div>
              );
            })}
            {(callData || callDataPending) && (
              <button
                type="button"
                disabled={!callData}
                onClick={() => setCallPage(true)}
                className="w-full flex items-center justify-between gap-4 min-h-8.5 py-1.5 text-meta text-content-secondary enabled:hover:text-content transition-colors enabled:cursor-pointer disabled:opacity-50"
              >
                <span>{t("txDetail.viewCallData", { defaultValue: "View call data" })}</span>
                <ChevronRight size={14} />
              </button>
            )}
          </div>

          {note && (
            <div className="bg-surface rounded-2xl px-5 py-3.5">
              <p className="text-meta text-content-secondary leading-relaxed">{note}</p>
            </div>
          )}

          {dead && reason && (
            <div className="bg-surface rounded-2xl px-5 py-3.5">
              <p className="text-micro text-content-secondary">{t("history.rejectReason")}</p>
              <p className="text-meta text-content leading-relaxed mt-1 break-all">{reason}</p>
            </div>
          )}

          {memo && (
            <div className="bg-surface rounded-2xl px-5 py-3.5">
              <p className="text-micro text-content-secondary">{t("history.message")}</p>
              <p className="text-meta font-mono text-content break-all leading-relaxed mt-1">
                {memo}
              </p>
            </div>
          )}

          <div className="flex flex-wrap gap-2 pt-2">
            <button
              type="button"
              onClick={() => void copy(hash, "hash")}
              className="flex-1 whitespace-nowrap px-4 h-10 rounded-full bg-surface hover:bg-surface-highlight transition-colors flex items-center justify-center gap-2 text-meta text-content cursor-pointer"
            >
              <Copy size={13} />
              {isCopied("hash")
                ? t("history.copied", { defaultValue: "Copied" })
                : t("txDetail.copyHash", { defaultValue: "Copy hash" })}
            </button>
            {explorer && (
              <button
                type="button"
                onClick={() => navigate(`/browser?url=${encodeURIComponent(explorer)}`)}
                className="flex-1 whitespace-nowrap px-4 h-10 rounded-full bg-surface hover:bg-surface-highlight transition-colors flex items-center justify-center gap-2 text-meta text-content cursor-pointer"
              >
                <ExternalLink size={13} />
                {t("txDetail.explorer", { defaultValue: "View in explorer" })}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const NO_CALLS: { network: string; hash: string }[] = [];
const NO_CONTRACTS: { network: string; address: string }[] = [];
