import { useState, useCallback } from "react";
import { useTranslation } from "src/i18n/react";
import { Btn } from "src/shared/ui/look";
import { Group, Row, Toggle } from "src/features/settings/components/parts";
import { NumField } from "src/features/settings/automations/parts";
import type { PrivacySettings } from "src/features/privacy/services/privacySettingsService";
import { parseOCTInput } from "src/lib/format";
import { FINANCE } from "src/services/network/config";

type Patch = Partial<Omit<PrivacySettings, "presets" | "scheduledSends">>;

const KEYS = {
  encrypt: {
    enabled: "autoEncryptEnabled",
    threshold: "autoEncryptThreshold",
    amount: "autoEncryptAmount",
    keep: "autoEncryptKeepMinPublic",
    cooldown: "autoEncryptCooldownMinutes",
    max: "autoEncryptMaxPerDay",
  },
  decrypt: {
    enabled: "autoDecryptEnabled",
    threshold: "autoDecryptThreshold",
    amount: "autoDecryptAmount",
    keep: "autoDecryptKeepMinEncrypted",
    cooldown: "autoDecryptCooldownMinutes",
    max: "autoDecryptMaxPerDay",
  },
} as const;

const toOCT = (micro: number) => String(micro / FINANCE.MICRO_OCT_MULTIPLIER);

export default function AutoConvertCard({
  kind,
  settings,
  onUpdate,
}: {
  kind: "encrypt" | "decrypt";
  settings: PrivacySettings;
  onUpdate: (patch: Patch) => void;
}) {
  const { t } = useTranslation();
  const k = KEYS[kind];
  const enabled = settings[k.enabled];
  const [threshold, setThreshold] = useState(toOCT(settings[k.threshold]));
  const [amount, setAmount] = useState(settings[k.amount] > 0 ? toOCT(settings[k.amount]) : "");
  const [keep, setKeep] = useState(toOCT(settings[k.keep]));
  const [cooldown, setCooldown] = useState(String(settings[k.cooldown]));
  const [maxPerDay, setMaxPerDay] = useState(String(settings[k.max]));

  const handleToggle = useCallback(() => {
    if (!enabled && settings[k.threshold] <= 0) return;
    onUpdate({ [k.enabled]: !enabled });
  }, [enabled, settings, k, onUpdate]);

  const handleSave = useCallback(() => {
    const parsedThreshold = parseOCTInput(threshold);
    if (parsedThreshold <= 0) return;
    onUpdate({
      [k.threshold]: parsedThreshold,
      [k.amount]: parseOCTInput(amount),
      [k.keep]: parseOCTInput(keep),
      [k.cooldown]: parseInt(cooldown) || 5,
      [k.max]: parseInt(maxPerDay) || 0,
    });
  }, [threshold, amount, keep, cooldown, maxPerDay, k, onUpdate]);

  return (
    <div className="flex flex-col gap-3">
      <Group
        caption={t(`auto.${kind}.title`)}
        right={
          <Toggle
            on={enabled}
            onChange={handleToggle}
            label={t(`auto.${kind}.title`)}
            disabled={kind === "decrypt"}
          />
        }
      >
        <Row label={t("auto.above")}>
          <NumField value={threshold} onChange={setThreshold} label={t("auto.above")} unit="OCT" />
        </Row>
        <Row label={t(`auto.${kind}.amount`)}>
          <NumField
            value={amount}
            onChange={setAmount}
            label={t(`auto.${kind}.amount`)}
            unit="OCT"
            placeholder={t("auto.all")}
          />
        </Row>
        <Row label={t(`auto.${kind}.keep`)}>
          <NumField value={keep} onChange={setKeep} label={t(`auto.${kind}.keep`)} unit="OCT" />
        </Row>
        <Row label={t("auto.cooldown")}>
          <NumField
            whole
            value={cooldown}
            onChange={setCooldown}
            label={t("auto.cooldown")}
            unit={t("auto.min")}
          />
        </Row>
        <Row label={t("auto.maxPerDay")}>
          <NumField
            whole
            value={maxPerDay}
            onChange={setMaxPerDay}
            label={t("auto.maxPerDay")}
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
