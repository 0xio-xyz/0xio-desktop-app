import { useState } from "react";
import { useNavigate, useSearchParams } from "src/lib/router";
import { Btn } from "src/shared/ui/look";
import Mascot from "src/shared/ui/Mascot";
import { useTranslation } from "src/i18n/react";
import { Screen, PageTitle, ScrollArea } from "src/shared/ui/flat";
import WatchOnlyBanner from "src/shared/layout/WatchOnlyBanner";
import { useWallet } from "src/contexts/useWallet";
import { useAutoEncrypt } from "src/hooks/privacy/useAutoEncrypt";
import { AUTOMATIONS_ENABLED, NETWORKS } from "src/services/network/config";
import { usePrivacySettings } from "src/features/settings/automations/usePrivacySettings";
import ActivityMetricsCard from "src/features/settings/automations/ActivityMetricsCard";
import PvacKeyStatusCard from "src/features/settings/automations/PvacKeyStatusCard";
import AutoConvertCard from "src/features/settings/automations/AutoConvertCard";
import AutoClaimCard from "src/features/settings/automations/AutoClaimCard";
import ScheduledSendsCard from "src/features/settings/automations/ScheduledSendsCard";
import PresetsCard from "src/features/settings/automations/PresetsCard";
import { Group, Row, Value } from "src/features/settings/components/parts";

type AutoSection = "encrypt" | "claim" | "decrypt" | "scheduled" | "presets";

const SECTIONS: { id: AutoSection; label: string }[] = [
  { id: "encrypt", label: "auto.encrypt.title" },
  { id: "claim", label: "auto.claim.title" },
  { id: "decrypt", label: "auto.decrypt.title" },
  { id: "scheduled", label: "auto.sched.title" },
  { id: "presets", label: "auto.presets.title" },
];

export default function AdvancedScreen() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { networkId, activeWallet } = useWallet();
  const privacyEnabled = NETWORKS[networkId]?.supportsPrivacy ?? false;
  const isWatchOnly = activeWallet?.wallet_type === "watch";
  const [searchParams] = useSearchParams();
  const sectionParam = searchParams.get("section");
  const initialSection: AutoSection =
    sectionParam && ["encrypt", "claim", "decrypt", "scheduled", "presets"].includes(sectionParam)
      ? (sectionParam as AutoSection)
      : "encrypt";
  const [selected, setSelected] = useState<AutoSection>(initialSection);

  useAutoEncrypt();

  const {
    settings,
    updateAutomation,
    addPreset,
    removePreset,
    addScheduledSend,
    removeScheduledSend,
    toggleScheduledSend,
  } = usePrivacySettings(networkId);

  if (isWatchOnly) return <WatchOnlyBanner title={t("advancedScreen.title")} />;

  if (!privacyEnabled) {
    return (
      <Screen>
        <PageTitle title={t("encrypt.privacyNotAvailable")} />
      </Screen>
    );
  }

  const activeCount = [
    settings.autoEncryptEnabled,
    settings.autoClaimEnabled,
    settings.autoDecryptEnabled,
  ].filter(Boolean).length;
  const scheduledCount = (settings.scheduledSends || []).filter((s) => s.enabled).length;
  const presetCount = settings.presets.length;

  const statusOf = (id: AutoSection): string => {
    switch (id) {
      case "encrypt":
        return settings.autoEncryptEnabled ? t("settings.on") : t("settings.off");
      case "claim":
        return settings.autoClaimEnabled ? t("settings.on") : t("settings.off");
      case "decrypt":
        return settings.autoDecryptEnabled ? t("settings.on") : t("settings.off");
      case "scheduled":
        return String(scheduledCount);
      case "presets":
        return String(presetCount);
    }
  };

  return (
    <Screen>
      <PageTitle title={t("advancedScreen.title")} />

      <ScrollArea className="mt-6 relative">
        {/* Inert on purpose: nothing can be toggled while the automation runners do not exist. */}
        <div
          className={
            AUTOMATIONS_ENABLED
              ? "space-y-5"
              : "pointer-events-none space-y-5 opacity-35 select-none"
          }
          aria-hidden={!AUTOMATIONS_ENABLED}
        >
          <ActivityMetricsCard networkId={networkId} />

          <PvacKeyStatusCard />

          <div className="grid grid-cols-1 gap-5 lg:grid-cols-[280px_1fr]">
            <div className="self-start">
              <Group
                caption={t("advancedScreen.title")}
                right={
                  activeCount > 0 ? <span>{t("auto.onCount", { count: activeCount })}</span> : null
                }
              >
                {SECTIONS.map((s) => (
                  <Row
                    key={s.id}
                    label={t(s.label)}
                    selected={selected === s.id}
                    onClick={() => setSelected(s.id)}
                  >
                    <Value muted>{statusOf(s.id)}</Value>
                  </Row>
                ))}
              </Group>
            </div>

            <div className="min-h-100">
              {(selected === "encrypt" || selected === "decrypt") && (
                <AutoConvertCard
                  key={selected}
                  kind={selected}
                  settings={settings}
                  onUpdate={updateAutomation}
                />
              )}
              {selected === "claim" && (
                <AutoClaimCard settings={settings} onUpdate={updateAutomation} />
              )}
              {selected === "scheduled" && (
                <ScheduledSendsCard
                  settings={settings}
                  onAdd={addScheduledSend}
                  onRemove={removeScheduledSend}
                  onToggle={toggleScheduledSend}
                />
              )}
              {selected === "presets" && (
                <PresetsCard settings={settings} onAdd={addPreset} onRemove={removePreset} />
              )}
            </div>
          </div>
        </div>

        {!AUTOMATIONS_ENABLED && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="look-raise flex w-105 flex-col items-center rounded-[22px] bg-surface-card px-8 py-7.5 text-center">
              <Mascot id="automations-soon" phase="ok" size={64} />
              <p className="mt-4.5 text-title font-semibold text-content">
                {t("advancedScreen.soonTitle")}
              </p>
              <Btn size="sm" className="mt-5" onClick={() => navigate("/privacy")}>
                {t("cipherMap.openPrivacy")}
              </Btn>
            </div>
          </div>
        )}
      </ScrollArea>
    </Screen>
  );
}
