import { Num } from "src/shared/ui/look";

const OCT_LOGO = "https://cdn.jsdelivr.net/gh/0xio-xyz/Token-lists@main/logos/Octra/Oct_Public.svg";

const SIZES = {
  lg: ["1.5rem", "2.5rem"],
  md: ["1.5rem", "2.875rem"],
  xl: ["1.5rem", "4.5rem"],
} as const;

/** A transparent input over the drawn figure, so typing, the caret and selection stay native. */
export default function BigAmount({
  value,
  onChange,
  label,
  disabled,
  decimals = 6,
  size = "md",
  fit,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
  disabled?: boolean;
  decimals?: number;
  size?: "lg" | "md" | "xl";
  fit?: boolean;
}) {
  const pattern = new RegExp(`^\\d*\\.?\\d{0,${decimals}}$`);
  const [min, max] = SIZES[size];
  const chars = Math.max(value.length, 1);
  const fontSize = fit
    ? max
    : `clamp(${min}, calc(100cqw / ${(chars * 0.6 + 0.3).toFixed(2)}), ${max})`;
  return (
    <div
      className={fit ? "flex items-end" : "@container flex min-w-0 flex-1 items-end"}
      style={{ height: max }}
    >
      <div
        className="relative w-full"
        style={fit ? { fontSize, width: `${chars * 0.6 + 0.3}em` } : { fontSize }}
      >
        <span
          aria-hidden="true"
          className="look-figure pointer-events-none block truncate pr-1 whitespace-pre"
        >
          {value ? (
            <Num value={value} className="text-content" />
          ) : (
            <span className="text-content-muted">0</span>
          )}
        </span>
        <input
          aria-label={label}
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          value={value}
          disabled={disabled}
          onChange={(e) => {
            const v = e.target.value.replace(/,/g, "");
            if (v === "" || pattern.test(v)) onChange(v);
          }}
          className="look-figure absolute inset-0 w-full bg-transparent text-transparent caret-(--fg) outline-none selection:bg-surface-highlight disabled:cursor-default"
        />
      </div>
    </div>
  );
}

export function TokenChip({
  symbol,
  logo,
  chevron,
}: {
  symbol: string;
  logo?: string | null;
  chevron?: boolean;
}) {
  const src = logo === undefined ? OCT_LOGO : logo;
  return (
    <span className="inline-flex h-8.5 shrink-0 items-center gap-2 rounded-full bg-surface-highlight pr-2.5 pl-1.5 text-body font-medium text-content">
      <span className="look-logo grid size-5.5 place-items-center overflow-hidden rounded-full bg-(--bg-3) text-[0.625rem] font-semibold">
        {src ? (
          <img
            src={src}
            alt=""
            crossOrigin="anonymous"
            className="size-full object-cover"
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = "none";
            }}
          />
        ) : (
          symbol.slice(0, 1)
        )}
      </span>
      {symbol}
      {chevron && (
        <svg
          aria-hidden="true"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          className="text-content-muted"
        >
          <path
            d="m6 9 6 6 6-6"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </span>
  );
}
