import React from "react";
import { useTranslation } from "src/i18n/react";
import { Plus, Download, Eye } from "src/shared/ui/icons";
import { FlowCopy } from "src/features/security/onboarding/StepParts";

interface ChooseStepProps {
  sealed: boolean;
  onCreateNew: () => void;
  onImport: () => void;
  onWatch: () => void;
  onAdvanced: () => void;
}

export default React.memo(function ChooseStep({
  sealed,
  onCreateNew,
  onImport,
  onWatch,
  onAdvanced,
}: ChooseStepProps) {
  const { t } = useTranslation();
  const OPTIONS = [
    {
      id: "create-new",
      onClick: onCreateNew,
      icon: Plus,
      title: t("onboarding.createNew"),
      desc: sealed ? t("addWallet.createSealedDesc") : t("onboarding.createNewDesc"),
    },
    {
      id: "import-wallet",
      onClick: onImport,
      icon: Download,
      title: t("onboarding.importWallet"),
      desc: t("addWallet.importDesc"),
    },
    {
      id: "watch-address",
      onClick: onWatch,
      icon: Eye,
      title: t("onboarding.watchAddress"),
      desc: t("onboarding.watchAddressDesc"),
    },
  ];

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="flex-1 min-h-0 overflow-y-auto scrollbar-hide pt-14">
        <FlowCopy title={t("onboarding.welcome")} sub={t("onboarding.welcomeDesc")} />
        <div className="space-y-2.5">
          {OPTIONS.map((opt) => (
            <button
              key={opt.id}
              onClick={opt.onClick}
              className="w-full flex items-center gap-4 p-4 rounded-2xl bg-surface-card hover:bg-surface-highlight transition-colors text-left cursor-pointer"
            >
              <span className="w-11 h-11 shrink-0 rounded-xl bg-surface flex items-center justify-center">
                <opt.icon size={20} className="text-content" aria-hidden="true" />
              </span>
              <span className="min-w-0">
                <span className="block text-base font-bold text-content">{opt.title}</span>
                <span className="block text-sm text-content-secondary mt-0.5">{opt.desc}</span>
              </span>
            </button>
          ))}
        </div>
      </div>
      <div className="shrink-0 flex justify-center pt-3 pb-8">
        <button
          type="button"
          onClick={onAdvanced}
          className="h-10 px-4 rounded-full text-body font-semibold text-content-secondary hover:text-content hover:bg-surface-card transition-colors cursor-pointer"
        >
          {sealed ? t("addWallet.advancedSealed") : t("addWallet.advancedTitle")}
        </button>
      </div>
    </div>
  );
});
