import { useNavigate } from "src/lib/router";
import { useTranslation } from "src/i18n/react";
import WalletAvatar from "src/shared/ui/WalletAvatar";
import { useWallet } from "src/contexts/useWallet";
import { BACKUP_ROUTE, walletNeedsBackup } from "src/hooks/wallet/useNeedsBackup";
import { lastUsedPhrase, pairedFrom } from "src/features/dapp/components/PairedApps";
import type { PairedAppsState } from "src/features/dapp/hooks/usePairedApps";
import {
  KV,
  Live,
  PanelCaption,
  StatusPanel,
  TextAction,
} from "src/features/settings/components/parts";
import { biometricName, type SecurityState } from "src/features/settings/hooks/useSecurityState";

export default function SecurityPanel({
  security,
  autoLockLabel,
  pairing,
  siteCount,
  waiting,
}: {
  security: SecurityState;
  autoLockLabel: string;
  pairing: PairedAppsState;
  siteCount: number;
  waiting: number | null;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { wallets } = useWallet();
  const { biometric, isHellMode } = security;
  const latest = pairing.list?.reduce<(typeof pairing.list)[number] | null>(
    (best, p) => (!best || p.last_used > best.last_used ? p : best),
    null,
  );
  const keyed = (wallets ?? []).filter((w) => w.wallet_type !== "watch");

  const bioValue = !biometric
    ? null
    : !biometric.available
      ? t("settings.notAvailable")
      : biometric.enabled
        ? t("settings.on")
        : t("settings.off");

  return (
    <StatusPanel>
      <PanelCaption>{t("settings.status")}</PanelCaption>
      <div className="h-2" />
      <KV label={biometricName(biometric?.type)} value={<Live value={bioValue} />} />
      <KV label={t("settings.autoLock")} value={autoLockLabel} />
      <KV
        label={t("pairing.pairedTitle")}
        value={<Live value={pairing.list ? pairing.list.length : null} width="w-6" />}
        sub={
          latest
            ? t("settings.lastUsedFrom", {
                when: lastUsedPhrase(t, latest.last_used),
                from: pairedFrom(t, latest.origin),
              })
            : undefined
        }
      />
      <KV
        label={t("settings.olderExtensions")}
        value={
          <Live
            value={
              pairing.settings
                ? pairing.settings.allow_legacy
                  ? t("settings.allowed")
                  : t("settings.notAllowed")
                : null
            }
          />
        }
      />
      <KV
        label={t("settings.directSites")}
        value={
          <Live
            value={
              pairing.settings
                ? pairing.settings.direct_sites
                  ? t("settings.allowed")
                  : t("settings.notAllowed")
                : null
            }
          />
        }
      />
      <KV
        label={t("settings.siteNotifications")}
        value={
          <Live
            value={
              pairing.settings && pairing.permission
                ? pairing.settings.notify_sites && pairing.permission !== "denied"
                  ? t("settings.on")
                  : t("settings.off")
                : null
            }
          />
        }
      />
      <KV
        label={t("pairing.forgetTitle")}
        value={
          <Live
            value={
              pairing.settings
                ? pairing.settings.forget_after_days === 0
                  ? t("pairing.never")
                  : t("pairing.days", { count: pairing.settings.forget_after_days })
                : null
            }
          />
        }
      />
      <KV label={t("connectedSites.title")} value={siteCount} />
      <KV label={t("relaySites.waiting")} value={<Live value={waiting} width="w-6" />} />
      {keyed.length > 0 && (
        <>
          <PanelCaption className="mt-4.5 mb-1">{t("settings.backups")}</PanelCaption>
          {keyed.map((w) => {
            const needs = walletNeedsBackup(w) && !isHellMode;
            return (
              <KV
                key={w.id}
                lead={<WalletAvatar address={w.address} size={20} />}
                label={w.name}
                muted={!needs}
                value={needs ? t("settings.notBackedUp") : t("settings.backedUp")}
                action={
                  needs ? (
                    <TextAction
                      onClick={() => navigate(`${BACKUP_ROUTE}?wallet=${encodeURIComponent(w.id)}`)}
                    >
                      {t("backup.settingsAction")}
                    </TextAction>
                  ) : undefined
                }
              />
            );
          })}
        </>
      )}
    </StatusPanel>
  );
}
