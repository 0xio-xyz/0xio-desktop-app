import { useState } from "react";
import { useTranslation } from "src/i18n/react";
import { ChevronLeft } from "src/shared/ui/icons";
import type { CallData } from "src/features/transactions/history/callRows";
import { useOverflowing } from "src/features/transactions/history/useOverflowing";
import { useCopied } from "src/features/transactions/history/useCopied";

const CLAMP_LINES = 6;

function CallBlock({
  label,
  aside,
  value,
  friendly,
  mono = true,
  copied,
  onCopy,
}: {
  label: string;
  aside?: string;
  value: string;
  friendly?: string;
  mono?: boolean;
  copied?: boolean;
  onCopy?: () => void;
}) {
  const { t } = useTranslation();
  const [all, setAll] = useState(false);
  const [clampRef, clamped] = useOverflowing<HTMLSpanElement>();
  const lines = (
    <>
      {friendly && <span className="block text-meta text-content wrap-anywhere">{friendly}</span>}
      <span
        ref={clampRef}
        data-testid="call-value"
        data-clamp={all ? "none" : CLAMP_LINES}
        className={`${mono ? "font-mono" : ""} ${
          friendly ? "text-micro text-content-secondary" : "text-meta text-content"
        } leading-normal tabular-nums wrap-anywhere`}
        style={{
          display: "-webkit-box",
          WebkitBoxOrient: "vertical",
          WebkitLineClamp: all ? "none" : CLAMP_LINES,
          overflow: "hidden",
        }}
      >
        {value}
      </span>
    </>
  );
  return (
    <div className="py-2.5" data-testid="call-block">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-meta text-content-secondary">{label}</span>
        {(copied || aside) && (
          <span
            className={`shrink-0 text-micro text-content-secondary ${copied ? "" : "font-mono"}`}
          >
            {copied ? t("history.copied", { defaultValue: "Copied" }) : aside}
          </span>
        )}
      </div>
      {onCopy ? (
        <button
          type="button"
          onClick={onCopy}
          title={t("history.copy", { defaultValue: "Copy" })}
          className="flex flex-col gap-0.5 w-full mt-1 text-left hover:opacity-80 transition-opacity cursor-pointer"
        >
          {lines}
        </button>
      ) : (
        <div className="flex flex-col gap-0.5 mt-1">{lines}</div>
      )}
      {clamped && !all && (
        <button
          type="button"
          onClick={() => setAll(true)}
          className="mt-1.5 text-meta font-medium text-accent hover:opacity-80 cursor-pointer"
        >
          {t("history.showAll", { defaultValue: "Show all" })}
        </button>
      )}
    </div>
  );
}

export default function CallDataPage({ data, onBack }: { data: CallData; onBack: () => void }) {
  const { t } = useTranslation();
  const { copy, isCopied } = useCopied();
  const block = (id: string, text: string) => ({
    copied: isCopied(id),
    onCopy: () => void copy(text, id),
  });

  return (
    <div data-testid="call-data-page">
      <div className="flex items-center gap-1 -ml-1.5 mb-3.5">
        <button
          type="button"
          onClick={onBack}
          aria-label={t("history.back", { defaultValue: "Back" })}
          autoFocus
          className="w-8 h-8 rounded-full flex items-center justify-center text-content-secondary hover:text-content hover:bg-surface-highlight transition-colors cursor-pointer"
        >
          <ChevronLeft size={18} />
        </button>
        <h3 className="text-lead font-semibold text-content">
          {t("txDetail.callData", { defaultValue: "Call data" })}
        </h3>
      </div>

      {(data.method || data.functionName || data.contract) && (
        <div className="bg-surface rounded-2xl px-5 py-1">
          {data.method && (
            <CallBlock
              label={t("txDetail.method", { defaultValue: "Method" })}
              value={data.method}
              mono={false}
            />
          )}
          {data.functionName && (
            <CallBlock
              label={t("txDetail.function", { defaultValue: "Function" })}
              value={data.functionName}
              {...block("function", data.functionName)}
            />
          )}
          {data.contract && (
            <CallBlock
              label={t("txDetail.contract", { defaultValue: "Contract" })}
              friendly={data.contract.name ?? undefined}
              value={data.contract.address}
              {...block("contract", data.contract.address)}
            />
          )}
        </div>
      )}

      {data.args.length > 0 && (
        <div className="bg-surface rounded-2xl px-5 py-1 mt-2">
          {data.args.map((arg) => (
            <CallBlock
              key={arg.index}
              label={arg.label}
              aside={arg.type}
              friendly={arg.friendly}
              value={arg.value}
              {...block(`arg-${arg.index}`, arg.value)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
