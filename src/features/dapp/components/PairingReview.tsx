import type { CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "src/i18n/react";
import Mascot from "src/shared/ui/Mascot";
import { ReviewDialog, ReviewNote } from "src/features/dapp/components/ReviewParts";
import { useWsPairing, type PairRequest } from "src/features/dapp/hooks/useWsPairing";

function PairHead({ request }: { request: PairRequest }) {
  const { t } = useTranslation();
  const letter = request.name.trim().charAt(0).toUpperCase() || "?";
  return (
    <div className="flex items-center gap-3">
      <span className="flex w-9 h-9 shrink-0 items-center justify-center rounded-full bg-surface-highlight text-[0.8rem] font-semibold text-content-secondary">
        {letter}
      </span>
      <div className="min-w-0 flex flex-col gap-0.5">
        <span className="text-body font-semibold text-content truncate">{request.name}</span>
        <span className="text-micro text-content-muted truncate">
          {request.origin ?? t("pairing.thisComputer")}
        </span>
      </div>
    </div>
  );
}

function Waiting() {
  const { t } = useTranslation();
  return (
    <span
      className="inline-flex h-5 items-center justify-center gap-1.5 align-top [&_.oxio-mascot]:[--mascot-body:currentColor]!"
      style={{ "--mascot-cut": "var(--color-content)" } as CSSProperties}
    >
      <Mascot id="pair-waiting" phase="ld" size={18} />
      {t("pairing.waiting")}
    </span>
  );
}

function PairedNotice() {
  const { t } = useTranslation();
  const target = typeof document !== "undefined" ? document.getElementById("content-area") : null;
  const notice = (
    <div
      className={`${target ? "absolute" : "fixed"} inset-0 z-50 flex flex-col items-center justify-center gap-3 pointer-events-none pair-done`}
      role="status"
    >
      <Mascot id="pair-done" phase="ok" size={44} />
      <span className="text-lead font-semibold text-content">{t("pairing.paired")}</span>
    </div>
  );
  return target ? createPortal(notice, target) : notice;
}

/**
 * Nothing a program or the extension asks for runs until it is paired here, and an extension
 * pairing is kept only once its user picked the same code there too.
 */
export default function PairingReview() {
  const { t } = useTranslation();
  const { current, busy, waiting, paired, approve, reject } = useWsPairing();
  if (!current) return paired ? <PairedNotice /> : null;
  const note =
    current.kind === "firefox"
      ? t("pairing.noteFirefox")
      : current.kind === "app"
        ? t("pairing.noteApp")
        : null;
  return (
    <ReviewDialog
      open
      caps={t("pairing.caps")}
      head={<PairHead request={current} />}
      heading={t("pairing.heading")}
      reject={t("pairing.reject")}
      action={waiting ? <Waiting /> : t("pairing.pair")}
      onReject={reject}
      onAction={approve}
      disabled={waiting}
      busy={busy}
    >
      <div className="rounded-2xl bg-surface-card px-4 py-3">
        <p className="text-meta text-content-secondary">{t("pairing.code")}</p>
        <p
          className="mt-1 text-[1.75rem] font-mono tracking-[0.12em] text-content tabular-nums"
          data-testid="pairing-code"
        >
          {current.code}
        </p>
      </div>
      {note && <ReviewNote>{note}</ReviewNote>}
    </ReviewDialog>
  );
}
