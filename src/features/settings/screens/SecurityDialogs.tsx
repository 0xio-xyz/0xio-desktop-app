import { useState } from "react";
import { useTranslation } from "src/i18n/react";
import Modal from "src/shared/ui/Modal";
import Input from "src/shared/ui/Input";
import { Action } from "src/shared/ui/flat";
import { useWallet } from "src/contexts/useWallet";
import { walletBridge } from "src/services/wallet/walletBridge";
import { authErrorText } from "src/features/security/components/PhraseReveal";
import { biometricService } from "src/services/wallet/biometricService";
import type { SecurityState } from "src/features/settings/hooks/useSecurityState";

export type PasswordMode = "change" | "remove" | "set";

export function PasswordDialog({
  mode,
  security,
  onClose,
}: {
  mode: PasswordMode | null;
  security: SecurityState;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { showMessage } = useWallet();
  const [currentPw, setCurrentPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const close = () => {
    setCurrentPw("");
    setNewPw("");
    setConfirmPw("");
    setError("");
    onClose();
  };

  const dropBiometric = async () => {
    if (!security.biometric?.enabled) return;
    await biometricService.disable().catch(() => {});
    security.setBiometricEnabled(false);
  };

  const run = async (work: () => Promise<void>, done: string) => {
    setLoading(true);
    setError("");
    try {
      await work();
      showMessage("success", done);
      close();
    } catch (err: unknown) {
      setError(authErrorText(err, t) ?? (err instanceof Error ? err.message : String(err)));
    } finally {
      setLoading(false);
    }
  };

  const checkNew = () => {
    if (newPw.length < 8) {
      setError(t("settings.atLeast8"));
      return false;
    }
    if (newPw !== confirmPw) {
      setError(t("settings.passwordsMismatch"));
      return false;
    }
    return true;
  };

  const submit = () => {
    if (mode === "remove") {
      void run(async () => {
        await walletBridge.removePassword(currentPw);
        await dropBiometric();
        security.setHasPassword(false);
      }, t("settings.passwordRemoved"));
      return;
    }
    if (!checkNew()) return;
    if (mode === "change") {
      void run(async () => {
        await walletBridge.changePassword(currentPw, newPw);
        await dropBiometric();
        security.setHasPassword(true);
      }, t("settings.passwordUpdated"));
    } else {
      void run(async () => {
        await walletBridge.changePassword("", newPw);
        security.setHasPassword(true);
      }, t("settings.passwordSet"));
    }
  };

  const title =
    mode === "remove"
      ? t("settings.removePassword")
      : mode === "set"
        ? t("settings.setPassword")
        : t("settings.changePassword");
  const ready =
    mode === "remove"
      ? !!currentPw
      : (mode === "set" || !!currentPw) && newPw.length >= 8 && newPw === confirmPw;

  return (
    <Modal isOpen={!!mode} onClose={close} title={title} hideClose look="ext">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready && !loading) submit();
        }}
      >
        {mode === "remove" && (
          <p className="text-meta leading-relaxed text-content-secondary">
            {t("settings.removePasswordWarning")} {t("settings.removePasswordAccess")}
          </p>
        )}
        {error && <p className="text-meta text-danger">{error}</p>}
        {mode !== "set" && (
          <Input
            label={t("settings.currentPassword")}
            type="password"
            value={currentPw}
            onChange={(e) => setCurrentPw(e.target.value)}
            placeholder={
              mode === "remove"
                ? t("settings.enterCurrentToConfirm")
                : t("settings.enterCurrentPassword")
            }
          />
        )}
        {mode !== "remove" && (
          <>
            <Input
              label={t("settings.newPassword")}
              type="password"
              value={newPw}
              onChange={(e) => setNewPw(e.target.value)}
              placeholder={t("settings.min8Chars")}
              error={newPw && newPw.length < 8 ? t("settings.atLeast8") : undefined}
            />
            <Input
              label={
                mode === "set" ? t("settings.confirmPassword") : t("settings.confirmNewPassword")
              }
              type="password"
              value={confirmPw}
              onChange={(e) => setConfirmPw(e.target.value)}
              placeholder={mode === "set" ? t("settings.reenterPw") : t("settings.reenterPassword")}
              error={confirmPw && newPw !== confirmPw ? t("settings.passwordsMismatch") : undefined}
            />
          </>
        )}
        <div className="flex gap-2.5">
          <Action type="button" weight="raised" full onClick={close} disabled={loading}>
            {t("common.cancel")}
          </Action>
          <Action
            type="submit"
            weight={mode === "remove" ? "danger" : "primary"}
            full
            disabled={!ready || loading}
          >
            {title}
          </Action>
        </div>
      </form>
    </Modal>
  );
}

export function HellModeDialog({
  open,
  security,
  onClose,
}: {
  open: boolean;
  security: SecurityState;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { showMessage } = useWallet();
  const [loading, setLoading] = useState(false);

  const activate = async () => {
    setLoading(true);
    try {
      await walletBridge.activateHellMode();
      security.setIsHellMode(true);
      onClose();
    } catch (err: unknown) {
      showMessage("error", err instanceof Error ? err.message : t("settings.hellModeFailed"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal isOpen={open} onClose={onClose} title={t("settings.hellModeTitle")} hideClose look="ext">
      <div className="space-y-4">
        <p className="text-meta font-semibold text-content">{t("settings.hellModePermanent")}</p>
        <ul className="ml-4 list-disc space-y-1.5 text-meta text-content-secondary">
          <li>{t("settings.hellModeLine1")}</li>
          <li>{t("settings.hellModeLine2")}</li>
          <li>{t("settings.hellModeLine3")}</li>
          <li>{t("settings.hellModeLine4")}</li>
          <li>{t("settings.hellModeLine5")}</li>
        </ul>
        <div className="flex gap-2.5">
          <Action weight="raised" full onClick={onClose} disabled={loading}>
            {t("common.reject")}
          </Action>
          <Action weight="primary" full onClick={() => void activate()} disabled={loading}>
            {t("settings.activate")}
          </Action>
        </div>
      </div>
    </Modal>
  );
}
