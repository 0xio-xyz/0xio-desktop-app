import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "src/i18n/react";
import { Eye, EyeOff } from "src/shared/ui/icons";
import useMountEffect from "src/hooks/ui/useMountEffect";
import { Btn, EASE, FOCUS, Pair } from "src/shared/ui/look";

export default function AuthSheet({
  title,
  password,
  onPassword,
  error,
  busy = false,
  shake = 0,
  biometric,
  onBiometric,
  cancelLabel,
  submitLabel,
  onCancel,
  onSubmit,
}: {
  title: string;
  password: string;
  onPassword: (value: string) => void;
  error: string;
  busy?: boolean;
  shake?: number;
  biometric?: string;
  onBiometric?: () => void;
  cancelLabel: string;
  submitLabel: string;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const { t } = useTranslation();
  const [shown, setShown] = useState(false);
  const live = useRef({ busy, onCancel });
  live.current = { busy, onCancel };

  useMountEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      if (!live.current.busy) live.current.onCancel();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  if (typeof document === "undefined") return null;
  return createPortal(
    <div data-look="ext" className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        aria-hidden="true"
        onClick={() => !busy && onCancel()}
        className="absolute inset-0 bg-black/30 animate-in fade-in-0 duration-200 ease-out motion-reduce:animate-none"
      />
      <form
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
        className="look-raise relative w-92 rounded-[22px] bg-surface-card px-6 pt-5.5 pb-5 animate-in fade-in-0 zoom-in-[0.97] duration-200 ease-out motion-reduce:animate-none"
      >
        <div className="text-title font-semibold text-content">{title}</div>
        <div key={shake} className={`relative mt-4 ${shake ? "look-shake" : ""}`}>
          <input
            type={shown ? "text" : "password"}
            value={password}
            onChange={(e) => onPassword(e.target.value)}
            placeholder={t("lock.password")}
            aria-label={t("lock.password")}
            autoComplete="current-password"
            spellCheck={false}
            autoFocus
            disabled={busy}
            className={`h-11.5 w-full rounded-xl bg-surface-highlight pr-11 pl-4 text-body text-content placeholder:text-content-muted outline-none disabled:opacity-50 ${FOCUS}`}
          />
          <button
            type="button"
            onClick={() => setShown(!shown)}
            aria-label={t(shown ? "addWallet.hide" : "addWallet.show")}
            className={`absolute top-1/2 right-3 grid size-7 -translate-y-1/2 cursor-pointer place-items-center rounded-full text-content-muted hover:text-content ${EASE} ${FOCUS}`}
          >
            {shown ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        </div>
        <div className="mt-2 flex h-5 items-center justify-between gap-3 text-meta">
          <span role="alert" className="truncate text-danger">
            {error}
          </span>
          {biometric && onBiometric && (
            <button
              type="button"
              onClick={onBiometric}
              disabled={busy}
              className={`shrink-0 cursor-pointer rounded-full font-medium text-content-secondary hover:text-content disabled:cursor-default disabled:opacity-40 ${EASE} ${FOCUS}`}
            >
              {biometric}
            </button>
          )}
        </div>
        <Pair
          className="mt-3.5"
          left={
            <Btn onClick={onCancel} disabled={busy}>
              {cancelLabel}
            </Btn>
          }
          right={
            <Btn type="submit" weight="primary" disabled={!password || busy}>
              {submitLabel}
            </Btn>
          }
        />
      </form>
    </div>,
    document.body,
  );
}
