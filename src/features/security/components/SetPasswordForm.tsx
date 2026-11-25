import { useState } from "react";
import { useTranslation } from "src/i18n/react";
import Button from "src/shared/ui/Button";
import { NoteLine, PasswordField } from "src/features/security/onboarding/StepParts";
import { MIN_PASSWORD } from "src/features/security/onboarding/strength";
import { walletBridge } from "src/services/wallet/walletBridge";

export default function SetPasswordForm({
  onSet,
}: {
  onSet: (password: string) => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const mismatch = again.length > 0 && again.length >= password.length && again !== password;
  const ready = password.length >= MIN_PASSWORD && again === password;

  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setError("");
    try {
      await walletBridge.setPassword(password);
    } catch (err) {
      setError(err instanceof Error ? err.message : typeof err === "string" ? err : "");
      setBusy(false);
      return;
    }
    await onSet(password);
  };

  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <PasswordField
        value={password}
        onChange={(v) => {
          setPassword(v);
          setError("");
        }}
        label={t("addWallet.password")}
        placeholder={t("addWallet.passwordPlaceholder", { n: MIN_PASSWORD })}
        disabled={busy}
      />
      <PasswordField
        value={again}
        onChange={(v) => {
          setAgain(v);
          setError("");
        }}
        label={t("addWallet.passwordAgain")}
        invalid={mismatch}
        autoFocus={false}
        disabled={busy}
      />
      <NoteLine negative>{error || (mismatch ? t("addWallet.noMatch") : "")}</NoteLine>
      <Button type="submit" fullWidth size="lg" disabled={!ready} loading={busy}>
        {t("settings.setPassword")}
      </Button>
    </form>
  );
}
