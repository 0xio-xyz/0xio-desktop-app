import React, { useState, useCallback, useRef, useEffect } from "react";
import { useTranslation } from "src/i18n/react";
import { Copy } from "src/shared/ui/icons";

interface CopyButtonProps {
  text: string;
  label?: string;
  size?: number;
}

export default React.memo(function CopyButton({ text, label, size = 14 }: CopyButtonProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), 2000);
  }, [text]);

  return (
    <button
      onClick={handleCopy}
      aria-label={label ? undefined : t("history.copy")}
      className="relative inline-flex items-center gap-1.5 text-xs text-content-secondary hover:text-content transition-colors"
    >
      <Copy size={size} />
      {label && <span>{copied ? t("common.copied") : label}</span>}
      {!label && (
        <span
          aria-hidden={!copied}
          className={`pointer-events-none absolute bottom-[calc(100%+6px)] left-1/2 z-30 -translate-x-1/2 whitespace-nowrap rounded-lg bg-(--bg-3) px-2.25 py-1.5 text-[0.75rem] text-content transition-opacity duration-200 ease-out motion-reduce:transition-none ${copied ? "opacity-100" : "opacity-0"}`}
        >
          {t("common.copied")}
        </span>
      )}
    </button>
  );
});
