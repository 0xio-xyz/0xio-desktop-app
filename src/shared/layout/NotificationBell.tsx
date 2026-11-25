import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "src/i18n/react";
import NoticePanel from "src/shared/layout/NoticePanel";
import { BellIcon } from "src/shared/layout/navIcons";
import { GROUP_BUTTON } from "src/shared/ui/look";
import { useWallet } from "src/contexts/useWallet";
import { scopeOf, useNotices } from "src/services/notices/notifications";

function useDismiss(open: boolean, ref: React.RefObject<HTMLDivElement | null>, close: () => void) {
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    document.addEventListener("mousedown", handleClick);
    window.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      window.removeEventListener("keydown", handleKey);
    };
  }, [open, ref, close]);
}

export default React.memo(function NotificationBell() {
  const { t } = useTranslation();
  const { activeWallet, networkId } = useWallet();
  const scope = activeWallet ? scopeOf(networkId, activeWallet.address) : "";
  const view = useNotices(scope);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, ref, close);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={
          view.count > 0 ? t("notices.titleCount", { count: view.count }) : t("notices.title")
        }
        aria-expanded={open}
        className={`${GROUP_BUTTON} w-9 justify-center px-0 ${open ? "bg-surface-highlight text-content" : ""}`}
      >
        <BellIcon size={16} />
        {view.count > 0 && (
          <span className="absolute top-0 -right-0.5 grid h-4.25 min-w-4.25 place-items-center rounded-full bg-content px-1.25 text-[0.65625rem] font-semibold text-surface tabular-nums">
            {view.count > 9 ? "9+" : view.count}
          </span>
        )}
      </button>
      {open && <NoticePanel view={view} scope={scope} onClose={close} />}
    </div>
  );
});
