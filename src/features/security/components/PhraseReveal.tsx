import { useRef, useState } from "react";
import { useWallet } from "src/contexts/useWallet";
import useMountEffect from "src/hooks/ui/useMountEffect";
import { walletBridge } from "src/services/wallet/walletBridge";
import { watchWindowAway } from "src/features/security/services/windowAway";

export function useSecretReveal<T>() {
  const { isLocked } = useWallet();
  const [secret, setSecret] = useState<T | null>(null);
  const [shown, setShown] = useState(false);
  const [seen, setSeen] = useState(false);
  const granted = useRef(false);
  const authenticating = useRef(false);

  const drop = () => {
    setSecret(null);
    setShown(false);
    if (!granted.current) return;
    granted.current = false;
    void walletBridge.endReveal().catch(() => {});
  };

  if (isLocked && secret !== null) {
    setSecret(null);
    setShown(false);
  }

  useMountEffect(() => {
    const stop = watchWindowAway(() => {
      if (!authenticating.current) drop();
    });
    return () => {
      stop();
      drop();
    };
  });

  const take = (value: T, show = false) => {
    granted.current = true;
    setSecret(value);
    setShown(show);
    if (show) setSeen(true);
  };
  const show = () => {
    if (secret === null) return;
    setShown(true);
    setSeen(true);
  };
  const beginAuth = () => {
    authenticating.current = true;
  };
  const endAuth = () => {
    authenticating.current = false;
    if (document.visibilityState === "hidden") drop();
  };

  return {
    secret,
    shown: shown && secret !== null,
    seen,
    take,
    show,
    drop,
    beginAuth,
    endAuth,
  };
}

function authFailure(err: unknown): { wrong: boolean; seconds: number } {
  const text = String(err instanceof Error ? err.message : err);
  const wait = /too many/i.test(text) ? Number(/(\d+) seconds/.exec(text)?.[1] ?? 0) : 0;
  return { wrong: /incorrect password/i.test(text), seconds: wait };
}

export function authErrorText(
  err: unknown,
  t: (key: string, options?: Record<string, unknown>) => string,
): string | null {
  const { wrong, seconds } = authFailure(err);
  if (wrong) return t("lock.incorrectPassword");
  if (seconds) return t("lock.tooManyAttempts", { seconds });
  return null;
}
