import { useTranslation } from "src/i18n/react";
import OUSettings from "src/features/wallet/components/OUSettings";
import { Amount, Skel, EASE, FOCUS } from "src/shared/ui/look";
import type { FeeQuote } from "src/hooks/transactions/useFees";
import { formatOCT } from "src/lib/format";

export default function FeeValue({
  quote,
  ou,
  onOUChange,
  idle,
}: {
  quote: FeeQuote;
  ou: string;
  onOUChange?: (ou: string, mode?: string) => void;
  idle?: boolean;
}) {
  const { t } = useTranslation();
  if (idle) return <Skel w="w-16" still />;
  if (quote.status === "error")
    return (
      <span className="inline-flex items-center gap-3">
        <span className="font-medium text-content">{t("fee.unavailable")}</span>
        <button
          type="button"
          onClick={quote.retry}
          className={`-mr-2 h-7.5 cursor-pointer rounded-full px-2 text-[0.84375rem] font-semibold text-content hover:bg-surface-highlight ${EASE} ${FOCUS}`}
        >
          {t("fee.retry")}
        </button>
      </span>
    );
  if (quote.status !== "ok") {
    if (!quote.last)
      return (
        <span role="status" aria-label={t("fee.checking")}>
          <Skel w="w-16" />
        </span>
      );
    return (
      <span aria-busy="true" className="opacity-50">
        <Amount value={formatOCT(Number(quote.last.recommended) || 0)} />
      </span>
    );
  }
  const value = <Amount value={formatOCT(Number(ou) || 0)} />;
  if (!onOUChange || !quote.fee) return value;
  return (
    <OUSettings ou={ou} onOUChange={onOUChange} defaultOU={quote.fee.recommended} fees={quote.fee}>
      {value}
    </OUSettings>
  );
}
