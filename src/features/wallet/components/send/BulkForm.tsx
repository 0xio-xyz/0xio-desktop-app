import { useCallback, useRef, useState } from "react";
import { useTranslation } from "src/i18n/react";
import WalletAvatar from "src/shared/ui/WalletAvatar";
import { Caps, EASE, FOCUS, Num, Small } from "src/shared/ui/look";
import { Group } from "src/shared/ui/FormParts";
import TokenPicker from "src/features/wallet/components/send/TokenPicker";
import type { BulkFlow } from "src/features/wallet/hooks/useBulkFlow";
import type { Recipients } from "src/features/wallet/hooks/useRecipients";
import { isAddress, type SendForm } from "src/features/wallet/hooks/useSendForm";
import type { BatchRow } from "src/features/wallet/hooks/useBatchSend";
import { useOutsideClose } from "src/hooks/ui/useOutsideClose";
import { isPositiveDecimal, truncateAddress } from "src/lib/format";

function TextAction({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`h-7.5 cursor-pointer rounded-full px-2.5 text-[0.8125rem] font-medium text-content-secondary hover:bg-surface-highlight hover:text-content disabled:cursor-default disabled:opacity-40 ${EASE} ${FOCUS}`}
    >
      {children}
    </button>
  );
}

export function RowState({ row }: { row: BatchRow }) {
  const { t } = useTranslation();
  if (row.status === "failed") return <Small>{t("sendFlow.failed")}</Small>;
  return (
    <span
      aria-label={t(`sendFlow.row.${row.status}`)}
      className={`size-2 shrink-0 rounded-full ${
        row.status === "sending"
          ? "bg-content shadow-[0_0_0_4px_var(--bg-3)] motion-safe:animate-pulse"
          : row.status === "success"
            ? "bg-content-secondary"
            : "bg-(--bg-3)"
      }`}
    />
  );
}

function AddRow({
  bulk,
  recipients,
  unit,
}: {
  bulk: BulkFlow;
  recipients: Recipients;
  unit: string;
}) {
  const { t } = useTranslation();
  const [address, setAddress] = useState("");
  const [amount, setAmount] = useState("");
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useOutsideClose(box, open, close);
  const matches = open && !isAddress(address) ? recipients.search(address).slice(0, 5) : [];
  const valid = isAddress(address.trim()) && isPositiveDecimal(amount);
  const add = () => {
    if (!valid) return;
    bulk.batch.addRow(address.trim(), amount.trim());
    setAddress("");
    setAmount("");
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") add();
  };
  return (
    <div className="@container">
      <div className="flex flex-wrap gap-2 @md:flex-nowrap">
        <div ref={box} className="relative min-w-0 basis-full @md:basis-0 @md:flex-1">
          <input
            value={address}
            onChange={(e) => {
              setAddress(e.target.value.trimStart());
              setOpen(true);
            }}
            onFocus={() => {
              recipients.reload();
              setOpen(true);
            }}
            onKeyDown={onKey}
            placeholder={t("sendFlow.toPlaceholder")}
            aria-label={t("sendFlow.recipient")}
            autoComplete="off"
            spellCheck={false}
            className={`h-13 w-full rounded-[14px] bg-surface-highlight px-4 text-content outline-none placeholder:text-content-muted focus:shadow-[inset_0_0_0_1.5px_var(--fg-2)] ${address ? "font-mono text-[0.84375rem]" : "text-body"}`}
          />
          {matches.length > 0 && (
            <ul className="look-raise absolute top-full right-0 left-0 z-30 mt-1.5 max-h-60 overflow-y-auto rounded-[14px] bg-surface-card p-1">
              {matches.map((r) => (
                <li key={r.address}>
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      setAddress(r.address);
                      setOpen(false);
                    }}
                    className={`flex min-h-11 w-full cursor-pointer items-center gap-3 rounded-[11px] px-2.5 text-left hover:bg-surface-highlight ${EASE}`}
                  >
                    <WalletAvatar address={r.address} size={24} />
                    <span className="min-w-0 flex-1 truncate text-body text-content">
                      {r.name ?? truncateAddress(r.address, 10, 8)}
                    </span>
                    <span className="font-mono text-[0.75rem] text-content-muted">
                      {truncateAddress(r.address, 8, 6)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <input
          value={amount}
          onChange={(e) => {
            const v = e.target.value;
            if (v === "" || /^\d*\.?\d{0,6}$/.test(v)) setAmount(v);
          }}
          onKeyDown={onKey}
          placeholder="0"
          inputMode="decimal"
          aria-label={t("sendFlow.amountIn", { unit })}
          className="h-13 w-0 min-w-0 flex-1 rounded-[14px] bg-surface-highlight px-4 @md:w-32 @md:flex-none text-body text-content tabular-nums outline-none placeholder:text-content-muted focus:shadow-[inset_0_0_0_1.5px_var(--fg-2)]"
        />
        <button
          type="button"
          onClick={add}
          disabled={!valid}
          className={`h-13 shrink-0 cursor-pointer rounded-[14px] bg-surface-highlight px-5 text-lead font-semibold text-content hover:bg-(--bg-3) disabled:cursor-default disabled:opacity-40 ${EASE} ${FOCUS}`}
        >
          {t("sendFlow.add")}
        </button>
      </div>
    </div>
  );
}

export default function BulkForm({
  form,
  bulk,
  recipients,
  locked,
  action,
}: {
  form: SendForm;
  bulk: BulkFlow;
  recipients: Recipients;
  locked: boolean;
  action: React.ReactNode;
}) {
  const { t } = useTranslation();
  const file = useRef<HTMLInputElement>(null);
  const [paste, setPaste] = useState("");
  const rows = bulk.batch.rows;
  const busy = bulk.batch.isExecuting;
  return (
    <div
      aria-disabled={locked || undefined}
      {...(locked ? { inert: "" } : {})}
      className={`flex min-h-0 flex-1 flex-col gap-4.5 transition-[opacity,filter] duration-250 ease-out motion-reduce:transition-none ${locked ? "pointer-events-none opacity-40 grayscale" : ""}`}
    >
      <section className="flex flex-col">
        <Caps
          className="px-4.5 pb-2.25"
          right={
            <TokenPicker
              token={form.token}
              tokens={form.tokens}
              onPick={form.setToken}
              octBalance={form.publicKnown}
              locked={form.isPrivate}
            />
          }
        >
          {t("sendFlow.addRecipient")}
        </Caps>
        <Group className="p-2">
          <AddRow bulk={bulk} recipients={recipients} unit={form.unit} />
          <div className="mt-2 flex items-center gap-1">
            <TextAction onClick={() => file.current?.click()} disabled={busy}>
              {t("send.importCsv")}
            </TextAction>
            <TextAction onClick={bulk.batch.clearRows} disabled={busy || rows.length === 0}>
              {t("send.clearAll")}
            </TextAction>
          </div>
          <input
            ref={file}
            type="file"
            accept=".csv"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              const reader = new FileReader();
              reader.onload = () => bulk.addText(String(reader.result ?? ""), true);
              reader.readAsText(f);
              e.target.value = "";
            }}
          />
        </Group>
      </section>
      <section className="flex flex-col">
        <Caps className="px-4.5 pb-2.25">{t("sendFlow.pasteList")}</Caps>
        <Group className="p-2">
          <textarea
            value={paste}
            onChange={(e) => setPaste(e.target.value)}
            placeholder={t("send.bulkPastePlaceholder")}
            aria-label={t("sendFlow.pasteList")}
            rows={3}
            className="w-full resize-none rounded-[14px] bg-surface-highlight px-4 py-3 font-mono text-meta text-content outline-none placeholder:text-content-muted focus:shadow-[inset_0_0_0_1.5px_var(--fg-2)]"
          />
          <div className="mt-1 flex h-7.5 items-center">
            <TextAction
              onClick={() => bulk.addText(paste) && setPaste("")}
              disabled={busy || !paste.trim()}
            >
              {t("send.addAll")}
            </TextAction>
          </div>
        </Group>
      </section>
      <section className="flex flex-1 flex-col">
        <Caps
          className="px-4.5 pb-2.25"
          right={
            bulk.batch.stats.success + bulk.batch.stats.failed > 0
              ? t("sendFlow.sentFailed", {
                  sent: bulk.batch.stats.success,
                  failed: bulk.batch.stats.failed,
                })
              : undefined
          }
        >
          {t("sendFlow.recipients", { count: rows.length })}
        </Caps>
        <Group className="min-h-24 flex-1 overflow-y-auto p-1.5 scrollbar-hide">
          {rows.length === 0 ? (
            <div className="flex h-21 items-center px-3.5 text-body text-content-muted">
              {t("sendFlow.noRows")}
            </div>
          ) : (
            rows.map((row) => {
              const who = recipients.info(row.address);
              return (
                <div key={row.id} className="flex min-h-12 items-center gap-3 rounded-[13px] px-3">
                  <WalletAvatar address={row.address} size={24} />
                  <span className="min-w-0 flex-1 truncate text-body text-content">
                    {who.name ?? (
                      <span className="font-mono text-[0.8125rem]">
                        {truncateAddress(row.address, 12, 10)}
                      </span>
                    )}
                    {bulk.duplicates.has(row.address) && (
                      <span className="ml-2">
                        <Small>{t("sendFlow.duplicate")}</Small>
                      </span>
                    )}
                  </span>
                  <span className="text-body font-medium text-content">
                    <Num value={row.amount} />{" "}
                    <span className="font-normal text-content-muted">{form.unit}</span>
                  </span>
                  <span className="flex w-18 shrink-0 justify-end">
                    {row.status === "pending" && !busy ? (
                      <TextAction onClick={() => bulk.batch.removeRow(row.id)}>
                        {t("proofs.remove")}
                      </TextAction>
                    ) : (
                      <RowState row={row} />
                    )}
                  </span>
                </div>
              );
            })
          )}
        </Group>
      </section>
      {action}
    </div>
  );
}
