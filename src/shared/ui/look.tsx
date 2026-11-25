import React from "react";
import { useTranslation } from "src/i18n/react";

export const EASE = "transition-colors duration-200 ease-out motion-reduce:transition-none";
export const FOCUS =
  "outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset";

export const GROUP_BUTTON = `relative inline-flex h-9 cursor-pointer items-center gap-2 rounded-full px-3 text-[0.84375rem] text-content-secondary transition-colors duration-200 ease-out hover:bg-surface-highlight hover:text-content motion-reduce:transition-none ${FOCUS}`;

export function Num({ value, className = "" }: { value: string; className?: string }) {
  const dot = /^[+-]?[\d,]+\.\d+$/.test(value) ? value.lastIndexOf(".") : -1;
  if (dot < 0) return <span className={`tabular-nums ${className}`}>{value}</span>;
  return (
    <span className={`tabular-nums ${className}`}>
      {value.slice(0, dot)}
      <span className="text-content-muted">{value.slice(dot)}</span>
    </span>
  );
}

export function Amount({
  value,
  unit = "OCT",
  after,
}: {
  value: string;
  unit?: string;
  after?: React.ReactNode;
}) {
  return (
    <span className="whitespace-nowrap">
      <Num value={value} />
      <span className="ml-1.25 font-normal text-content-muted">{unit}</span>
      {after && <Small> {after}</Small>}
    </span>
  );
}

export function Small({ children }: { children: React.ReactNode }) {
  return <span className="text-meta font-normal text-content-muted">{children}</span>;
}

export function Card({
  children,
  className = "",
  label,
}: {
  children: React.ReactNode;
  className?: string;
  label?: string;
}) {
  return (
    <section
      aria-label={label}
      className={`look-raise flex min-w-0 flex-col rounded-[22px] bg-surface-card px-5.5 py-5.5 ${className}`}
    >
      {children}
    </section>
  );
}

export function Caps({
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
      className={`tab-caps flex min-h-4.5 items-center justify-between gap-2.5 text-content-muted ${className}`}
    >
      <span className="inline-flex items-center gap-2">{children}</span>
      {right != null && (
        <span className="inline-flex items-center gap-1.75 text-meta tracking-normal text-content-secondary normal-case">
          {right}
        </span>
      )}
    </div>
  );
}

export function KV({
  label,
  children,
  tall,
  className = "",
}: {
  label: React.ReactNode;
  children: React.ReactNode;
  tall?: boolean;
  className?: string;
}) {
  return (
    <div
      className={`flex items-center justify-between gap-4 ${tall ? "min-h-13.5" : "min-h-11"} ${className}`}
    >
      <span className="shrink-0 text-[0.84375rem] whitespace-nowrap text-content-muted">
        {label}
      </span>
      <span className="inline-flex min-w-0 items-center gap-2.25 text-right text-body font-medium whitespace-nowrap text-content">
        {children}
      </span>
    </div>
  );
}

export function Lines({ children }: { children: React.ReactNode }) {
  return <span className="inline-flex flex-col items-end gap-0.75">{children}</span>;
}

export function Skel({ w = "w-16", still }: { w?: string; still?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block h-3 ${w} rounded-md bg-surface-highlight align-middle ${still ? "opacity-60" : "animate-pulse motion-reduce:animate-none"}`}
    />
  );
}

export function NetName({ name }: { name: string }) {
  return (
    <span className="inline-flex items-center gap-1.75">
      <span aria-hidden="true" className="size-1.5 rounded-full bg-positive" />
      {name}
    </span>
  );
}

type BtnWeight = "primary" | "secondary" | "text";

export function Btn({
  weight = "secondary",
  size = "md",
  className = "",
  children,
  ...rest
}: {
  weight?: BtnWeight;
  size?: "md" | "sm";
  children: React.ReactNode;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const tone =
    weight === "primary"
      ? "bg-content text-surface hover:opacity-90"
      : weight === "text"
        ? "text-content hover:bg-surface-highlight"
        : "bg-surface-highlight text-content hover:bg-(--bg-3)";
  return (
    <button
      type="button"
      {...rest}
      className={`inline-flex ${size === "sm" ? "h-9 px-4 text-body" : "h-11.5 px-5.5 text-lead"} cursor-pointer items-center justify-center rounded-full font-semibold whitespace-nowrap ${tone} ${EASE} ${FOCUS} focus-visible:ring-offset-2 disabled:cursor-default disabled:opacity-40 ${className}`}
    >
      {children}
    </button>
  );
}

export function Pair({
  left,
  right,
  className = "",
}: {
  left: React.ReactNode;
  right: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`grid grid-cols-2 gap-2.5 ${className}`}>
      {left}
      {right}
    </div>
  );
}

export function PillSwitch<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: { value: T; label: string; badge?: number; disabled?: boolean }[];
  value: T;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="look-raise inline-flex shrink-0 gap-0.5 rounded-[15px] bg-surface-card p-1"
    >
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={on}
            disabled={o.disabled}
            onClick={() => onChange(o.value)}
            className={`inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-[11px] px-3.75 text-[0.84375rem] font-medium whitespace-nowrap disabled:cursor-default disabled:opacity-40 ${EASE} ${FOCUS} ${
              on
                ? "bg-(--bg-3) text-content in-data-[theme=light]:bg-content in-data-[theme=light]:text-surface-card"
                : "text-content-muted hover:text-content"
            }`}
          >
            {o.label}
            {o.badge != null && o.badge > 0 && <span className="tabular-nums">{o.badge}</span>}
          </button>
        );
      })}
    </div>
  );
}

interface StepView {
  label: string;
  sec?: number | null;
}

export function clock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function StepDots({
  steps,
  current,
  stopped,
  className = "",
}: {
  steps: StepView[];
  /** The running step; steps.length when all are done. */
  current: number;
  stopped?: boolean;
  className?: string;
}) {
  return (
    <ol className={`flex flex-col gap-0.5 ${className}`}>
      {steps.map((s, i) => {
        const done = i < current || (stopped && i === current);
        const now = i === current && !stopped;
        return (
          <li
            key={s.label}
            aria-current={now ? "step" : undefined}
            className={`flex h-8.5 items-center gap-3 text-body ${EASE} ${
              now
                ? "font-medium text-content"
                : done
                  ? "text-content-secondary"
                  : "text-content-muted"
            }`}
          >
            <span
              aria-hidden="true"
              className={`mx-1 size-2 shrink-0 rounded-full ${
                now
                  ? "bg-content shadow-[0_0_0_4px_var(--bg-3)] motion-safe:animate-pulse"
                  : done
                    ? "bg-content-secondary"
                    : "bg-(--bg-3)"
              }`}
            />
            {s.label}
            {s.sec != null && i <= current && (
              <span className="ml-auto text-meta font-normal text-content-muted tabular-nums">
                {clock(s.sec)}
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

export function LayerDots({ n, of = 8 }: { n: number; of?: number }) {
  const { t } = useTranslation();
  const filled = Math.max(0, Math.min(of, n));
  return (
    <span className="inline-flex items-center gap-2.5">
      <span aria-hidden="true" className="inline-flex gap-1">
        {Array.from({ length: of }, (_, i) => (
          <span
            key={i}
            className={`size-1.5 rounded-full ${i < filled ? "bg-content-secondary" : "bg-(--bg-3)"}`}
          />
        ))}
      </span>
      <span className="text-[0.8125rem] font-normal text-content-muted">
        {t("proofs.layersOf", { n: filled, of })}
      </span>
    </span>
  );
}

export function Hero({
  value,
  unit = "OCT",
  size = "lg",
}: {
  value: string;
  unit?: string;
  size?: "lg" | "xl";
}) {
  return (
    <div className="flex items-baseline">
      <Num
        value={value}
        className={`look-figure ${size === "xl" ? "text-[3.75rem]" : "text-[2.5rem]"} text-content`}
      />
      <span
        className={`ml-1.25 text-content-muted ${size === "xl" ? "text-[1.25rem]" : "text-[1.0625rem]"}`}
      >
        {unit}
      </span>
    </div>
  );
}

export function ErrorLine({ text }: { text: string | null | undefined }) {
  return (
    <p
      role={text ? "alert" : undefined}
      className="min-h-5 text-[0.8125rem] leading-snug text-content"
    >
      {text ?? ""}
    </p>
  );
}
