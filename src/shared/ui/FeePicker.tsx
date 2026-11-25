import { useRef, useState } from "react";
import { useTranslation } from "src/i18n/react";
import { ChevronDown } from "src/shared/ui/icons";
import { Amount, EASE, FOCUS, Skel } from "src/shared/ui/look";
import type { FeeQuote } from "src/hooks/transactions/useFees";
import { useOutsideClose } from "src/hooks/ui/useOutsideClose";
import { useTokenPrice } from "src/hooks/wallet/useTokenPrice";
import { formatOCT, parseOCTInput } from "src/lib/format";

export type FeeMode = "slow" | "normal" | "fast" | "custom";

const PRESETS: { mode: Exclude<FeeMode, "custom">; key: "minimum" | "recommended" | "fast" }[] = [
  { mode: "slow", key: "minimum" },
  { mode: "normal", key: "recommended" },
  { mode: "fast", key: "fast" },
];

const MENU_ROOM = 260;

export function feeModeOf(ou: string, fees: FeeQuote["fee"]): FeeMode {
  if (!fees) return "normal";
  const n = Number(ou) || 0;
  const is = (key: "minimum" | "recommended" | "fast") =>
    !!fees[key] && (Number(fees[key]) || 0) === n;
  return is("recommended") ? "normal" : is("minimum") ? "slow" : is("fast") ? "fast" : "custom";
}

export function customFee(
  text: string,
  minimumOu: number,
): { ou: number | null; error: "min" | null } {
  const ou = parseOCTInput(text.trim());
  if (!text.trim() || ou <= 0) return { ou: null, error: null };
  return ou < minimumOu ? { ou: null, error: "min" } : { ou, error: null };
}

export default function FeePicker({
  quote,
  ou,
  onChange,
  disabled,
  align = "right",
  defaultOnly = false,
}: {
  quote: FeeQuote;
  ou: string;
  onChange: (ou: string, mode: FeeMode) => void;
  disabled?: boolean;
  align?: "left" | "right";
  defaultOnly?: boolean;
}) {
  const { t } = useTranslation();
  const { getUsdValue } = useTokenPrice();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [up, setUp] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  useOutsideClose(wrap, open, () => setOpen(false));

  const fees = quote.status === "ok" ? quote.fee : null;
  const mode = feeModeOf(ou, fees);
  const usd = (micro: number) => getUsdValue("OCT", micro / 1_000_000) ?? "";
  const minimum = fees ? Number(fees.minimum) || 0 : 0;
  const custom = customFee(draft, minimum);
  const box =
    "inline-flex h-7.5 min-w-53.5 shrink-0 items-center justify-end gap-2 text-body whitespace-nowrap";

  if (quote.status === "error")
    return (
      <span className={box}>
        <span className="font-medium text-content">{t("fee.unavailable")}</span>
        <button
          type="button"
          onClick={quote.retry}
          className={`-mr-1.5 h-7 cursor-pointer rounded-full bg-surface-highlight px-2.5 text-[0.8125rem] font-medium text-content hover:bg-(--bg-3) ${EASE} ${FOCUS}`}
        >
          {t("fee.tryAgain")}
        </button>
      </span>
    );
  if (!fees)
    return (
      <span className={box} role="status" aria-label={t("fee.checking")}>
        {quote.last ? (
          <span className="opacity-50">
            <Amount value={formatOCT(Number(quote.last.recommended) || 0)} />
          </span>
        ) : (
          <Skel w="w-36" />
        )}
      </span>
    );

  const presets = defaultOnly ? PRESETS.filter((p) => p.mode === "normal") : PRESETS;
  const label = (m: FeeMode) => t(defaultOnly && m !== "custom" ? "fee.default" : `fee.${m}`);

  const pick = (next: string, m: FeeMode) => {
    onChange(next, m);
    setOpen(false);
  };

  return (
    <span ref={wrap} className="relative inline-flex shrink-0">
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t("sendFlow.networkFee")}
        onClick={() => {
          setDraft(mode === "custom" ? formatOCT(Number(ou) || 0).replace(/,/g, "") : "");
          const box = wrap.current?.getBoundingClientRect();
          setUp(!!box && window.innerHeight - box.bottom < MENU_ROOM && box.top > MENU_ROOM);
          setOpen((o) => !o);
        }}
        className={`${box} -mr-1.5 cursor-pointer rounded-full pr-1.5 pl-2.5 font-medium text-content tabular-nums hover:bg-surface-highlight disabled:cursor-default disabled:hover:bg-transparent ${EASE} ${FOCUS}`}
      >
        <span className="font-normal text-content-muted">{label(mode)}</span>
        <Amount value={formatOCT(Number(ou) || 0)} />
        <span className="w-15 text-right text-meta font-normal text-content-muted">
          {usd(Number(ou) || 0)}
        </span>
        <ChevronDown size={13} className="text-content-muted" aria-hidden="true" />
      </button>
      {open && (
        <div
          role="listbox"
          aria-label={t("sendFlow.networkFee")}
          className={`absolute ${up ? "bottom-[calc(100%+6px)] slide-in-from-bottom-1.5" : "top-[calc(100%+6px)] slide-in-from-top-1.5"} ${align === "right" ? "right-0" : "left-0"} z-30 w-75 rounded-[18px] bg-surface-card p-2 text-left shadow-[0_30px_70px_-20px_rgba(0,0,0,0.95),0_2px_8px_rgba(0,0,0,0.5)] animate-in fade-in-0 duration-200 ease-out motion-reduce:animate-none`}
        >
          {presets
            .filter((p) => fees[p.key])
            .map((p) => {
              const v = Number(fees[p.key]) || 0;
              const on = mode === p.mode;
              return (
                <button
                  key={p.mode}
                  type="button"
                  role="option"
                  aria-selected={on}
                  onClick={() => pick(String(v), p.mode)}
                  className={`grid min-h-11.5 w-full cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-xl px-3 text-left ${on ? "bg-surface-highlight" : "hover:bg-surface-highlight"} ${EASE} ${FOCUS}`}
                >
                  <span
                    className={`text-body text-content ${on ? "font-semibold" : "font-medium"}`}
                  >
                    {label(p.mode)}
                  </span>
                  <span className="flex flex-col items-end text-body font-medium text-content tabular-nums">
                    <Amount value={formatOCT(v)} />
                    <span className="mt-0.5 text-[0.75rem] font-normal text-content-muted">
                      {usd(v)}
                    </span>
                  </span>
                </button>
              );
            })}
          <div
            className={`grid min-h-11.5 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-xl px-3 ${mode === "custom" ? "bg-surface-highlight" : ""}`}
          >
            <span className="text-body font-medium text-content">{t("fee.custom")}</span>
            <span className="flex items-center gap-1.5 text-body text-content">
              <input
                inputMode="decimal"
                autoComplete="off"
                spellCheck={false}
                value={draft}
                placeholder={formatOCT(Number(fees.recommended) || 0)}
                aria-label={t("fee.customOct")}
                onChange={(e) => {
                  const v = e.target.value.replace(/,/g, "");
                  if (v !== "" && !/^\d*\.?\d{0,6}$/.test(v)) return;
                  setDraft(v);
                  const c = customFee(v, minimum);
                  if (c.ou !== null) onChange(String(c.ou), "custom");
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && custom.ou !== null) pick(String(custom.ou), "custom");
                }}
                className="w-24 bg-transparent text-right tabular-nums outline-none placeholder:text-content-muted"
              />
              <span className="text-content-muted">OCT</span>
            </span>
          </div>
          <p aria-live="polite" className="h-5 px-3 pt-0.5 text-meta text-danger">
            {custom.error ? t("fee.atLeast", { amount: formatOCT(minimum) }) : ""}
          </p>
        </div>
      )}
    </span>
  );
}
