import { useRef, useState } from "react";
import { useTranslation } from "src/i18n/react";
import useMountEffect from "src/hooks/ui/useMountEffect";
import { walletBridge } from "src/services/wallet/walletBridge";
import { useSecretReveal } from "src/features/security/components/PhraseReveal";
import SecretSurface, {
  SecretHeader,
  SecretStage,
  useCopied,
} from "src/features/security/components/SecretSurface";

export default function SealedPhraseStep({
  wallet,
  password,
  onDone,
}: {
  wallet: { id: string; name: string; address: string };
  password: string;
  onDone: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const reveal = useSecretReveal<string[]>();
  const { copied, flash } = useCopied();
  const [count, setCount] = useState(12);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  const words = reveal.secret;

  const load = async (show: boolean): Promise<boolean> => {
    try {
      const found = await walletBridge.exportMnemonic(wallet.id, password);
      if (!alive.current) {
        void walletBridge.endReveal().catch(() => {});
        return false;
      }
      setCount(found.length);
      reveal.take(found, show);
      return true;
    } catch {
      if (alive.current) setError(t("backup.readFailed"));
      return false;
    }
  };

  useMountEffect(() => {
    alive.current = true;
    void load(false);
    return () => {
      alive.current = false;
    };
  });

  const showWords = () => {
    setError("");
    if (words) reveal.show();
    else void load(true);
  };

  const copy = async () => {
    setError("");
    if (!words && !(await load(false))) return;
    try {
      await walletBridge.copySecret(wallet.id, "phrase");
      flash();
    } catch {
      reveal.drop();
    }
  };

  const done = async () => {
    if (busy || !reveal.seen) return;
    setBusy(true);
    setError("");
    try {
      await onDone();
    } catch {
      setError(t("backup.saveFailed"));
      setBusy(false);
    }
  };

  return (
    <SecretStage>
      <SecretHeader title={t("secret.phrase")} wallet={wallet} />
      <div className="mt-5.5">
        <SecretSurface
          kind="phrase"
          words={words}
          count={count}
          shown={reveal.shown}
          onShow={showWords}
          onHide={reveal.drop}
          onCopy={() => void copy()}
          copied={copied}
          risk="onlyTime"
          error={error}
          close={{
            label: t("backup.wrote"),
            onClick: () => void done(),
            primary: true,
            disabled: !reveal.seen,
            busy,
          }}
        />
      </div>
    </SecretStage>
  );
}
