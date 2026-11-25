import React from "react";
import "src/css/look-ext.css";
import TopBar, { type StaleRead } from "src/shared/layout/TopBar";
import { EASE, FOCUS } from "src/shared/ui/look";

export function Screen({
  onRefresh,
  refreshing,
  children,
  scroll,
  lead,
  stale,
  wide,
}: {
  onRefresh?: () => void;
  refreshing?: boolean;
  lead?: React.ReactNode;
  stale?: StaleRead | null;
  scroll?: boolean;
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      data-look="ext"
      className={`h-full bg-surface ${scroll ? "overflow-y-auto scrollbar-hide" : "overflow-hidden"}`}
    >
      <div
        className={`${scroll ? "min-h-full" : "h-full"} mx-auto flex flex-col ${wide ? "pr-6 pb-5 pl-2" : "max-w-310 px-7 pb-7 min-[1600px]:px-11"}`}
      >
        {lead ? (
          <div className="flex shrink-0 items-center gap-2 pt-6.5 pb-3">
            {lead}
            <div className="min-w-0 flex-1">
              <TopBar onRefresh={onRefresh} refreshing={refreshing} stale={stale} />
            </div>
          </div>
        ) : (
          <div className="shrink-0 pt-6.5 pb-3">
            <TopBar onRefresh={onRefresh} refreshing={refreshing} stale={stale} />
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

export function ScrollArea({
  children,
  fade,
  className = "",
}: {
  children: React.ReactNode;
  fade?: boolean;
  className?: string;
}) {
  return (
    <div
      className={`flex-1 min-h-0 overflow-y-auto scrollbar-hide ${className}`}
      style={
        fade
          ? { maskImage: "linear-gradient(to bottom, black calc(100% - 20px), transparent)" }
          : undefined
      }
    >
      {children}
    </div>
  );
}

export function PageTitle({
  title,
  subtitle,
  right,
  leading,
}: {
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
  leading?: React.ReactNode;
}) {
  return (
    <div className="mt-1 flex shrink-0 flex-wrap items-center justify-between gap-4">
      <div className="flex min-w-0 items-center gap-3">
        {leading}
        <div className="min-w-0">
          <h1 className="truncate text-[1.75rem] leading-tight font-semibold tracking-[-0.02em] text-content">
            {title}
          </h1>
          {subtitle && <p className="mt-1 text-meta text-content-muted">{subtitle}</p>}
        </div>
      </div>
      {right && <div className="flex shrink-0 items-center gap-2">{right}</div>}
    </div>
  );
}

export function PillTabs<T extends string>({
  tabs,
  value,
  onChange,
  size = "md",
}: {
  tabs: { id: T; label: string; badge?: number; disabled?: boolean; title?: string }[];
  value: T;
  onChange: (id: T) => void;
  size?: "sm" | "md";
}) {
  const h = size === "sm" ? "h-7" : "h-8";
  return (
    <div className="look-raise inline-flex shrink-0 gap-0.5 rounded-[15px] bg-surface-card p-1">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          onClick={() => !tab.disabled && onChange(tab.id)}
          disabled={tab.disabled}
          title={tab.title}
          aria-current={value === tab.id ? "true" : undefined}
          className={`inline-flex ${h} cursor-pointer items-center gap-1.5 rounded-[11px] px-3.75 text-[0.84375rem] font-medium whitespace-nowrap disabled:cursor-default disabled:opacity-40 ${EASE} ${FOCUS} ${
            value === tab.id
              ? "bg-(--bg-3) text-content in-data-[theme=light]:bg-content in-data-[theme=light]:text-surface-card"
              : "text-content-muted hover:text-content"
          }`}
        >
          {tab.label}
          {tab.badge != null && tab.badge > 0 && <span className="tabular-nums">{tab.badge}</span>}
        </button>
      ))}
    </div>
  );
}

export function Panel({
  children,
  className = "",
  pad = true,
}: {
  children: React.ReactNode;
  className?: string;
  pad?: boolean;
  style?: React.CSSProperties;
}) {
  return (
    <div
      className={`look-raise rounded-[22px] bg-surface-card ${pad ? "px-6 py-5" : "p-2"} ${className}`}
    >
      {children}
    </div>
  );
}

type ActionWeight = "primary" | "raised" | "text" | "danger";

const ACTION_STYLE: Record<ActionWeight, string> = {
  primary: "look-key px-5 font-semibold bg-content text-content-inverse hover:opacity-90",
  raised: "px-5 font-semibold bg-surface-highlight text-content hover:bg-(--bg-3)",
  text: "px-4 font-medium text-content-secondary hover:text-content",
  danger: "px-5 font-semibold bg-danger text-white hover:brightness-110",
};

export function Action({
  children,
  weight = "raised",
  full,
  className = "",
  ...rest
}: {
  children: React.ReactNode;
  weight?: ActionWeight;
  full?: boolean;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...rest}
      className={`py-2.75 rounded-full text-body transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-default disabled:pointer-events-none ${
        full ? "w-full" : ""
      } ${ACTION_STYLE[weight]} ${className}`}
    >
      {children}
    </button>
  );
}

export function Row({
  label,
  value,
  mono = true,
  tone,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  mono?: boolean;
  tone?: "default" | "muted" | "positive" | "danger";
}) {
  const toneClass =
    tone === "muted"
      ? "text-content-secondary"
      : tone === "positive"
        ? "text-positive"
        : tone === "danger"
          ? "text-danger"
          : "text-content";
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <span className="text-meta text-content-secondary min-w-0 truncate">{label}</span>
      <span
        className={`text-meta ${mono ? "font-mono tabular-nums" : ""} ${toneClass} text-right whitespace-nowrap`}
      >
        {value}
      </span>
    </div>
  );
}
