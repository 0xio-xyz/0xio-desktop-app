import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "src/i18n/react";
import { ChevronDown, Search } from "src/shared/ui/icons";
import WalletAvatar from "src/shared/ui/WalletAvatar";
import { EASE, FOCUS } from "src/shared/ui/look";
import { useOutsideClose } from "src/hooks/ui/useOutsideClose";
import {
  onsReasonKey,
  useFoundName,
  useNameLookup,
  type NameLookup,
} from "src/hooks/wallet/useOns";
import type {
  RecipientInfo,
  RecipientSource,
  Recipients,
} from "src/features/wallet/hooks/useRecipients";
import { isAddress } from "src/features/wallet/hooks/useSendForm";
import { truncateAddress } from "src/lib/format";

interface PickerRow {
  address: string;
  name: string | null;
  group: "new" | "recent" | "book" | "wallet";
}

const GROUP_ORDER: PickerRow["group"][] = ["new", "recent", "book", "wallet"];
const GROUP_LABEL: Record<Exclude<PickerRow["group"], "new">, string> = {
  recent: "sendFlow.group.recent",
  book: "sendFlow.group.contacts",
  wallet: "sendFlow.group.wallets",
};

function groupOf(r: RecipientInfo): PickerRow["group"] {
  if (r.last) return "recent";
  return (r.source ?? "book") as Exclude<RecipientSource, "recent">;
}

export function pickerRows(recipients: Recipients, query: string): PickerRow[] {
  const q = query.trim();
  const rows: PickerRow[] = recipients
    .search(q)
    .map((r) => ({ address: r.address, name: r.name, group: groupOf(r) }));
  rows.sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group));
  if (isAddress(q) && !rows.some((r) => r.address === q))
    rows.unshift({ address: q, name: null, group: "new" });
  return rows;
}

const DOT = "size-1.25 rounded-full bg-content-secondary motion-safe:animate-pulse";

function NameRow({
  lookup,
  active,
  onHover,
  onPick,
}: {
  lookup: NameLookup;
  active: boolean;
  onHover: () => void;
  onPick: () => void;
}) {
  const { t } = useTranslation();
  const found = lookup.state === "found";
  const failed = lookup.state === "failed";
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      aria-disabled={!found && !failed ? true : undefined}
      data-testid="name-row"
      data-state={lookup.state}
      onMouseEnter={onHover}
      onClick={onPick}
      className={`grid h-14 w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-xl px-3 text-left ${found || failed ? "cursor-pointer" : "cursor-default"} ${active && (found || failed) ? "bg-surface-highlight" : ""} ${FOCUS}`}
    >
      <WalletAvatar
        address={found ? lookup.address : undefined}
        size={36}
        className={lookup.state === "refused" ? "opacity-55" : undefined}
      />
      <span className="min-w-0">
        <span
          className={`block text-body font-semibold whitespace-nowrap text-content ${lookup.state === "refused" ? "opacity-55" : ""}`}
        >
          {lookup.label}
        </span>
        <span
          className={`flex min-h-4.5 items-center text-meta ${found || lookup.state === "resolving" ? "text-content-secondary" : "text-content"}`}
        >
          {lookup.state === "resolving" ? (
            <span role="status" aria-label={t("ons.lookingUp")} className="inline-flex gap-1.25">
              <i className={DOT} />
              <i className={`${DOT} [animation-delay:200ms]`} />
              <i className={`${DOT} [animation-delay:400ms]`} />
            </span>
          ) : found ? (
            <span className="truncate font-mono">{truncateAddress(lookup.address, 12, 8)}</span>
          ) : (
            t(onsReasonKey(lookup.reason))
          )}
        </span>
      </span>
      {failed && <span className="text-meta font-semibold text-content">{t("ons.retry")}</span>}
    </button>
  );
}

export default function RecipientPicker({
  value,
  name,
  onChange,
  recipients,
  disabled,
  names,
}: {
  value: string;
  name?: string | null;
  onChange: (address: string, name?: string | null) => void;
  recipients: Recipients;
  disabled?: boolean;
  names?: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hi, setHi] = useState(0);
  const lookup = useNameLookup(names && open ? query : "");
  const lead = lookup ? 1 : 0;
  const wrap = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLButtonElement>(null);
  const close = useCallback((focus?: boolean) => {
    setOpen(false);
    if (focus) field.current?.focus();
  }, []);
  const closeOutside = useCallback(() => setOpen(false), []);
  useOutsideClose(wrap, open, closeOutside);

  const rows = useMemo(
    () => (open ? pickerRows(recipients, query) : []),
    [open, recipients, query],
  );
  const info = value ? recipients.info(value) : null;
  const shownName = name ?? info?.name ?? null;

  const pick = (row: PickerRow | undefined) => {
    if (!row) return;
    onChange(row.address);
    close(true);
  };
  const takeName = (address: string, label: string) => {
    onChange(address, label);
    close(true);
  };
  const pickName = () => {
    if (lookup?.state === "failed") return lookup.retry();
    if (lookup?.state === "found") takeName(lookup.address, lookup.label);
  };
  useFoundName(lookup, query, takeName);

  return (
    <div ref={wrap} className="relative">
      <button
        ref={field}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t("sendFlow.recipient")}
        onClick={() => {
          setQuery("");
          setHi(
            Math.max(
              0,
              value ? pickerRows(recipients, "").findIndex((r) => r.address === value) : 0,
            ),
          );
          setOpen((o) => !o);
        }}
        className={`look-raise flex h-14 w-full cursor-pointer items-center gap-3 rounded-[14px] px-4 text-left ${open ? "bg-surface-highlight" : "bg-surface-card hover:bg-surface-highlight"} disabled:cursor-default ${EASE} ${FOCUS}`}
      >
        {!value ? (
          <span className="text-body text-content-muted">{t("sendFlow.chooseRecipient")}</span>
        ) : shownName ? (
          <>
            <WalletAvatar address={value} size={28} />
            <span className="min-w-0 truncate text-lead font-semibold text-content">
              {shownName}
            </span>
            <span className="min-w-0 shrink-[4] truncate font-mono text-[0.8125rem] text-content-muted">
              {truncateAddress(value, 12, 8)}
            </span>
          </>
        ) : (
          <>
            <WalletAvatar address={value} size={28} />
            <span className="min-w-0 truncate font-mono text-body text-content">
              {truncateAddress(value, 16, 12)}
            </span>
          </>
        )}
        <span className="flex-1" />
        <ChevronDown size={14} className="shrink-0 text-content-muted" aria-hidden="true" />
      </button>
      {open && (
        <div className="absolute top-[calc(100%+8px)] right-0 left-0 z-30 rounded-[18px] bg-surface-card p-2 text-left shadow-[0_30px_70px_-20px_rgba(0,0,0,0.95),0_2px_8px_rgba(0,0,0,0.5)] animate-in fade-in-0 slide-in-from-top-1.5 duration-200 ease-out motion-reduce:animate-none">
          <label className="flex h-11 items-center gap-2.5 rounded-xl bg-surface-highlight px-3.5">
            <Search size={15} className="shrink-0 text-content-muted" aria-hidden="true" />
            <input
              autoFocus
              autoComplete="off"
              spellCheck={false}
              value={query}
              placeholder={t("sendFlow.searchOrPaste")}
              aria-label={t("sendFlow.searchOrPaste")}
              aria-controls="recipient-list"
              onChange={(e) => {
                setQuery(e.target.value);
                setHi(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setHi((h) => Math.min(rows.length + lead - 1, h + 1));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setHi((h) => Math.max(0, h - 1));
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  if (lead && hi === 0) pickName();
                  else pick(rows[hi - lead]);
                } else if (e.key === "Escape") {
                  e.stopPropagation();
                  close(true);
                }
              }}
              className="min-w-0 flex-1 bg-transparent text-body text-content outline-none placeholder:text-content-muted"
            />
          </label>
          <div
            id="recipient-list"
            role="listbox"
            aria-label={t("sendFlow.recipient")}
            className="mt-0.5 max-h-75 overflow-y-auto scrollbar-hide"
          >
            {lookup && (
              <NameRow
                lookup={lookup}
                active={hi === 0}
                onHover={() => setHi(0)}
                onPick={pickName}
              />
            )}
            {lookup && rows.length === 0 ? null : rows.length === 0 ? (
              <p className="px-3 py-3.5 text-body text-content-muted">{t("sendFlow.noMatch")}</p>
            ) : (
              rows.map((r, n) => {
                const i = n + lead;
                const head = r.group !== "new" && (n === 0 || rows[n - 1].group !== r.group);
                return (
                  <div key={`${r.group}:${r.address}`}>
                    {head && (
                      <div className="tab-caps px-3 pt-3 pb-1 text-content-muted">
                        {t(GROUP_LABEL[r.group as Exclude<PickerRow["group"], "new">])}
                      </div>
                    )}
                    <button
                      type="button"
                      role="option"
                      aria-selected={i === hi}
                      onMouseEnter={() => setHi(i)}
                      onClick={() => pick(r)}
                      ref={(el) => {
                        if (el && i === hi) el.scrollIntoView?.({ block: "nearest" });
                      }}
                      className={`grid min-h-11.5 w-full cursor-pointer grid-cols-[auto_minmax(0,1fr)] items-center gap-3 rounded-xl px-3 py-1.5 text-left ${i === hi ? "bg-surface-highlight" : ""} ${FOCUS}`}
                    >
                      <WalletAvatar address={r.address} size={26} />
                      <span className="min-w-0">
                        <span className="block truncate text-body font-medium text-content">
                          {r.group === "new"
                            ? t("sendFlow.useThisAddress")
                            : (r.name ?? truncateAddress(r.address, 12, 8))}
                        </span>
                        <span className="block truncate font-mono text-meta text-content-muted">
                          {truncateAddress(r.address, 12, 8)}
                        </span>
                      </span>
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
