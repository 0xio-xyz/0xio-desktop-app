import { useTranslation } from "src/i18n/react";
import type { FeeQuote } from "src/hooks/transactions/useFees";
import { formatOCT } from "src/lib/format";

function FeeStatusValue({
  quote,
  ou,
  className = "text-micro font-mono tabular-nums text-content",
}: {
  quote: FeeQuote;
  ou: string;
  className?: string;
}) {
  const { t } = useTranslation();
  if (quote.status === "ok")
    return <span className={className}>~{formatOCT(Number(ou) || 0)} OCT</span>;
  if (quote.status === "error")
    return (
      <span className="flex items-center gap-2">
        <span className="text-micro text-content-secondary">{t("fee.unavailable")}</span>
        <button
          type="button"
          onClick={quote.retry}
          className="text-micro font-medium text-accent hover:text-accent-hover cursor-pointer"
        >
          {t("fee.retry")}
        </button>
      </span>
    );
  if (quote.last)
    return (
      <span className={`${className} opacity-50`} aria-busy="true">
        ~{formatOCT(Number(quote.last.recommended) || 0)} OCT
      </span>
    );
  return (
    <span
      role="status"
      aria-label={t("fee.checking")}
      className="inline-block h-3 w-16 rounded bg-surface-highlight animate-pulse"
    />
  );
}

export function ReviewFee({ quote, ou }: { quote: FeeQuote; ou: string }) {
  if (quote.status !== "ok") return <FeeStatusValue quote={quote} ou={ou} className="font-mono" />;
  const n = Number(ou) || 0;
  return (
    <>
      {n.toLocaleString()} OU (~{formatOCT(n)} OCT)
    </>
  );
}
