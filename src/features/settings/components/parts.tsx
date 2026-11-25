import React from "react";
import { ChevronRightIcon, UpDownIcon } from "src/shared/layout/navIcons";
import { Select } from "src/shared/ui/Select";

export const FOCUS =
  "outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset";
const EASE = "transition-colors duration-200 ease-out motion-reduce:transition-none";

export function Group({
  caption,
  right,
  children,
}: {
  caption?: React.ReactNode;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col">
      {caption && (
        <div className="tab-caps flex min-h-6.75 items-center justify-between gap-4 px-4.5 pb-2.25 text-content-muted">
          <span>{caption}</span>
          {right}
        </div>
      )}
      <div className="look-raise flex flex-col rounded-[18px] bg-surface-card p-1">{children}</div>
    </section>
  );
}

export function CaptionWallet({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2 text-[0.8125rem] font-medium tracking-normal text-content-secondary normal-case">
      {children}
    </span>
  );
}

export function Row({
  label,
  sub,
  lead,
  children,
  onClick,
  negative,
  selected,
  ariaLabel,
}: {
  label: React.ReactNode;
  sub?: React.ReactNode;
  lead?: React.ReactNode;
  children?: React.ReactNode;
  onClick?: () => void;
  negative?: boolean;
  selected?: boolean;
  ariaLabel?: string;
}) {
  const body = (
    <>
      <span className="flex min-w-0 items-center gap-3.5">
        {lead}
        <span className="flex min-w-0 flex-col">
          <span
            className={`flex items-center gap-2 text-body ${selected ? "font-semibold" : "font-medium"} ${negative ? "text-danger" : "text-content"}`}
          >
            {label}
          </span>
          {sub && <span className="mt-0.75 text-meta leading-[1.4] text-content-muted">{sub}</span>}
        </span>
      </span>
      {children && (
        <span className="flex shrink-0 items-center gap-1 [&>[data-tb]:last-child]:-mr-2.5">
          {children}
        </span>
      )}
    </>
  );
  const base = `flex min-h-13 w-full items-center justify-between gap-5 rounded-[14px] px-3.5 py-2 text-left ${selected ? "bg-surface-highlight" : ""}`;
  if (!onClick) return <div className={base}>{body}</div>;
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
        e.preventDefault();
        onClick();
      }}
      aria-label={ariaLabel}
      aria-current={selected ? "true" : undefined}
      className={`${base} cursor-pointer ${EASE} ${FOCUS} hover:bg-surface-highlight`}
    >
      {body}
    </div>
  );
}

export function Value({
  children,
  chevron,
  muted,
}: {
  children?: React.ReactNode;
  chevron?: boolean;
  muted?: boolean;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-[0.84375rem] whitespace-nowrap ${muted ? "text-content-muted" : "text-content-secondary"}`}
    >
      {children}
      {chevron && <ChevronRightIcon size={14} className="text-content-muted" />}
    </span>
  );
}

export function TextAction({
  children,
  onClick,
  disabled,
  ariaLabel,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      data-tb
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      disabled={disabled}
      aria-label={ariaLabel}
      className={`inline-flex h-7.5 cursor-pointer items-center rounded-full px-2.5 text-[0.8125rem] font-medium whitespace-nowrap text-content-secondary hover:bg-surface-highlight hover:text-content disabled:cursor-default disabled:opacity-50 ${EASE} ${FOCUS}`}
    >
      {children}
    </button>
  );
}

export function PillAction({
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
      className={`inline-flex h-8 cursor-pointer items-center rounded-full bg-surface-highlight px-3.5 text-[0.8125rem] font-medium whitespace-nowrap text-content hover:bg-(--bg-3) disabled:cursor-default disabled:opacity-60 ${EASE} ${FOCUS}`}
    >
      {children}
    </button>
  );
}

export function Toggle({
  on,
  onChange,
  label,
  disabled,
}: {
  on: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!on);
      }}
      className={`relative h-5 w-8.5 shrink-0 cursor-pointer rounded-full disabled:cursor-default disabled:opacity-50 ${EASE} ${FOCUS} ${on ? "bg-accent" : "bg-content-muted/50"}`}
    >
      <span
        className={`absolute top-0.5 left-0.5 size-4 rounded-full shadow-[0_1px_2px_rgba(0,0,0,0.25)] transition-transform duration-200 ease-out motion-reduce:transition-none ${on ? "translate-x-3.5 bg-accent-fg" : "bg-white"}`}
      />
    </button>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="inline-flex gap-0.5 rounded-xl bg-surface-highlight p-0.75"
    >
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(o.value)}
            className={`h-6.5 cursor-pointer rounded-[9px] px-3 text-[0.8125rem] font-medium whitespace-nowrap ${EASE} ${FOCUS} ${
              on
                ? "bg-(--bg-3) text-content in-data-[theme=light]:bg-surface-card in-data-[theme=light]:shadow-[0_1px_3px_rgba(0,0,0,0.12)]"
                : "text-content-muted hover:text-content"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function PillSelect<T extends string | number>({
  value,
  options,
  onChange,
  label,
  disabled,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
  disabled?: boolean;
}) {
  const current = options.find((o) => String(o.value) === String(value));
  return (
    <Select
      value={String(value)}
      options={options.map((o) => ({ value: String(o.value), label: o.label }))}
      disabled={disabled}
      label={label}
      onValueChange={(v) => {
        const picked = options.find((o) => String(o.value) === v);
        if (picked) onChange(picked.value);
      }}
      onTriggerClick={(e) => e.stopPropagation()}
      triggerClassName={`inline-flex h-7.5 cursor-pointer items-center gap-1.75 rounded-full bg-surface-highlight pr-2 pl-3 text-[0.8125rem] whitespace-nowrap text-content hover:bg-(--bg-3) disabled:cursor-default disabled:opacity-60 ${EASE} ${FOCUS}`}
      contentProps={{ "data-look": "ext" }}
      contentClassName="look-raise z-50 max-h-80 overflow-hidden rounded-[14px] bg-surface-card p-1"
      itemClassName="flex h-8 cursor-pointer items-center rounded-[10px] px-3 text-[0.8125rem] text-content-secondary outline-none select-none data-highlighted:bg-surface-highlight data-highlighted:text-content data-[state=checked]:bg-(--bg-3) data-[state=checked]:text-content"
    >
      <span style={{ pointerEvents: "none" }}>{current?.label ?? String(value)}</span>
      <UpDownIcon size={13} className="text-content-muted" />
    </Select>
  );
}

export function StatusPanel({ children }: { children: React.ReactNode }) {
  return (
    <div className="look-raise flex min-w-0 flex-col rounded-[22px] bg-surface-card px-5.5 pt-5.5 pb-5">
      {children}
    </div>
  );
}

export function PanelCaption({
  children,
  right,
  className = "",
}: {
  children: React.ReactNode;
  right?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`tab-caps flex items-center justify-between gap-2.5 text-content-muted ${className}`}
    >
      <span className="inline-flex items-center gap-2">{children}</span>
      {right && (
        <span className="text-meta tracking-normal text-content-secondary normal-case">
          {right}
        </span>
      )}
    </div>
  );
}

export function Live({
  value,
  stale,
  width = "w-14",
}: {
  value: React.ReactNode | null | undefined;
  stale?: boolean;
  width?: string;
}) {
  if (value === null || value === undefined) {
    return (
      <span
        aria-hidden="true"
        className={`inline-block h-3.5 ${width} animate-pulse rounded-md bg-surface-highlight align-middle motion-reduce:animate-none`}
      />
    );
  }
  return (
    <span
      className={`transition-opacity duration-200 ease-out ${stale ? "opacity-50" : "opacity-100"}`}
    >
      {value}
    </span>
  );
}

export function KV({
  label,
  value,
  sub,
  lead,
  muted,
  action,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  sub?: React.ReactNode;
  lead?: React.ReactNode;
  muted?: boolean;
  action?: React.ReactNode;
}) {
  return (
    <div
      className={`flex justify-between gap-4 ${action ? "items-center py-1.25" : lead ? "items-center py-2.25" : "items-baseline py-2.75"}`}
    >
      <span
        className={`inline-flex min-w-0 items-center gap-2 ${lead ? "text-[0.84375rem] font-medium whitespace-nowrap text-content" : "text-[0.8125rem] text-pretty text-content-muted"}`}
      >
        {lead}
        <span className={lead ? "truncate" : undefined}>{label}</span>
      </span>
      <span className="inline-flex items-center gap-0.5 [&>[data-tb]:last-child]:-mr-2.5">
        <span
          className={`text-right whitespace-nowrap ${muted ? "text-[0.84375rem] text-content-muted" : lead ? "text-[0.84375rem] font-medium text-content" : "text-lead font-medium text-content"}`}
        >
          {value}
          {sub && (
            <small className="mt-0.75 block text-[0.75rem] font-normal text-content-muted">
              {sub}
            </small>
          )}
        </span>
        {action}
      </span>
    </div>
  );
}

export function Figure({
  label,
  value,
  unit,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  unit?: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <div className="text-meta text-content-muted">{label}</div>
      <div className="look-figure mt-2 text-[1.875rem] whitespace-nowrap text-content">
        {value}
        {unit && (
          <span className="ml-1 text-[0.8125rem] font-normal tracking-normal text-content-muted">
            {unit}
          </span>
        )}
      </div>
    </div>
  );
}

export function NetDot({ color }: { color: string }) {
  return (
    <span
      aria-hidden="true"
      className="inline-block size-2 shrink-0 rounded-full"
      style={{ backgroundColor: color }}
    />
  );
}

export function SubPage({
  title,
  onBack,
  backLabel,
  children,
}: {
  title: string;
  onBack: () => void;
  backLabel: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className="flex flex-col gap-6.5 animate-in fade-in-0 slide-in-from-right-2 duration-250 ease-out motion-reduce:animate-none"
      onKeyDown={(e) => {
        if (e.key !== "Escape" || e.defaultPrevented) return;
        if (!e.currentTarget.contains(e.target as Node)) return;
        onBack();
      }}
    >
      <div className="flex min-h-6.75 items-center justify-between gap-4 pr-1 pl-4.5">
        <h2 className="text-lead font-semibold text-content">{title}</h2>
        <TextAction onClick={onBack}>{backLabel}</TextAction>
      </div>
      {children}
    </div>
  );
}
