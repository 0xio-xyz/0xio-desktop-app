import { useTranslation } from "src/i18n/react";
import type { TFunction } from "src/i18n/core";
import {
  Group,
  PillSelect,
  Row,
  TextAction,
  Toggle,
  Value,
} from "src/features/settings/components/parts";
import type { PairedAppsState } from "src/features/dapp/hooks/usePairedApps";
import type { RelayRecord } from "src/features/dapp/services/relaySites";

const FORGET_DAYS = [7, 30, 90, 0];
const DAY_MS = 86_400_000;

function daysSince(secs: number): number {
  const startOf = (ms: number) => {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  return Math.max(0, Math.round((startOf(Date.now()) - startOf(secs * 1000)) / DAY_MS));
}

export function lastUsedPhrase(t: TFunction, secs: number): string {
  const days = daysSince(secs);
  if (days === 0) return t("settings.lastUsedToday");
  if (days === 1) return t("settings.lastUsedYesterday");
  return t("settings.lastUsedDaysAgo", { count: days });
}

export function pairedFrom(t: TFunction, origin: string): string {
  if (origin.startsWith("chrome-extension://")) return "Chrome";
  if (origin.startsWith("moz-extension://")) return "Firefox";
  return t("settings.thisComputerApp");
}

export default function PairedApps({
  pairing,
  sitesOf,
  removing,
  onRemoving,
}: {
  pairing: PairedAppsState;
  sitesOf: (key: string) => RelayRecord[];
  removing: string | null;
  onRemoving: (key: string | null) => void;
}) {
  const { t } = useTranslation();
  const { list, settings, permission, forget, save, openNotifySettings } = pairing;
  const legacyOn = settings?.allow_legacy ?? true;
  const remove = (key: string) => {
    if (sitesOf(key).length > 0) return onRemoving(key);
    void forget(key);
  };

  return (
    <>
      <Group caption={t("pairing.pairedTitle")}>
        {list === null && <Row label={<span className="text-content-muted">{" "}</span>} />}
        {list?.length === 0 && (
          <Row
            label={<span className="font-normal text-content-muted">{t("settings.noPaired")}</span>}
          />
        )}
        {list?.map((p) =>
          removing === p.key ? (
            <Row key={p.key} label={p.name} sub={pairedFrom(t, p.origin)} selected>
              <span className="mr-1.5">
                <Value muted>{t("relaySites.forgets", { count: sitesOf(p.key).length })}</Value>
              </span>
              <TextAction onClick={() => onRemoving(null)}>{t("common.cancel")}</TextAction>
              <TextAction
                onClick={() => {
                  onRemoving(null);
                  void forget(p.key);
                }}
              >
                <span className="text-danger">{t("common.confirm")}</span>
              </TextAction>
            </Row>
          ) : (
            <Row key={p.key} label={p.name} sub={pairedFrom(t, p.origin)}>
              <span className="mr-1.5">
                <Value muted>{lastUsedPhrase(t, p.last_used)}</Value>
              </span>
              <TextAction onClick={() => remove(p.key)}>{t("pairing.remove")}</TextAction>
            </Row>
          ),
        )}
      </Group>
      <Group caption={t("settings.connections")}>
        <Row label={t("pairing.directTitle")}>
          <Toggle
            on={settings?.direct_sites ?? true}
            label={t("pairing.directTitle")}
            disabled={!settings}
            onChange={(on) => void save({ directSites: on })}
          />
        </Row>
        <Row label={t("pairing.legacyTitle")}>
          <Toggle
            on={legacyOn}
            label={t("pairing.legacyTitle")}
            disabled={!settings}
            onChange={(on) => void save({ allowLegacy: on })}
          />
        </Row>
        <Row label={t("pairing.notifyTitle")}>
          {permission === "denied" ? (
            <>
              <span className="mr-1.5">
                <Value muted>{t("pairing.notifyDenied")}</Value>
              </span>
              <TextAction onClick={openNotifySettings}>
                {t("pairing.notifyOpenSettings")}
              </TextAction>
            </>
          ) : (
            <Toggle
              on={settings?.notify_sites ?? true}
              label={t("pairing.notifyTitle")}
              disabled={!settings}
              onChange={(on) => void save({ notifySites: on })}
            />
          )}
        </Row>
        <Row label={t("pairing.forgetTitle")}>
          <PillSelect
            value={settings?.forget_after_days ?? 90}
            onChange={(d) => void save({ forgetAfterDays: d })}
            options={FORGET_DAYS.map((d) => ({
              value: d,
              label: d === 0 ? t("pairing.never") : t("pairing.days", { count: d }),
            }))}
            label={t("pairing.forgetTitle")}
            disabled={!settings}
          />
        </Row>
      </Group>
    </>
  );
}
