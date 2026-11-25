import { Suspense, lazy, useEffect, useSyncExternalStore } from "react";
import { getUpdateSnapshot, startUpdateChecks, subscribeUpdates } from "src/services/app/updater";
import { afterFirstScreen } from "src/services/app/startup";

const UpdatePanel = lazy(() => import("src/shared/layout/UpdatePanel"));

export default function UpdateChecker() {
  const { update, hidden } = useSyncExternalStore(subscribeUpdates, getUpdateSnapshot);

  useEffect(() => {
    let stop: (() => void) | null = null;
    let live = true;
    afterFirstScreen(() => {
      if (live) stop = startUpdateChecks();
    });
    return () => {
      live = false;
      stop?.();
    };
  }, []);

  if (update.phase === "idle" || hidden) return null;

  return (
    <Suspense fallback={null}>
      <div
        role="status"
        aria-live="polite"
        className="fixed bottom-4 right-4 z-100 w-80 max-w-[calc(100vw-2rem)] transition-[opacity,translate] duration-200 ease-out starting:opacity-0 starting:translate-y-2 motion-reduce:transition-none"
      >
        <UpdatePanel update={update} />
      </div>
    </Suspense>
  );
}
