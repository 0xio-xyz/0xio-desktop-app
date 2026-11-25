import { useState, useCallback } from "react";
import { useTranslation } from "src/i18n/react";
import { Btn } from "src/shared/ui/look";
import { Group, Row, Segmented, Toggle } from "src/features/settings/components/parts";
import { NumField } from "src/features/settings/automations/parts";
import type { PrivacySettings } from "src/features/privacy/services/privacySettingsService";
import { parseOCTInput } from "src/lib/format";
import { FINANCE } from "src/services/network/config";

type Interval = "1" | "5" | "15" | "30" | "custom";
type ChainAction = PrivacySettings["autoClaimChainAction"];

interface AutoClaimCardProps {
  settings: PrivacySettings;
  onUpdate: (patch: Partial<Omit<PrivacySettings, "presets" | "scheduledSends">>) => void;
}

export default function AutoClaimCard({ settings, onUpdate }: AutoClaimCardProps) {
  const { t } = useTranslation();
  const [intervalVal, setIntervalVal] = useState<Interval>(() => {
    const mins = String(settings.autoClaimInterval / 60);
    return ["1", "5", "15", "30"].includes(mins) ? (mins as Interval) : "custom";
  });
  const [customMinutes, setCustomMinutes] = useState(String(settings.autoClaimInterval / 60));
  const [claimBehavior, setClaimBehavior] = useState<"all" | "one">(
    settings.autoClaimBehavior || "all",
  );
  const [chainAction, setChainAction] = useState<ChainAction>(
    settings.autoClaimChainAction || "none",
  );
  const [minAmountVal, setMinAmountVal] = useState(
    settings.autoClaimMinAmount > 0
      ? String(settings.autoClaimMinAmount / FINANCE.MICRO_OCT_MULTIPLIER)
      : "",
  );
  const [maxPerCycleVal, setMaxPerCycleVal] = useState(String(settings.autoClaimMaxPerCycle));

  const handleToggle = useCallback(() => {
    onUpdate({ autoClaimEnabled: !settings.autoClaimEnabled });
  }, [settings.autoClaimEnabled, onUpdate]);

  const handleSave = useCallback(() => {
    const mins = intervalVal === "custom" ? parseInt(customMinutes) || 5 : parseInt(intervalVal);
    onUpdate({
      autoClaimInterval: mins * 60,
      autoClaimBehavior: claimBehavior,
      autoClaimChainAction: chainAction,
      autoClaimMinAmount: parseOCTInput(minAmountVal),
      autoClaimMaxPerCycle: parseInt(maxPerCycleVal) || 0,
    });
  }, [
    intervalVal,
    customMinutes,
    claimBehavior,
    chainAction,
    minAmountVal,
    maxPerCycleVal,
    onUpdate,
  ]);

  return (
    <div className="flex flex-col gap-3">
      <Group
        caption={t("auto.claim.title")}
        right={
          <Toggle
            on={settings.autoClaimEnabled}
            onChange={handleToggle}
            label={t("auto.claim.title")}
            disabled
          />
        }
      >
        <Row label={t("auto.claim.every")}>
          {intervalVal === "custom" && (
            <NumField
              whole
              value={customMinutes}
              onChange={setCustomMinutes}
              label={t("auto.claim.every")}
              unit={t("auto.min")}
            />
          )}
          <Segmented<Interval>
            label={t("auto.claim.every")}
            value={intervalVal}
            onChange={setIntervalVal}
            options={[
              { value: "1", label: "1m" },
              { value: "5", label: "5m" },
              { value: "15", label: "15m" },
              { value: "30", label: "30m" },
              { value: "custom", label: t("auto.custom") },
            ]}
          />
        </Row>
        <Row label={t("auto.claim.behavior")}>
          <Segmented<"all" | "one">
            label={t("auto.claim.behavior")}
            value={claimBehavior}
            onChange={setClaimBehavior}
            options={[
              { value: "all", label: t("auto.claim.all") },
              { value: "one", label: t("auto.claim.one") },
            ]}
          />
        </Row>
        <Row label={t("auto.claim.after")}>
          <Segmented<ChainAction>
            label={t("auto.claim.after")}
            value={chainAction}
            onChange={setChainAction}
            options={[
              { value: "none", label: t("auto.claim.nothing") },
              { value: "encrypt", label: t("auto.op.encrypt") },
              { value: "decrypt", label: t("auto.op.decrypt") },
            ]}
          />
        </Row>
        <Row label={t("auto.claim.minAmount")}>
          <NumField
            value={minAmountVal}
            onChange={setMinAmountVal}
            label={t("auto.claim.minAmount")}
            unit="OCT"
            placeholder="0"
          />
        </Row>
        <Row label={t("auto.claim.maxPerCycle")}>
          <NumField
            whole
            value={maxPerCycleVal}
            onChange={setMaxPerCycleVal}
            label={t("auto.claim.maxPerCycle")}
            unit=""
            placeholder={t("auto.noLimit")}
          />
        </Row>
      </Group>
      <Btn size="sm" className="self-end" onClick={handleSave}>
        {t("auto.save")}
      </Btn>
    </div>
  );
}
