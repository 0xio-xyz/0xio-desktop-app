import { useState, useCallback } from "react";
import { useTranslation } from "src/i18n/react";
import { Btn, KV } from "src/shared/ui/look";
import ReviewPopup from "src/shared/ui/ReviewPopup";
import { Group, Row, Segmented, TextAction, Value } from "src/features/settings/components/parts";
import { NumField, TextField } from "src/features/settings/automations/parts";
import { useBalance } from "src/hooks/wallet/useBalance";
import { usePvac } from "src/hooks/privacy/usePvac";
import { useWallet } from "src/contexts/useWallet";
import type {
  PrivacySettings,
  PrivacyPreset,
} from "src/features/privacy/services/privacySettingsService";
import { parseOCTInput } from "src/lib/format";
import { FINANCE } from "src/services/network/config";

const MAX_PRESETS = 5;

interface PresetsCardProps {
  settings: PrivacySettings;
  onAdd: (preset: Omit<PrivacyPreset, "id">) => void;
  onRemove: (presetId: string) => void;
}

export default function PresetsCard({ settings, onAdd, onRemove }: PresetsCardProps) {
  const { t } = useTranslation();
  const { showMessage } = useWallet();
  const { publicBalance, privateBalance, refetch } = useBalance();
  const { encrypt, decrypt, isComputing } = usePvac();

  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState<"encrypt" | "decrypt">("encrypt");
  const [newAmount, setNewAmount] = useState("");
  const [confirmPreset, setConfirmPreset] = useState<PrivacyPreset | null>(null);

  const handleAdd = useCallback(() => {
    const amount = parseOCTInput(newAmount);
    if (!newName.trim() || amount <= 0) return;
    try {
      onAdd({ name: newName.trim(), type: newType, amount });
      setNewName("");
      setNewAmount("");
    } catch (err) {
      showMessage("error", err instanceof Error ? err.message : t("auto.presets.addFailed"));
    }
  }, [newName, newType, newAmount, onAdd, showMessage, t]);

  const handleRun = useCallback(
    async (preset: PrivacyPreset) => {
      setConfirmPreset(null);
      const amount = `${preset.amount / FINANCE.MICRO_OCT_MULTIPLIER} OCT`;
      const enc = preset.type === "encrypt";
      try {
        showMessage(
          "processing",
          enc ? t("auto.presets.encrypting", { amount }) : t("auto.presets.decrypting", { amount }),
        );
        if (enc) await encrypt(preset.amount);
        else await decrypt(preset.amount);
        showMessage(
          "success",
          enc ? t("auto.presets.encrypted", { amount }) : t("auto.presets.decrypted", { amount }),
        );
        refetch();
      } catch (err) {
        showMessage("error", err instanceof Error ? err.message : t("auto.presets.runFailed"));
      }
    },
    [encrypt, decrypt, showMessage, refetch, t],
  );

  const opLabel = (type: PrivacyPreset["type"]) =>
    type === "encrypt" ? t("auto.op.encrypt") : t("auto.op.decrypt");

  return (
    <div className="flex flex-col gap-5">
      <Group
        caption={t("auto.presets.title")}
        right={
          <span className="tabular-nums">
            {settings.presets.length}/{MAX_PRESETS}
          </span>
        }
      >
        {settings.presets.length === 0 ? (
          <Row label={<span className="text-content-muted">{t("auto.presets.none")}</span>} />
        ) : (
          settings.presets.map((p) => {
            const canRun =
              p.type === "encrypt" ? publicBalance >= p.amount : (privateBalance ?? 0) >= p.amount;
            return (
              <Row key={p.id} label={p.name}>
                <span className="mr-3 flex items-center gap-3">
                  <Value muted>{opLabel(p.type)}</Value>
                  <Value>{p.amount / FINANCE.MICRO_OCT_MULTIPLIER} OCT</Value>
                </span>
                <TextAction onClick={() => setConfirmPreset(p)} disabled={isComputing || !canRun}>
                  {t("auto.presets.run")}
                </TextAction>
                <TextAction onClick={() => onRemove(p.id)}>{t("auto.remove")}</TextAction>
              </Row>
            );
          })
        )}
      </Group>

      {settings.presets.length < MAX_PRESETS && (
        <div className="flex flex-col gap-3">
          <Group caption={t("auto.presets.new")}>
            <Row label={t("auto.name")}>
              <TextField
                value={newName}
                onChange={setNewName}
                label={t("auto.name")}
                maxLength={30}
              />
            </Row>
            <Row label={t("auto.presets.operation")}>
              <Segmented<"encrypt" | "decrypt">
                label={t("auto.presets.operation")}
                value={newType}
                onChange={setNewType}
                options={[
                  { value: "encrypt", label: t("auto.op.encrypt") },
                  { value: "decrypt", label: t("auto.op.decrypt") },
                ]}
              />
            </Row>
            <Row label={t("auto.amount")}>
              <NumField
                value={newAmount}
                onChange={setNewAmount}
                label={t("auto.amount")}
                unit="OCT"
                placeholder="0"
              />
            </Row>
          </Group>
          <div className="flex justify-end gap-2">
            <Btn
              size="sm"
              weight="text"
              onClick={() => {
                setNewName("");
                setNewAmount("");
              }}
            >
              {t("auto.clear")}
            </Btn>
            <Btn
              size="sm"
              weight="primary"
              onClick={handleAdd}
              disabled={!newName.trim() || parseOCTInput(newAmount) <= 0}
            >
              {t("auto.presets.add")}
            </Btn>
          </div>
        </div>
      )}

      <ReviewPopup
        open={!!confirmPreset}
        label={t("auto.presets.review")}
        caption={t("auto.presets.review")}
        verb={confirmPreset ? opLabel(confirmPreset.type) : ""}
        onReject={() => setConfirmPreset(null)}
        onConfirm={() => confirmPreset && void handleRun(confirmPreset)}
        busy={isComputing}
      >
        {confirmPreset && (
          <>
            <KV label={t("auto.presets.name")}>{confirmPreset.name}</KV>
            <KV label={t("auto.presets.operation")}>{opLabel(confirmPreset.type)}</KV>
            <KV label={t("auto.amount")}>
              {confirmPreset.amount / FINANCE.MICRO_OCT_MULTIPLIER} OCT
            </KV>
          </>
        )}
      </ReviewPopup>
    </div>
  );
}
