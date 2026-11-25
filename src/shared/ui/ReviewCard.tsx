import React from "react";
import { useTranslation } from "src/i18n/react";
import { useEscapeKey } from "src/hooks/ui/useEscapeKey";
import { Btn, Caps, Card, ErrorLine, Pair } from "src/shared/ui/look";
import { feeText } from "src/services/transactions/feeText";

/** Nothing is signed before the verb; Touch ID or the password follows it as an extra step. */
export default function ReviewCard({
  caption,
  right,
  hero,
  sub,
  children,
  verb,
  onReject,
  onConfirm,
  confirmDisabled,
  busy,
  error,
  className = "",
  label,
}: {
  caption: string;
  right?: React.ReactNode;
  hero?: React.ReactNode;
  sub?: React.ReactNode;
  children: React.ReactNode;
  verb: string;
  onReject: () => void;
  onConfirm: () => void;
  confirmDisabled?: boolean;
  busy?: boolean;
  error?: string | null;
  className?: string;
  label?: string;
}) {
  const { t } = useTranslation();
  useEscapeKey(!busy, onReject);
  return (
    <Card
      className={`h-full animate-in fade-in-0 duration-250 ease-out motion-reduce:animate-none ${className}`}
      label={label ?? caption}
    >
      <Caps right={right}>{caption}</Caps>
      {hero && <div className="mt-5">{hero}</div>}
      {sub && <div className="mt-1.5 mb-2 text-[0.84375rem] text-content-muted">{sub}</div>}
      <div className={hero ? "" : "mt-3"}>{children}</div>
      <div className="flex-1" />
      <ErrorLine text={feeText(error) ?? null} />
      <Pair
        className="mt-2.5"
        left={
          <Btn onClick={onReject} disabled={busy}>
            {t("common.reject")}
          </Btn>
        }
        right={
          <Btn weight="primary" onClick={onConfirm} disabled={confirmDisabled || busy}>
            {verb}
          </Btn>
        }
      />
    </Card>
  );
}
