import { useRef, useState } from "react";
import { Navigate, useNavigate, useSearchParams } from "src/lib/router";
import { useTranslation } from "src/i18n/react";
import { Screen } from "src/shared/ui/flat";
import { useWallet, type WalletData } from "src/contexts/useWallet";
import { walletBridge } from "src/services/wallet/walletBridge";
import useMountEffect from "src/hooks/ui/useMountEffect";
import {
  pendingSealWallet,
  useNeedsBackup,
  walletNeedsBackup,
  walletSecrets,
  type WalletSecret,
} from "src/hooks/wallet/useNeedsBackup";
import { toast } from "src/services/notices/activity";
import PasswordPrompt from "src/features/wallet/components/PasswordPrompt";
import { authErrorText, useSecretReveal } from "src/features/security/components/PhraseReveal";
import SecretSurface, {
  SecretHeader,
  SecretStage,
  useCopied,
} from "src/features/security/components/SecretSurface";
import { logger } from "src/lib/logger";

type After = "open" | "show" | "copy";

export default function BackupScreen() {
  const [params] = useSearchParams();
  const { activeWallet, wallets } = useWallet();
  const sealing = pendingSealWallet(wallets);
  const asked = params.get("wallet");
  const target =
    sealing ?? (asked ? (wallets?.find((w) => w.id === asked) ?? null) : null) ?? activeWallet;
  const kinds = walletSecrets(target);
  if (!target || kinds.length === 0) return <Navigate to="/" replace />;
  const wanted = params.get("kind") === "key" ? "key" : "phrase";
  const kind = kinds.includes(wanted) ? wanted : kinds[0];
  return (
    <SecretPage
      key={`${target.id}:${kind}`}
      wallet={target}
      kind={kind}
      sealing={!!sealing}
      first={!sealing && walletNeedsBackup(target) && kind === kinds[0]}
    />
  );
}

function SecretPage({
  wallet,
  kind,
  sealing,
  first,
}: {
  wallet: WalletData;
  kind: WalletSecret;
  sealing: boolean;
  first: boolean;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { markBackedUp, finishSeal } = useNeedsBackup();
  const reveal = useSecretReveal<string[] | string>();
  const { copied, flash } = useCopied();
  const [count, setCount] = useState(12);
  const [passwordless, setPasswordless] = useState(false);
  const [asking, setAsking] = useState<After | null>(null);
  const [authError, setAuthError] = useState("");
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const alive = useRef(true);
  const walletId = wallet.id;
  const readFailed = t(kind === "phrase" ? "backup.readFailed" : "backup.readFailedKey");

  const read = async (password: string): Promise<string[] | string> => {
    const found =
      kind === "phrase"
        ? await walletBridge.exportMnemonic(walletId, password)
        : await walletBridge.exportPrivateKey(walletId, password);
    if (!found.length) throw new Error("no secret");
    if (!alive.current) {
      void walletBridge.endReveal().catch(() => {});
      throw new Error("left");
    }
    if (Array.isArray(found)) setCount(found.length);
    return found;
  };

  const copyLoaded = async () => {
    try {
      await walletBridge.copySecret(walletId, kind);
      flash();
    } catch {
      reveal.drop();
    }
  };

  const loadOpen = async (after: After) => {
    setError("");
    try {
      reveal.take(await read(""), after === "show");
      if (after === "copy") await copyLoaded();
    } catch (err) {
      logger.warn("backup", "could not read the wallet", err);
      if (alive.current) setError(readFailed);
    }
  };

  const ask = (after: After) => {
    setError("");
    setAuthError("");
    reveal.beginAuth();
    setAsking(after);
  };

  useMountEffect(() => {
    alive.current = true;
    void (async () => {
      try {
        const has = await walletBridge.hasPassword();
        if (!alive.current) return;
        if (has) return ask("open");
        setPasswordless(true);
        await loadOpen("open");
      } catch (err) {
        logger.warn("backup", "could not read the wallet", err);
        if (alive.current) setError(readFailed);
      }
    })();
    return () => {
      alive.current = false;
    };
  });

  const unlockWith = async (password: string) => {
    const after = asking;
    if (!password || checking || !after) return;
    setChecking(true);
    setAuthError("");
    try {
      const found = await read(password);
      setAsking(null);
      reveal.take(found, after === "show");
      reveal.endAuth();
      if (after === "copy") await copyLoaded();
    } catch (err) {
      if (alive.current) setAuthError(authErrorText(err, t) ?? readFailed);
    } finally {
      if (alive.current) setChecking(false);
    }
  };

  const cancelAuth = () => {
    const after = asking;
    setAsking(null);
    setAuthError("");
    reveal.endAuth();
    if (after === "open" && !sealing) navigate(-1);
  };

  const need = (after: After) => (passwordless ? void loadOpen(after) : ask(after));
  const show = () => (reveal.secret !== null ? reveal.show() : need("show"));
  const copy = () => (reveal.secret !== null ? void copyLoaded() : need("copy"));

  const wrote = async () => {
    if (saving || !reveal.seen) return;
    setSaving(true);
    setError("");
    try {
      if (sealing) await finishSeal(walletId);
      else await markBackedUp(walletId);
      toast({ title: "backup.backedUp", tone: "success" });
      navigate("/", { replace: true });
    } catch (err) {
      logger.warn("backup", "could not save the backup state", err);
      setError(t("backup.saveFailed"));
      setSaving(false);
    }
  };

  const secret = reveal.secret;
  const body = (
    <>
      <SecretHeader
        title={t(kind === "phrase" ? "secret.phrase" : "secret.key")}
        wallet={wallet}
        onBack={sealing ? undefined : () => navigate(-1)}
      />
      <div className="mt-5.5">
        <SecretSurface
          kind={kind}
          words={Array.isArray(secret) ? secret : null}
          count={count}
          secretKey={typeof secret === "string" ? secret : null}
          shown={reveal.shown}
          onShow={show}
          onHide={reveal.drop}
          onCopy={copy}
          copied={copied}
          risk={sealing ? "onlyTime" : kind}
          error={error}
          close={
            sealing || first
              ? {
                  label: t(kind === "phrase" ? "backup.wrote" : "backup.wroteKey"),
                  onClick: () => void wrote(),
                  primary: true,
                  disabled: !reveal.seen,
                  busy: saving,
                }
              : { label: t("settings.done"), onClick: () => navigate(-1) }
          }
        />
      </div>
      <PasswordPrompt
        isOpen={asking !== null}
        reason={t(kind === "phrase" ? "backup.biometricReason" : "backup.biometricReasonKey")}
        error={authError}
        busy={checking}
        onSubmit={(password) => void unlockWith(password)}
        onCancel={cancelAuth}
      />
    </>
  );

  if (sealing) return <SecretStage>{body}</SecretStage>;
  return <Screen scroll>{body}</Screen>;
}
