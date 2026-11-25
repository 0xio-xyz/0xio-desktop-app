import { useTranslation } from "src/i18n/react";
import Mascot from "src/shared/ui/Mascot";
import WalletAvatar from "src/shared/ui/WalletAvatar";
import {
  FlowHero,
  FlowLayout,
  InfoRow,
  PrimaryButton,
  middleCut,
} from "src/features/security/onboarding/StepParts";

export default function ReadyStep({
  name,
  address,
  viewOnly,
  onOpen,
}: {
  name: string;
  address: string;
  viewOnly: boolean;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  return (
    <FlowLayout
      footer={<PrimaryButton onClick={onOpen}>{t("addWallet.openWallet")}</PrimaryButton>}
    >
      <FlowHero art={<Mascot id="ready" phase="up" size={80} />} title={t("addWallet.readyTitle")}>
        <div className="mt-6 rounded-2xl bg-surface-card px-4">
          <InfoRow label={t("addWallet.nameRow")}>
            <span className="truncate text-content font-medium">{name}</span>
          </InfoRow>
          <InfoRow label="Octra">
            <span title={address} className="flex items-center gap-2 min-w-0">
              <WalletAvatar address={address} size={20} />
              <span className="font-mono text-meta text-content whitespace-nowrap">
                {middleCut(address)}
              </span>
            </span>
          </InfoRow>
          {viewOnly && (
            <InfoRow label={t("addWallet.accessRow")}>
              <span className="text-content font-medium">{t("addWallet.kindViewOnly")}</span>
            </InfoRow>
          )}
        </div>
      </FlowHero>
    </FlowLayout>
  );
}
