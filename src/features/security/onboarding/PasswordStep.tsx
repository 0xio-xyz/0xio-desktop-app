import { useTranslation } from "src/i18n/react";
import {
  FlowCopy,
  FlowLayout,
  NoteLine,
  PasswordField,
  PrimaryButton,
} from "src/features/security/onboarding/StepParts";
import { MIN_PASSWORD, strengthBars } from "src/features/security/onboarding/strength";

export default function PasswordStep({
  phase,
  value,
  onChange,
  first,
  busy,
  error = "",
  onNext,
}: {
  phase: "create" | "confirm";
  value: string;
  onChange: (v: string) => void;
  first: string;
  busy: boolean;
  error?: string;
  onNext: () => void;
}) {
  const { t } = useTranslation();
  const confirm = phase === "confirm";
  const bars = strengthBars(value);
  const mismatch = confirm && value.length > 0 && value.length >= first.length && value !== first;
  const ready = confirm ? value === first : value.length >= MIN_PASSWORD;
  const next = () => {
    if (ready && !busy) onNext();
  };

  const strengthWord = [
    t("addWallet.tooShort"),
    t("addWallet.strengthWeak"),
    t("addWallet.strengthFair"),
    t("addWallet.strengthGood"),
    t("addWallet.strengthStrong"),
  ][bars];
  const note = confirm ? (mismatch ? t("addWallet.noMatch") : "") : value ? strengthWord : "";
  const label = confirm ? t("addWallet.passwordAgain") : t("addWallet.password");

  return (
    <FlowLayout
      onSubmit={next}
      footer={
        <PrimaryButton onClick={next} disabled={!ready} loading={busy}>
          {t("onboarding.continue")}
        </PrimaryButton>
      }
    >
      <FlowCopy
        title={confirm ? t("addWallet.againTitle") : t("addWallet.passwordTitle")}
        sub={confirm ? t("addWallet.againSub") : t("addWallet.passwordSub")}
      />
      <PasswordField
        key={phase}
        value={value}
        onChange={onChange}
        label={label}
        placeholder={confirm ? label : t("addWallet.passwordPlaceholder", { n: MIN_PASSWORD })}
        invalid={mismatch}
        disabled={busy}
      />
      <div
        aria-hidden="true"
        className="flex gap-1 mt-3"
        style={{ visibility: confirm ? "hidden" : "visible" }}
      >
        {[1, 2, 3, 4].map((i) => (
          <span
            key={i}
            className={`flex-1 h-0.75 rounded-full transition-colors duration-200 ease-out ${
              i <= bars ? "bg-accent" : "bg-surface-highlight"
            }`}
          />
        ))}
      </div>
      <NoteLine negative={mismatch || !!error}>{error || note}</NoteLine>
    </FlowLayout>
  );
}
