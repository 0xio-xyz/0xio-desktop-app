import React, { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "src/i18n/react";
import { useEscapeKey } from "src/hooks/ui/useEscapeKey";
import { Btn, Caps, ErrorLine, Pair } from "src/shared/ui/look";
import { feeText } from "src/services/transactions/feeText";

/** The verb has focus, so Enter confirms; Touch ID or the password follows it as an extra step. */
export default function ReviewPopup({
  open,
  label,
  caption,
  right,
  hero,
  children,
  verb,
  onReject,
  onConfirm,
  confirmDisabled,
  busy,
  error,
}: {
  open: boolean;
  label: string;
  caption: React.ReactNode;
  right?: React.ReactNode;
  hero?: React.ReactNode;
  children?: React.ReactNode;
  verb: string;
  onReject: () => void;
  onConfirm: () => void;
  confirmDisabled?: boolean;
  busy?: boolean;
  error?: string | null;
}) {
  const { t } = useTranslation();
  useEscapeKey(open && !busy, onReject);
  return (
    <PopupShell open={open} label={label} onScrim={busy ? undefined : onReject}>
      <Caps right={right}>{caption}</Caps>
      {hero && <div className="mt-3.5">{hero}</div>}
      <div className="mt-3">{children}</div>
      <div className="mt-2">
        <ErrorLine text={feeText(error) ?? null} />
      </div>
      <Pair
        className="mt-2"
        left={
          <Btn onClick={onReject} disabled={busy}>
            {t("common.reject")}
          </Btn>
        }
        right={
          <Btn
            weight="primary"
            data-autofocus
            onClick={onConfirm}
            disabled={confirmDisabled || busy}
            className="look-key"
          >
            {verb}
          </Btn>
        }
      />
    </PopupShell>
  );
}

export function PopupShell({
  open,
  label,
  onScrim,
  children,
  still,
  wide,
}: {
  open: boolean;
  label: string;
  onScrim?: () => void;
  children: React.ReactNode;
  wide?: boolean;
  /** Appear without growing, when it takes over from a review that was just on screen. */
  still?: boolean;
}) {
  const sheet = useRef<HTMLDivElement>(null);
  const [from, setFrom] = useState("center");
  useLayoutEffect(() => {
    if (!open || !sheet.current) return;
    const opener = document.activeElement as HTMLElement | null;
    if (opener && opener !== document.body && !sheet.current.contains(opener)) {
      const o = opener.getBoundingClientRect();
      const r = sheet.current.getBoundingClientRect();
      setFrom(
        `${Math.round(o.left + o.width / 2 - r.left)}px ${Math.round(o.top + o.height / 2 - r.top)}px`,
      );
    }
    sheet.current.querySelector<HTMLElement>("[data-autofocus]:not(:disabled)")?.focus();
  }, [open]);
  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div data-look="ext" className="fixed inset-0 z-40 flex items-center justify-center">
      <div
        aria-hidden="true"
        onClick={onScrim}
        className="absolute inset-0 bg-(--overlay) animate-in fade-in-0 duration-200 ease-out motion-reduce:animate-none"
      />
      <div
        ref={sheet}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        style={{ transformOrigin: from }}
        className={`relative ${wide ? "w-160" : "w-135"} max-w-[calc(100vw-32px)] rounded-3xl bg-surface-card px-7 pt-6.5 pb-5.5 text-content shadow-[0_40px_90px_-30px_rgba(0,0,0,0.95),inset_0_1px_0_rgba(255,255,255,0.06)] ${still ? "" : "animate-in fade-in-0 zoom-in-97 duration-220 ease-out motion-reduce:zoom-in-100"}`}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
