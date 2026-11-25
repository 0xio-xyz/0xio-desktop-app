import { useCallback, useState } from "react";
import { useTranslation } from "src/i18n/react";
import Mascot from "src/shared/ui/Mascot";
import { PopupShell } from "src/shared/ui/ReviewPopup";
import { Btn, Pair, clock } from "src/shared/ui/look";
import { useEscapeKey } from "src/hooks/ui/useEscapeKey";

export default function SealedCircleModal({
  onDecrypt,
  onCancel,
  initialError,
}: {
  onDecrypt: (passphrase: string) => Promise<void>;
  onCancel: () => void;
  initialError?: string;
}) {
  const { t } = useTranslation();
  const [pp, setPp] = useState("");
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState(initialError || "");
  const cancel = useCallback(() => {
    if (!busy) onCancel();
  }, [busy, onCancel]);
  useEscapeKey(!busy, cancel);

  const startDecrypt = async () => {
    if (!pp || busy) return;
    setBusy(true);
    setError("");
    setElapsed(0);
    const t0 = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - t0) / 1000)), 500);
    try {
      await onDecrypt(pp);
    } catch (e: unknown) {
      setError(e instanceof Error && e.message ? e.message : t("circles.sealed.failed"));
      setBusy(false);
    } finally {
      clearInterval(timer);
    }
  };

  return (
    <PopupShell open label={t("circles.sealed.title")} onScrim={cancel}>
      {busy ? (
        <div className="flex flex-col items-center py-4 text-center">
          <Mascot id="sealed-circle" phase="ld" size={64} />
          <p className="mt-4 text-lead font-semibold text-content">
            {t("circles.sealed.decrypting")}
          </p>
          <p className="mt-1.5 text-meta text-content-muted tabular-nums">{clock(elapsed)}</p>
        </div>
      ) : (
        <>
          <h3 className="text-title font-semibold text-content">{t("circles.sealed.title")}</h3>
          <input
            type="password"
            value={pp}
            onChange={(e) => {
              setPp(e.target.value);
              setError("");
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") void startDecrypt();
            }}
            placeholder={t("circles.sealed.passphrase")}
            aria-label={t("circles.sealed.passphrase")}
            autoFocus
            className="mt-4 h-11.5 w-full rounded-xl bg-surface-highlight px-4 text-body text-content placeholder:text-content-muted focus:outline-none"
          />
          <p role="alert" className="mt-2 min-h-5 text-[0.8125rem] text-danger">
            {error}
          </p>
          <Pair
            className="mt-3"
            left={<Btn onClick={cancel}>{t("common.cancel")}</Btn>}
            right={
              <Btn
                weight="primary"
                data-autofocus
                onClick={() => void startDecrypt()}
                disabled={!pp}
              >
                {t("circles.sealed.decrypt")}
              </Btn>
            }
          />
        </>
      )}
    </PopupShell>
  );
}
