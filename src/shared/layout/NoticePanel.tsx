import { useState } from "react";
import { useNavigate } from "src/lib/router";
import { useTranslation } from "src/i18n/react";
import { invoke } from "@tauri-apps/api/core";
import Mascot from "src/shared/ui/Mascot";
import WalletAvatar from "src/shared/ui/WalletAvatar";
import { Caps, EASE, FOCUS } from "src/shared/ui/look";
import { Toggle } from "src/features/settings/components/parts";
import { usePairedApps } from "src/features/dapp/hooks/usePairedApps";
import { SETTINGS_TAB_KEY } from "src/features/settings/services/caches";
import { DappsIcon, ReceiveIcon, SettingsIcon } from "src/shared/layout/navIcons";
import { useWallet } from "src/contexts/useWallet";
import { useAddressName } from "src/hooks/wallet/useAddressName";
import { restartToUpdate } from "src/services/app/updater";
import {
  NATIVE_GROUPS,
  noticeValues,
  setNative,
  useNativeSwitches,
} from "src/services/notices/noticeNative";
import {
  markAllRead,
  markRead,
  type Notice,
  type NoticeView,
} from "src/services/notices/notifications";
import { NETWORKS } from "src/services/network/config";
import { truncateAddress } from "src/lib/format";

const ACTION_LABEL: Record<Notice["action"]["kind"], string> = {
  view: "notices.view",
  claim: "notices.claimAction",
  retry: "activity.tryAgain",
  site: "notices.review",
  pair: "notices.review",
  settings: "notices.settings",
  privacy: "notices.open",
  restart: "notices.restart",
};

const DAY = 24 * 60 * 60 * 1000;

export function ageText(
  t: (k: string, o?: Record<string, unknown>) => string,
  at: number,
  now: number,
  locale?: string,
): string {
  const s = Math.max(0, Math.floor((now - at) / 1000));
  if (s < 60) return t("notices.now");
  if (s < 3600) return t("notices.minutes", { count: Math.floor(s / 60) });
  const start = new Date(now).setHours(0, 0, 0, 0);
  if (at >= start) return t("notices.hours", { count: Math.floor(s / 3600) });
  if (at >= start - DAY) return t("notices.yesterday");
  return new Date(at).toLocaleDateString(locale, { day: "numeric", month: "short" });
}

function Lead({ n }: { n: Notice }) {
  if (n.who) return <WalletAvatar address={n.who} size={32} />;
  const glyph =
    n.kind === "site" || n.kind === "pair" ? (
      <DappsIcon size={15} />
    ) : n.kind === "update" ? (
      <ReceiveIcon size={15} />
    ) : n.kind === "touchId" ? (
      <SettingsIcon size={15} />
    ) : (
      <Mascot id={`notice-${n.id}`} phase={n.kind === "failed" ? "up" : "ok"} size={20} />
    );
  return (
    <span className="grid size-8 shrink-0 place-items-center rounded-[10px] bg-(--bg-3) text-content-secondary">
      {glyph}
    </span>
  );
}

function Row({ n, now, onDone }: { n: Notice; now: number; onDone: () => void }) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const nameOf = useAddressName();
  const name = n.who ? (nameOf(n.who)?.name ?? truncateAddress(n.who, 8, 4)) : t("notices.someone");

  const act = () => {
    markRead(n.id);
    const a = n.action;
    if (a.kind === "view") navigate(`/history?hash=${a.hash}&net=${a.network}`);
    else if (a.kind === "claim" || a.kind === "privacy") navigate("/privacy");
    else if (a.kind === "retry") navigate(a.route, { state: { retry: a.ref } });
    else if (a.kind === "site") void invoke("site_review_open", { id: a.id }).catch(() => {});
    else if (a.kind === "settings") {
      try {
        localStorage.setItem(SETTINGS_TAB_KEY, a.tab);
      } catch {}
      navigate("/settings");
    } else if (a.kind === "restart") void restartToUpdate();
    onDone();
  };

  return (
    <div
      onClick={() => markRead(n.id)}
      className={`mx-2 grid grid-cols-[2rem_minmax(0,1fr)_auto] items-center gap-3 rounded-[14px] px-3 py-2.5 ${n.read ? "" : "bg-surface-highlight"}`}
    >
      <Lead n={n} />
      <div
        className={`line-clamp-2 text-body ${n.read ? "font-medium text-content-secondary" : "font-semibold text-content"}`}
      >
        {t(n.title, { ...noticeValues(n.values), name })}
      </div>
      <div className="flex flex-col items-end gap-1.5">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            act();
          }}
          className={`h-7.5 cursor-pointer rounded-full bg-(--bg-3) px-3 text-meta font-medium whitespace-nowrap text-content ${EASE} ${FOCUS}`}
        >
          {t(ACTION_LABEL[n.action.kind])}
        </button>
        <span className="text-micro whitespace-nowrap text-content-muted tabular-nums">
          {ageText(t, n.at, now, i18n.language)}
        </span>
      </div>
    </div>
  );
}

function NativeSwitches() {
  const { t } = useTranslation();
  const native = useNativeSwitches();
  const { settings, save } = usePairedApps();
  const rows: { key: string; on: boolean; set: (on: boolean) => void }[] = [
    {
      key: "notices.native.sites",
      on: !!settings?.notify_sites,
      set: (on) => void save({ notifySites: on }),
    },
    ...NATIVE_GROUPS.map((g) => ({
      key: `notices.native.${g}`,
      on: native[g],
      set: (on: boolean) => setNative(g, on),
    })),
  ];
  return (
    <div className="px-3 pb-3">
      <Caps className="px-2 pt-1 pb-2">{t("notices.showOnMac")}</Caps>
      <div className="rounded-[16px] bg-surface-highlight px-1">
        {rows.map((r) => (
          <div key={r.key} className="flex h-12 items-center justify-between gap-4 px-3">
            <span className="text-body text-content">{t(r.key)}</span>
            <Toggle
              on={r.on}
              onChange={r.set}
              label={t(r.key)}
              disabled={r.key === "notices.native.sites" && !settings}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

export default function NoticePanel({
  view,
  scope,
  onClose,
}: {
  view: NoticeView;
  scope: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { activeWallet, networkId } = useWallet();
  const [settings, setSettings] = useState(false);
  const now = Date.now();
  const start = new Date(now).setHours(0, 0, 0, 0);
  const today = view.list.filter((n) => n.at >= start);
  const earlier = view.list.filter((n) => n.at < start);
  const unread = view.list.some((n) => !n.read);

  return (
    <div
      role="dialog"
      aria-label={t("notices.title")}
      className="absolute top-full right-0 z-50 mt-2.5 flex h-[min(34rem,calc(100vh-7rem))] w-100 flex-col overflow-hidden rounded-[20px] bg-surface-card shadow-[0_40px_90px_-30px_rgba(0,0,0,0.95)] animate-in fade-in-0 slide-in-from-top-1 duration-200 ease-out motion-reduce:animate-none"
    >
      <div className="flex h-13 shrink-0 items-center justify-between px-5">
        <span className="text-lead font-semibold text-content">{t("notices.title")}</span>
        <span className="flex items-center gap-1">
          {!settings && unread && (
            <button
              type="button"
              onClick={() => markAllRead(scope)}
              className={`h-7.5 cursor-pointer rounded-full px-2.5 text-meta font-medium text-content hover:bg-surface-highlight ${EASE} ${FOCUS}`}
            >
              {t("notices.markAllRead")}
            </button>
          )}
          <button
            type="button"
            aria-label={t("notices.showOnMac")}
            aria-pressed={settings}
            onClick={() => setSettings((v) => !v)}
            className={`grid size-7.5 cursor-pointer place-items-center rounded-full text-content-secondary hover:bg-surface-highlight hover:text-content ${settings ? "bg-surface-highlight text-content" : ""} ${EASE} ${FOCUS}`}
          >
            <SettingsIcon size={15} />
          </button>
        </span>
      </div>
      {settings ? (
        <NativeSwitches />
      ) : (
        <>
          <div className="flex h-7 shrink-0 items-center gap-2 px-5 text-meta">
            {activeWallet && <WalletAvatar address={activeWallet.address} size={18} />}
            <span className="truncate font-medium text-content-secondary">
              {activeWallet?.name}
            </span>
            <span className="tab-caps text-content-muted">
              {NETWORKS[networkId]?.name ?? networkId}
            </span>
            {view.others > 0 && (
              <span className="ml-auto shrink-0 text-content-muted tabular-nums">
                {t("notices.others", { count: view.others })}
              </span>
            )}
          </div>
          {view.list.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-4">
              <Mascot id="notices-empty" phase="ok" size={56} />
              <span className="text-lead font-semibold text-content">{t("notices.empty")}</span>
            </div>
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto scrollbar-hide pb-2">
              {today.length > 0 && <Caps className="px-5 pt-3.5 pb-1.5">{t("notices.today")}</Caps>}
              {today.map((n) => (
                <Row key={n.id} n={n} now={now} onDone={onClose} />
              ))}
              {earlier.length > 0 && (
                <Caps className="px-5 pt-3.5 pb-1.5">{t("notices.earlier")}</Caps>
              )}
              {earlier.map((n) => (
                <Row key={n.id} n={n} now={now} onDone={onClose} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
