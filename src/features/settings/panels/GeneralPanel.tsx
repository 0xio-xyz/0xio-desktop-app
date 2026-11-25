import { useTranslation } from "src/i18n/react";
import type { TFunction } from "src/i18n/core";
import { LANGUAGES } from "src/i18n";
import type { UpdateState } from "src/services/app/updater";
import {
  Figure,
  KV,
  Live,
  PanelCaption,
  StatusPanel,
} from "src/features/settings/components/parts";
import { useLastUpdateCheck, useUpdateState } from "src/features/settings/hooks/useLiveInfo";

function updateStatus(t: TFunction, update: UpdateState, checkedAt: number | null): string {
  switch (update.phase) {
    case "available":
      return t("settings.updateAvailable", { version: update.version });
    case "downloading":
      return t("settings.updateDownloading");
    case "installing":
      return t("settings.updateInstalling");
    case "ready":
      return t("settings.updateReady");
    case "failed":
      return t("settings.updateFailed");
    default:
      return checkedAt ? t("settings.upToDate") : t("settings.notCheckedYet");
  }
}

function checkedLabel(t: TFunction, lang: string, at: number): string {
  const when = new Date(at);
  const time = new Intl.DateTimeFormat(lang, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(when);
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(new Date()) - day(when)) / 86_400_000);
  if (days === 0) return t("settings.todayAt", { time });
  if (days === 1) return t("settings.yesterdayAt", { time });
  return new Intl.DateTimeFormat(lang, { dateStyle: "medium", timeStyle: "short" }).format(when);
}

export default function GeneralPanel({ checking }: { checking: boolean }) {
  const { t, i18n } = useTranslation();
  const update = useUpdateState();
  const checkedAt = useLastUpdateCheck();
  const language = LANGUAGES.find((l) => l.code === i18n.language)?.label ?? i18n.language;

  return (
    <StatusPanel>
      <PanelCaption>{t("settings.updates")}</PanelCaption>
      <div className="mt-5 mb-2.5">
        <Figure label={t("settings.versionLabel")} value={__APP_VERSION__} />
      </div>
      <KV
        label={t("settings.updateLabel")}
        value={<Live value={updateStatus(t, update, checkedAt)} stale={checking} />}
      />
      <KV
        label={t("settings.lastChecked")}
        value={
          <Live
            value={checkedAt ? checkedLabel(t, i18n.language, checkedAt) : t("settings.never")}
            stale={checking}
          />
        }
      />
      <PanelCaption className="mt-4.5 mb-0.5">{t("settings.languageAndCurrency")}</PanelCaption>
      <KV label={t("settings.language")} value={language} />
      <KV label={t("settings.currency")} value="USD" />
    </StatusPanel>
  );
}
