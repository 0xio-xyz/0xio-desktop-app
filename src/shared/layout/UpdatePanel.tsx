import { Action } from "src/shared/ui/flat";
import {
  explainUpdateError,
  formatMb,
  hideUpdate,
  installUpdate,
  restartToUpdate,
  type UpdateState,
} from "src/services/app/updater";

const TITLE: Record<Exclude<UpdateState["phase"], "idle">, string> = {
  available: "Update available",
  downloading: "Downloading update",
  installing: "Installing update",
  ready: "Update installed",
  failed: "Update failed",
};

function Progress({ fraction }: { fraction: number | null }) {
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={fraction === null ? undefined : Math.round(fraction * 100)}
      className="h-1.5 rounded-full bg-surface-recessed overflow-hidden"
    >
      <div
        className={`h-full w-full rounded-full bg-accent origin-left transition-transform duration-200 ease-out motion-reduce:transition-none ${
          fraction === null ? "animate-pulse" : ""
        }`}
        style={{ transform: `scaleX(${fraction ?? 1})` }}
      />
    </div>
  );
}

type ShownUpdate = Exclude<UpdateState, { phase: "idle" }>;

export default function UpdatePanel({ update }: { update: ShownUpdate }) {
  const fraction =
    update.phase === "downloading"
      ? update.total
        ? Math.min(update.received / update.total, 1)
        : null
      : 1;
  const failure = update.phase === "failed" ? explainUpdateError(update.error) : null;

  return (
    <div className="rounded-2xl bg-surface shadow-xl overflow-hidden">
      <div className="bg-surface-card p-4 space-y-3">
        <div>
          <p className="text-body font-semibold text-content">{TITLE[update.phase]}</p>
          <p className="text-meta text-content-secondary">0xio Desktop {update.version}</p>
        </div>

        {update.phase === "available" && update.notes && (
          <p className="text-meta text-content-secondary whitespace-pre-line max-h-32 overflow-y-auto">
            {update.notes}
          </p>
        )}

        {(update.phase === "downloading" || update.phase === "installing") && (
          <div className="space-y-1.5">
            <Progress fraction={fraction} />
            <div className="flex justify-between text-meta text-content-secondary tabular-nums">
              {update.phase === "downloading" ? (
                <>
                  <span>
                    {update.total
                      ? `${formatMb(update.received)} of ${formatMb(update.total)}`
                      : formatMb(update.received)}
                  </span>
                  {fraction !== null && <span>{Math.round(fraction * 100)}%</span>}
                </>
              ) : (
                <span>Verifying and replacing the app files</span>
              )}
            </div>
          </div>
        )}

        {update.phase === "ready" && (
          <p className="text-meta text-content-secondary">
            Restart 0xio Desktop to start using it.
          </p>
        )}

        {failure && (
          <div className="space-y-1">
            <p className="text-meta text-danger">{failure.summary}</p>
            {failure.detail && (
              <p className="text-micro text-content-muted wrap-break-word line-clamp-3 select-text">
                {failure.detail}
              </p>
            )}
          </div>
        )}

        {(update.phase === "available" ||
          update.phase === "ready" ||
          update.phase === "failed") && (
          <div className="flex gap-2 pt-1">
            <Action weight="text" className="flex-1" onClick={hideUpdate}>
              Later
            </Action>
            <Action
              weight="primary"
              className="flex-1"
              onClick={update.phase === "ready" ? restartToUpdate : installUpdate}
            >
              {update.phase === "ready"
                ? "Restart now"
                : update.phase === "failed"
                  ? "Try again"
                  : "Update now"}
            </Action>
          </div>
        )}
      </div>
    </div>
  );
}
