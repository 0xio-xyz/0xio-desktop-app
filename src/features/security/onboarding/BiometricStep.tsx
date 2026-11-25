import { useTranslation } from "src/i18n/react";
import { Fingerprint } from "src/shared/ui/icons";
import {
  FlowHero,
  FlowLayout,
  NoteLine,
  PrimaryButton,
} from "src/features/security/onboarding/StepParts";

export default function BiometricStep({
  method,
  busy,
  error,
  onUse,
}: {
  method: string;
  busy: boolean;
  error: string;
  onUse: () => void;
}) {
  const { t } = useTranslation();
  return (
    <FlowLayout
      footer={
        <PrimaryButton onClick={onUse} loading={busy}>
          {t("addWallet.useBiometric", { method })}
        </PrimaryButton>
      }
    >
      <FlowHero
        art={<Fingerprint size={52} className="text-content" aria-hidden="true" />}
        title={t("addWallet.biometricTitle", { method })}
        sub={t("addWallet.biometricSub", { method })}
      >
        <div className="text-center">
          <NoteLine negative>{error}</NoteLine>
        </div>
      </FlowHero>
    </FlowLayout>
  );
}
