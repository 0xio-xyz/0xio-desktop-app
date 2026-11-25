import { useTranslation } from "src/i18n/react";
import { Switch } from "src/shared/ui/Switch";
import { FlowCopy, FlowLayout, PrimaryButton } from "src/features/security/onboarding/StepParts";

export default function AdvancedStep({
  sealed,
  onSealed,
  onDone,
}: {
  sealed: boolean;
  onSealed: (v: boolean) => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  return (
    <FlowLayout footer={<PrimaryButton onClick={onDone}>{t("addWallet.done")}</PrimaryButton>}>
      <FlowCopy title={t("addWallet.advancedTitle")} sub={t("addWallet.advancedSub")} focusTitle />
      <label className="flex items-center gap-4 rounded-2xl bg-surface-card px-4 py-4 cursor-pointer">
        <span className="flex-1 min-w-0">
          <span className="block text-body font-semibold text-content">
            {t("addWallet.sealTitle")}
          </span>
          <span className="block text-meta text-content-secondary mt-1 leading-relaxed">
            {t("addWallet.sealDesc")}
          </span>
        </span>
        <Switch
          checked={sealed}
          onCheckedChange={onSealed}
          aria-label={t("addWallet.sealTitle")}
          className="data-[state=checked]:bg-accent"
        />
      </label>
      <p
        className="mt-3 min-h-10 px-1 text-meta text-content-secondary leading-relaxed"
        style={{ visibility: sealed ? "visible" : "hidden" }}
      >
        {t("addWallet.sealWarning")}
      </p>
    </FlowLayout>
  );
}
