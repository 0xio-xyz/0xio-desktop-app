import React, { useState, useCallback, useRef, useEffect } from "react";
import { useTranslation } from "src/i18n/react";
import AuthSheet from "src/shared/ui/AuthSheet";
import { walletBridge } from "src/services/wallet/walletBridge";
import {
  BiometryChangedError,
  biometricService,
  biometricUsePassword,
} from "src/services/wallet/biometricService";
import { logger } from "src/lib/logger";

interface TransactionAuthModalProps {
  isOpen: boolean;
  onResult: (approved: boolean) => void;
  title?: string;
}

// Touch ID first when enabled, the password as the fallback. Auto-approves when the wallet has
// no password. Biometric success is the identity check; signing uses the in-session key, so no
// PBKDF2 re-run.
export default React.memo(function TransactionAuthModal({
  isOpen,
  onResult,
  title = "",
}: TransactionAuthModalProps) {
  const { t } = useTranslation();
  const [password, setPassword] = useState("");
  const [shake, setShake] = useState(0);
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);
  const [bioBusy, setBioBusy] = useState(false);
  const [bioAvailable, setBioAvailable] = useState(false);
  const [deciding, setDeciding] = useState(true);
  const inited = useRef(false);

  const tryBiometric = useCallback(async () => {
    setBioBusy(true);
    setError("");
    try {
      await biometricService.unlock(undefined, biometricUsePassword());
      logger.debug("txAuth", "biometric authorized");
      onResult(true);
    } catch (err) {
      logger.debug("txAuth", "biometric cancelled/failed - password fallback");
      if (err instanceof BiometryChangedError) setBioAvailable(false);
      setBioBusy(false);
    }
  }, [onResult]);

  useEffect(() => {
    if (!isOpen) {
      inited.current = false;
      setPassword("");
      setError("");
      setChecking(false);
      setBioBusy(false);
      setBioAvailable(false);
      setShake(0);
      setDeciding(true);
      return;
    }
    if (inited.current) return;
    inited.current = true;

    (async () => {
      try {
        const hasPassword = await walletBridge.hasPassword();
        if (!hasPassword) {
          logger.debug("txAuth", "no password set - auto-approving");
          onResult(true);
          return;
        }
      } catch {
        logger.warn("txAuth", "hasPassword check failed - showing prompt");
      }
      try {
        const enabled = await biometricService.isEnabled();
        const avail = enabled && (await biometricService.isAvailable()).available;
        setBioAvailable(avail);
        if (avail) await tryBiometric();
      } catch {
      } finally {
        setDeciding(false);
      }
    })();
  }, [isOpen, onResult, tryBiometric]);

  const handleSubmit = useCallback(async () => {
    if (!password || checking) return;
    setChecking(true);
    setError("");
    try {
      await walletBridge.unlock(password);
      logger.debug("txAuth", "password verified");
      onResult(true);
    } catch {
      setError(t("lock.wrongPassword"));
      setPassword("");
      setShake((n) => n + 1);
    } finally {
      setChecking(false);
    }
  }, [password, checking, onResult, t]);

  const handleCancel = useCallback(() => {
    setPassword("");
    setError("");
    onResult(false);
  }, [onResult]);

  // Hidden until Touch ID is ruled in or out, so the password form never flashes before it.
  if (!isOpen || bioBusy || deciding) return null;
  return (
    <AuthSheet
      title={title || t("auth.title")}
      password={password}
      onPassword={(value) => {
        setPassword(value);
        setError("");
      }}
      error={error}
      busy={checking}
      shake={shake}
      biometric={bioAvailable ? t("auth.useTouchId") : undefined}
      onBiometric={tryBiometric}
      cancelLabel={t("common.reject")}
      submitLabel={t("common.confirm")}
      onCancel={handleCancel}
      onSubmit={() => void handleSubmit()}
    />
  );
});
