import React, { useEffect, useState } from "react";
import { useTranslation } from "src/i18n/react";
import { walletBridge } from "src/services/wallet/walletBridge";
import { OPEN_COMMAND_PALETTE } from "src/shared/layout/CommandPalette";
import NotificationBell from "src/shared/layout/NotificationBell";
import { useLiveStatus } from "src/hooks/app/useLiveStatus";
import { useNow } from "src/hooks/privacy/useProofQueue";
import { useLockWallet } from "src/hooks/wallet/useLockWallet";
import { EASE, FOCUS, GROUP_BUTTON } from "src/shared/ui/look";
import { LockIcon, SearchIcon } from "src/shared/layout/navIcons";

export interface StaleRead {
  at: number | null;
}

interface TopBarProps {
  onRefresh?: () => void;
  refreshing?: boolean;
  stale?: StaleRead | null;
}

export function updatedText(
  t: (k: string, o?: Record<string, unknown>) => string,
  at: number,
  now: number,
): string {
  const s = Math.max(0, Math.floor((now - at) / 1000));
  if (s < 5) return t("topBar.updatedNow");
  if (s < 60) return t("topBar.updatedSeconds", { count: s });
  if (s < 3600) return t("topBar.updatedMinutes", { count: Math.floor(s / 60) });
  return t("topBar.updatedHours", { count: Math.floor(s / 3600) });
}

function lastUpdatedText(
  t: (k: string, o?: Record<string, unknown>) => string,
  at: number,
  now: number,
): string {
  const s = Math.max(0, Math.floor((now - at) / 1000));
  if (s < 60) return t("topBar.lastUpdatedSeconds", { count: s });
  if (s < 3600) return t("topBar.lastUpdatedMinutes", { count: Math.floor(s / 60) });
  return t("topBar.lastUpdatedHours", { count: Math.floor(s / 3600) });
}

function LiveStatus({
  onRefresh,
  refreshing,
  stale,
}: {
  onRefresh: () => void;
  refreshing: boolean;
  stale?: StaleRead | null;
}) {
  const { t } = useTranslation();
  const { updatedAt, failed } = useLiveStatus();
  const now = useNow(true);
  if (stale && !refreshing)
    return (
      <span className="inline-flex h-9 shrink-0 items-center gap-2 text-meta tabular-nums">
        <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-content-muted" />
        <span className="whitespace-nowrap text-content-muted">
          {stale.at ? lastUpdatedText(t, stale.at, now) : t("topBar.failed")}
        </span>
        <button
          type="button"
          onClick={onRefresh}
          className={`ml-1 inline-flex h-7.5 cursor-pointer items-center rounded-full bg-surface-card px-2.5 text-[0.8125rem] font-medium whitespace-nowrap text-content hover:bg-surface-highlight ${EASE} ${FOCUS}`}
        >
          {t("topBar.retry")}
        </button>
      </span>
    );
  const text = refreshing
    ? t("topBar.updating")
    : failed
      ? t("topBar.failed")
      : updatedAt
        ? updatedText(t, updatedAt, now)
        : t("topBar.updating");
  const action = failed && !refreshing ? t("topBar.retry") : t("topBar.refresh");
  return (
    <button
      type="button"
      onClick={onRefresh}
      disabled={refreshing}
      aria-label={`${text}. ${action}`}
      className={`group relative inline-flex h-9 w-44 cursor-pointer items-center justify-end gap-2 rounded-full px-2 text-meta tabular-nums disabled:cursor-default ${FOCUS}`}
    >
      <span
        aria-hidden="true"
        className={`size-1.5 shrink-0 rounded-full transition-opacity duration-200 ease-out motion-reduce:transition-none ${failed || refreshing ? "bg-content-muted" : "bg-(--pos)"} ${refreshing ? "animate-pulse" : "group-hover:opacity-0 group-focus-visible:opacity-0"}`}
      />
      <span className="grid text-right">
        <span
          className={`col-start-1 row-start-1 truncate transition-opacity duration-200 ease-out motion-reduce:transition-none ${failed ? "text-content-secondary" : "text-content-muted"} ${refreshing ? "" : "group-hover:opacity-0 group-focus-visible:opacity-0"}`}
        >
          {text}
        </span>
        <span
          className={`col-start-1 row-start-1 truncate text-content opacity-0 transition-opacity duration-200 ease-out motion-reduce:transition-none ${refreshing ? "" : "group-hover:opacity-100 group-focus-visible:opacity-100"}`}
        >
          {action}
        </span>
      </span>
    </button>
  );
}

export default React.memo(function TopBar({ onRefresh, refreshing, stale }: TopBarProps) {
  const { t } = useTranslation();

  // No password set: the lock screen would accept an empty password, so there is no lock.
  const [hasPassword, setHasPassword] = useState(false);
  useEffect(() => {
    walletBridge
      .hasPassword()
      .then(setHasPassword)
      .catch(() => {});
  }, []);

  const handleLock = useLockWallet();

  useEffect(() => {
    if (!hasPassword) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "l") {
        e.preventDefault();
        void handleLock();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hasPassword, handleLock]);

  const openSearch = () => window.dispatchEvent(new CustomEvent(OPEN_COMMAND_PALETTE));

  return (
    <div className="flex items-center justify-end gap-2.5">
      {onRefresh && <LiveStatus onRefresh={onRefresh} refreshing={!!refreshing} stale={stale} />}
      <div className="inline-flex shrink-0 items-center gap-0.5 rounded-[21px] bg-surface-card p-0.75">
        <button type="button" onClick={openSearch} className={GROUP_BUTTON}>
          <SearchIcon size={15} />
          <span className="hidden @4xl:inline">{t("topBar.search")}</span>
          <span className="font-mono text-micro tracking-[0.04em] text-content-muted">⌘K</span>
        </button>
        <NotificationBell />
        {hasPassword && (
          <button
            type="button"
            onClick={() => void handleLock()}
            aria-label={t("topBar.lock")}
            className={`group ${GROUP_BUTTON}`}
          >
            <LockIcon size={15} />
            <span className="hidden font-mono text-micro tracking-[0.04em] text-content-muted @4xl:inline">
              ⌘L
            </span>
            <span
              role="tooltip"
              className="pointer-events-none absolute top-full right-0 z-30 mt-2 rounded-[9px] bg-(--bg-3) px-2.5 py-1.75 text-meta whitespace-nowrap text-content opacity-0 transition-opacity duration-200 ease-out group-hover:opacity-100 group-focus-visible:opacity-100 motion-reduce:transition-none"
            >
              {t("topBar.lock")}
              <span className="ml-1.5 font-mono text-micro text-content-muted">⌘L</span>
            </span>
          </button>
        )}
      </div>
    </div>
  );
});
