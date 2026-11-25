import { useState, useCallback } from "react";
import { useTranslation } from "src/i18n/react";
import { Btn } from "src/shared/ui/look";
import { DatePicker } from "src/shared/ui/DatePicker";
import {
  Group,
  Row,
  Segmented,
  TextAction,
  Toggle,
  Value,
} from "src/features/settings/components/parts";
import { NumField, TextField } from "src/features/settings/automations/parts";
import type {
  PrivacySettings,
  ScheduledSend,
} from "src/features/privacy/services/privacySettingsService";
import { parseOCTInput, truncateAddress } from "src/lib/format";
import { FINANCE } from "src/services/network/config";

type Frequency = "0" | "3600" | "21600" | "43200" | "86400" | "custom";

interface ScheduledSendsCardProps {
  settings: PrivacySettings;
  onAdd: (send: Omit<ScheduledSend, "id">) => void;
  onRemove: (sendId: string) => void;
  onToggle: (sendId: string) => void;
}

export default function ScheduledSendsCard({
  settings,
  onAdd,
  onRemove,
  onToggle,
}: ScheduledSendsCardProps) {
  const { t } = useTranslation();
  const [label, setLabel] = useState("");
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [interval, setInterval] = useState<Frequency>("0");
  const [customMinutes, setCustomMinutes] = useState("");
  const [isPrivate, setIsPrivate] = useState(false);
  const [maxExec, setMaxExec] = useState("");
  const [datetime, setDatetime] = useState<Date | undefined>(() => {
    const d = new Date();
    d.setMinutes(d.getMinutes() + 5);
    return d;
  });

  const resetForm = useCallback(() => {
    setLabel("");
    setTo("");
    setAmount("");
    setInterval("0");
    setCustomMinutes("");
    setIsPrivate(false);
    setMaxExec("");
  }, []);

  const handleAdd = useCallback(() => {
    const parsedAmount = parseOCTInput(amount);
    if (!label.trim() || !to.trim() || parsedAmount <= 0 || !datetime) return;
    onAdd({
      label: label.trim(),
      to: to.trim(),
      amount: parsedAmount,
      isPrivate,
      intervalSeconds:
        interval === "custom" ? (parseInt(customMinutes) || 0) * 60 : parseInt(interval),
      scheduledAt: datetime.getTime(),
      enabled: true,
      executionCount: 0,
      lastExecutedAt: null,
      maxExecutions: parseInt(maxExec) || 0,
      expiresAt: null,
    });
    resetForm();
  }, [label, to, amount, interval, isPrivate, datetime, maxExec, onAdd, resetForm, customMinutes]);

  const frequencyLabel = (seconds: number) => {
    if (seconds === 0) return t("auto.sched.once");
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
    return `${Math.floor(seconds / 86400)}d`;
  };

  const sends = settings.scheduledSends || [];

  return (
    <div className="flex flex-col gap-5">
      <Group caption={t("auto.sched.title")} right={<span>{sends.length}</span>}>
        {sends.length === 0 ? (
          <Row label={<span className="text-content-muted">{t("auto.sched.none")}</span>} />
        ) : (
          sends.map((s) => (
            <Row
              key={s.id}
              label={s.label}
              sub={<span className="font-mono">{truncateAddress(s.to, 10, 6)}</span>}
            >
              <span className="mr-3 flex items-center gap-3">
                {s.isPrivate && <Value muted>{t("auto.sched.private")}</Value>}
                <Value muted>{frequencyLabel(s.intervalSeconds)}</Value>
                <Value>{s.amount / FINANCE.MICRO_OCT_MULTIPLIER} OCT</Value>
              </span>
              <Toggle on={s.enabled} onChange={() => onToggle(s.id)} label={s.label} />
              <TextAction onClick={() => onRemove(s.id)}>{t("auto.remove")}</TextAction>
            </Row>
          ))
        )}
      </Group>

      <div className="flex flex-col gap-3">
        <Group caption={t("auto.sched.new")}>
          <Row label={t("auto.name")}>
            <TextField value={label} onChange={setLabel} label={t("auto.name")} maxLength={30} />
          </Row>
          <Row label={t("auto.sched.to")}>
            <TextField
              value={to}
              onChange={setTo}
              label={t("auto.sched.to")}
              placeholder="oct..."
              mono
            />
          </Row>
          <Row label={t("auto.amount")}>
            <NumField
              value={amount}
              onChange={setAmount}
              label={t("auto.amount")}
              unit="OCT"
              placeholder="0"
            />
          </Row>
          <Row label={t("auto.sched.frequency")}>
            {interval === "custom" && (
              <NumField
                whole
                value={customMinutes}
                onChange={setCustomMinutes}
                label={t("auto.sched.frequency")}
                unit={t("auto.min")}
              />
            )}
            <Segmented<Frequency>
              label={t("auto.sched.frequency")}
              value={interval}
              onChange={setInterval}
              options={[
                { value: "0", label: t("auto.sched.once") },
                { value: "3600", label: "1h" },
                { value: "21600", label: "6h" },
                { value: "43200", label: "12h" },
                { value: "86400", label: "24h" },
                { value: "custom", label: t("auto.custom") },
              ]}
            />
          </Row>
          <Row label={t("auto.sched.start")}>
            <DatePicker date={datetime} onDateChange={setDatetime} showTime className="w-60" />
          </Row>
          <Row label={t("auto.sched.stopAfter")}>
            <NumField
              whole
              value={maxExec}
              onChange={setMaxExec}
              label={t("auto.sched.stopAfter")}
              unit={t("auto.sched.runs")}
              placeholder={t("auto.noLimit")}
            />
          </Row>
          <Row label={t("auto.sched.private")}>
            <Toggle on={isPrivate} onChange={setIsPrivate} label={t("auto.sched.private")} />
          </Row>
        </Group>
        <div className="flex justify-end gap-2">
          <Btn size="sm" weight="text" onClick={resetForm}>
            {t("auto.clear")}
          </Btn>
          <Btn
            size="sm"
            weight="primary"
            onClick={handleAdd}
            disabled={!label.trim() || !to.trim() || parseOCTInput(amount) <= 0}
          >
            {t("auto.sched.schedule")}
          </Btn>
        </div>
      </div>
    </div>
  );
}
