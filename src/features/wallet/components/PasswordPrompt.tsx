import { useRef, useState } from "react";
import { useTranslation } from "src/i18n/react";
import AuthSheet from "src/shared/ui/AuthSheet";
import useMountEffect from "src/hooks/ui/useMountEffect";
import {
  BiometryChangedError,
  biometricService,
  biometricUsePassword,
} from "src/services/wallet/biometricService";
import { biometricLabel } from "src/features/security/onboarding/biometricLabel";
import { logger } from "src/lib/logger";

interface PasswordPromptProps {
  isOpen: boolean;
  onSubmit: (password: string) => void;
  onCancel: () => void;
  error?: string;
  title?: string;
  reason?: string;
  busy?: boolean;
}

export default function PasswordPrompt({ isOpen, ...rest }: PasswordPromptProps) {
  if (!isOpen) return null;
  return <Prompt {...rest} />;
}

function Prompt({
  onSubmit,
  onCancel,
  error = "",
  title,
  reason,
  busy = false,
}: Omit<PasswordPromptProps, "isOpen">) {
  const { t } = useTranslation();
  const [password, setPassword] = useState("");
  const [edited, setEdited] = useState(false);
  const [systemPanel, setSystemPanel] = useState<"checking" | "up" | "sent" | "off">("checking");
  const [biometric, setBiometric] = useState(false);
  const alive = useRef(true);

  const tryBiometric = async () => {
    setSystemPanel("up");
    try {
      const stored = await biometricService.unlock(reason, biometricUsePassword());
      if (!alive.current) return;
      setEdited(false);
      setSystemPanel("sent");
      onSubmit(stored);
    } catch (err) {
      logger.debug("pwPrompt", "biometric closed or failed, password instead");
      if (!alive.current) return;
      if (err instanceof BiometryChangedError) setBiometric(false);
      setSystemPanel("off");
    }
  };

  useMountEffect(() => {
    alive.current = true;
    void (async () => {
      let on = false;
      try {
        on =
          (await biometricService.isEnabled()) && (await biometricService.isAvailable()).available;
      } catch {
        on = false;
      }
      if (!alive.current) return;
      setBiometric(on);
      if (on) await tryBiometric();
      else setSystemPanel("off");
    })();
    return () => {
      alive.current = false;
    };
  });

  if (systemPanel === "checking" || systemPanel === "up") return null;
  if (systemPanel === "sent" && !error) return null;
  return (
    <AuthSheet
      title={title ?? t("backup.passwordTitle")}
      password={password}
      onPassword={(value) => {
        setPassword(value);
        setEdited(true);
        setSystemPanel("off");
      }}
      error={edited ? "" : error}
      busy={busy}
      biometric={biometric ? t("addWallet.useBiometric", { method: biometricLabel() }) : undefined}
      onBiometric={() => void tryBiometric()}
      cancelLabel={t("common.cancel")}
      submitLabel={t("onboarding.continue")}
      onCancel={onCancel}
      onSubmit={() => {
        if (!password || busy) return;
        setEdited(false);
        onSubmit(password);
      }}
    />
  );
}
