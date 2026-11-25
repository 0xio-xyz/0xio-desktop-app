import { useTranslation } from "src/i18n/react";
import WalletAvatar from "src/shared/ui/WalletAvatar";
import { Btn } from "src/shared/ui/look";
import type { PaletteAction } from "src/shared/layout/paletteSearch";
import { useWallet } from "src/contexts/useWallet";
import { useTransactionHistory } from "src/hooks/transactions/useTransactionHistory";
import { middleOf, ouToOct, whenOf } from "src/features/transactions/history/callRows";
import type { TxView } from "src/features/transactions/history/txView";
import { isDead, isPendingState } from "src/features/transactions/history/outcome";
import { formatOCT } from "src/lib/format";
import type { Transaction } from "src/types/transaction";

export type Preview =
  | { kind: "person"; address: string; name: string | null }
  | { kind: "tx"; tx: Transaction; view: TxView; who: string | null }
  | { kind: "plain"; title: string; shortcut?: string; mono?: boolean };

export default function PalettePreview({
  preview,
  primary,
  secondary,
  onRun,
}: {
  preview: Preview;
  primary: PaletteAction;
  secondary?: PaletteAction;
  onRun: (action: PaletteAction) => void;
}) {
  const actions = (
    <div className="mt-5 flex flex-wrap gap-2">
      <Btn size="sm" weight="primary" onClick={() => onRun(primary)}>
        {primary.label}
      </Btn>
      {secondary && (
        <Btn size="sm" onClick={() => onRun(secondary)}>
          {secondary.label}
        </Btn>
      )}
    </div>
  );
  if (preview.kind === "person") return <PersonCard {...preview} actions={actions} />;
  if (preview.kind === "tx") return <TxCard {...preview} actions={actions} />;
  return (
    <div className="flex h-full flex-col">
      <div
        className={`text-title font-semibold break-all text-content ${preview.mono ? "font-mono text-body" : ""}`}
      >
        {preview.title}
      </div>
      {preview.shortcut && (
        <span className="mt-2.5">
          <Key>{preview.shortcut}</Key>
        </span>
      )}
      {actions}
    </div>
  );
}

export function Key({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex h-5.5 min-w-5.5 items-center justify-center rounded-md bg-(--bg-3) px-1.5 font-mono text-[0.71875rem] text-content-secondary">
      {children}
    </kbd>
  );
}

function Line({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex h-8 items-center justify-between gap-3 text-meta">
      <span className="text-content-muted">{label}</span>
      <span className="flex min-w-0 items-center gap-1.75 truncate text-content tabular-nums">
        {children}
      </span>
    </div>
  );
}

function PersonCard({
  address,
  name,
  actions,
}: {
  address: string;
  name: string | null;
  actions: React.ReactNode;
}) {
  const { t } = useTranslation();
  const { activeWallet } = useWallet();
  const { transactions } = useTransactionHistory();
  // The open wallet's own history says nothing about it as a counterparty.
  const others = address === activeWallet?.address ? [] : transactions;
  const sent = others.filter((tx) => tx.to === address && tx.from !== address);
  const received = others.filter((tx) => tx.from === address && tx.to !== address);
  const last = sent[0];
  return (
    <div>
      <div className="flex items-center gap-3">
        <WalletAvatar address={address} size={44} />
        <span className="min-w-0 truncate text-title font-semibold text-content">
          {name ?? middleOf(address, 8, 6)}
        </span>
      </div>
      <div className="mt-3.5 font-mono text-meta leading-normal break-all text-content-secondary">
        {address}
      </div>
      <div className="mt-2.5">
        {last && (
          <Line label={t("palette.lastSend")}>
            {formatOCT(last.amount)} OCT
            <span className="text-content-muted">{whenOf(last.timestamp).slice(0, 10)}</span>
          </Line>
        )}
        {sent.length > 0 && (
          <Line label={t("palette.sent")}>{t("palette.times", { count: sent.length })}</Line>
        )}
        {received.length > 0 && (
          <Line label={t("palette.received")}>
            {t("palette.times", { count: received.length })}
          </Line>
        )}
      </div>
      {actions}
    </div>
  );
}

function TxCard({
  tx,
  view,
  who,
  actions,
}: {
  tx: Transaction;
  view: TxView;
  who: string | null;
  actions: React.ReactNode;
}) {
  const { t } = useTranslation();
  const fee = ouToOct(tx.fee > 0 ? tx.fee : null);
  const state = isDead(view.state)
    ? t("history.failed")
    : isPendingState(view.state)
      ? t("history.pending")
      : t("txDetail.confirmed");
  return (
    <div>
      <div className="tab-caps text-content-muted">{view.title}</div>
      <div className="mt-3 h-10 truncate font-mono text-[2rem] leading-10 font-light text-content tabular-nums">
        {view.amount != null ? `${view.sign}${view.amount}` : ""}
        {view.amount != null && (
          <span className="ml-1.5 text-body text-content-muted">{view.unit}</span>
        )}
      </div>
      <div className="mt-3">
        {view.counterparty && (
          <Line label={t(view.received ? "palette.from" : "palette.to")}>
            <WalletAvatar address={view.counterparty} size={18} />
            <span className="truncate">{who}</span>
          </Line>
        )}
        {tx.timestamp > 0 && <Line label={t("palette.when")}>{whenOf(tx.timestamp)}</Line>}
        {!view.received && fee && <Line label={t("txDetail.fee")}>{fee} OCT</Line>}
        <Line label={t("history.status")}>{state}</Line>
      </div>
      {actions}
    </div>
  );
}
