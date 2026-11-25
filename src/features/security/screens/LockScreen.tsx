import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useNavigate } from "src/lib/router";
import { flushSync } from "react-dom";
import { useTranslation } from "src/i18n/react";
import { AlertTriangle, Fingerprint } from "src/shared/ui/icons";
import Button from "src/shared/ui/Button";
import Input from "src/shared/ui/Input";
import Modal from "src/shared/ui/Modal";
import { useWallet } from "src/contexts/useWallet";
import { walletBridge, type UnlockStatus } from "src/services/wallet/walletBridge";
import { BiometryChangedError, biometricService } from "src/services/wallet/biometricService";
import { useTokenPrice, type PricePoint } from "src/hooks/wallet/useTokenPrice";
import { isWindowShown, subscribeWindowShown } from "src/features/security/services/windowAway";
import { useAppearance } from "src/features/settings/hooks/useAppearance";
import type { LockPriceRange } from "src/features/settings/services/appearance";
import {
  HISTORY_REFRESH_MS,
  cachedHistory,
  historyIsStale,
  storeHistory,
} from "src/features/security/services/priceHistoryCache";
import LockMascot from "src/features/security/components/LockMascot";
import SetPasswordForm from "src/features/security/components/SetPasswordForm";
import TumblerBackdrop from "src/features/security/components/TumblerBackdrop";
import { useTumbler } from "src/features/security/hooks/useTumbler";
import type { LockPrice } from "src/features/security/services/tumblerDraw";
import { useLockout } from "src/features/security/hooks/useLockout";
import { biometricLabel } from "src/features/security/onboarding/biometricLabel";
import useMountEffect from "src/hooks/ui/useMountEffect";
import { useTrayUnlockRequest } from "src/hooks/app/useTrayUnlockRequest";
import { logger } from "src/lib/logger";
import {
  biometricHint,
  rememberBiometric,
  takeLockChecks,
} from "src/features/security/services/lockChecks";
import { shellReady } from "src/services/app/startup";

function attemptsWarning(
  status: Pick<UnlockStatus, "attempts_left" | "next_lockout_seconds">,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  const left = status.attempts_left;
  const seconds = status.next_lockout_seconds;
  if (left === 1) return t("lock.lastTry", { seconds });
  if (left === 2) return t("lock.triesLeft", { n: left, seconds });
  return "";
}

export default function LockScreen() {
  const { t } = useTranslation();
  const tokenPrices = useTokenPrice({ history: true, slow: true });
  const { settings: appearance } = useAppearance();
  const octPrice = tokenPrices.getPrice("OCT");
  const change24h = tokenPrices.getPrice("OCT_24H_CHANGE");
  const range = appearance.lockPriceRange;
  const [fetched, setFetched] = useState<Partial<Record<LockPriceRange, PricePoint[]>>>({});
  const rangeHistory = useMemo(() => fetched[range] ?? cachedHistory(range), [fetched, range]);
  const fetchRange = tokenPrices.fetchHistoryRange;
  useEffect(() => {
    let alive = true;
    const load = async () => {
      if (!isWindowShown()) return;
      const points = storeHistory(range, await fetchRange(range));
      if (alive && points) setFetched((prev) => ({ ...prev, [range]: points }));
    };
    const loadIfStale = () => {
      if (historyIsStale(range)) void load();
    };
    loadIfStale();
    const id = setInterval(load, HISTORY_REFRESH_MS[range]);
    const off = subscribeWindowShown((shown) => {
      if (shown) loadIfStale();
    });
    return () => {
      alive = false;
      clearInterval(id);
      off();
    };
  }, [range]);
  const lockPrice = useMemo<LockPrice | null>(() => {
    const days = range === "30d" ? 30 : range === "7d" ? 7 : 1;
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const source = rangeHistory.length || range !== "24h" ? rangeHistory : tokenPrices.priceHistory;
    const curve = source
      .map((p) => ({ time: p.time > 1e12 ? p.time : p.time * 1000, value: p.value }))
      .filter((p) => p.time >= cutoff && p.value > 0)
      .sort((a, b) => a.time - b.time);
    const stride = Math.max(1, Math.ceil(curve.length / 120));
    const history =
      stride === 1 ? curve : curve.filter((_, i) => i % stride === 0 || i === curve.length - 1);
    if (!octPrice || history.length < 2) return null;
    const first = history[0].value;
    const change =
      range === "24h" && change24h != null ? change24h : ((octPrice - first) / first) * 100;
    return { value: octPrice, change, label: range, history };
  }, [range, tokenPrices.priceHistory, rangeHistory, octPrice, change24h]);

  const navigate = useNavigate();
  const { setIsLocked, setIsInitialized, setWallets, setActiveWallet } = useWallet();
  const method = biometricLabel();
  const [password, setPassword] = useState("");
  const [reveal, setReveal] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(true);
  const [needsPassword, setNeedsPassword] = useState(false);
  const [showReset, setShowReset] = useState(false);
  const [resetInput, setResetInput] = useState("");
  const [resetting, setResetting] = useState(false);
  const [biometricEnabled, setBiometricState] = useState(biometricHint);
  const [usePassword, setUsePassword] = useState(false);
  const { seconds: lockoutSeconds, lockedOut, lockFor } = useLockout();
  const fieldRef = useRef<HTMLDivElement>(null);
  const alive = useRef(true);
  const tumbler = useTumbler();

  const setBiometricEnabled = useCallback((enabled: boolean) => {
    rememberBiometric(enabled);
    setBiometricState(enabled);
  }, []);
  const biometricMode = biometricEnabled && !usePassword;
  const focusField = () => setTimeout(() => fieldRef.current?.querySelector("input")?.focus(), 0);

  const reportFailure = useCallback(
    async (fromBiometric: boolean) => {
      const status = await walletBridge.unlockStatus().catch(() => null);
      if (!alive.current) return;
      if (status && status.locked_seconds > 0) {
        lockFor(status.locked_seconds);
        setError("");
        return;
      }
      if (fromBiometric) {
        // The stored password no longer opens the vault, so it was saved before a password
        // change. Turn it off and say why instead of failing on every open.
        await biometricService.disable().catch(() => {});
        if (!alive.current) return;
        setBiometricEnabled(false);
        setError(t("lock.biometricStale", { method }));
        focusField();
        return;
      }
      const warning = status ? attemptsWarning(status, t) : "";
      setError(warning ? `${t("lock.wrongPassword")} ${warning}` : t("lock.wrongPassword"));
      focusField();
    },
    [lockFor, method, t, setBiometricEnabled],
  );

  const doUnlock = useCallback(
    async (pw: string, fromBiometric = false) => {
      setLoading(true);
      setError("");
      logger.info("lock", "unlock attempt");
      try {
        const pending = walletBridge.unlock(pw);
        tumbler.unlock();
        const [wallets] = await Promise.all([pending, shellReady()]);
        // The unlocked state must commit before the route changes, or the route guard renders the
        // new route with the old locked state and sends it back to /lock.
        flushSync(() => {
          setWallets(wallets);
          setActiveWallet(wallets.find((w) => w.is_active) || wallets[0]);
          setIsLocked(false);
        });
        logger.info("lock", `unlocked - ${wallets.length} wallet(s) loaded`);
        navigate("/");
      } catch {
        logger.warn("lock", "unlock failed");
        setPassword("");
        tumbler.fail(0);
        await reportFailure(fromBiometric);
        if (alive.current) setLoading(false);
      }
    },
    [setWallets, setActiveWallet, setIsLocked, navigate, reportFailure, tumbler],
  );

  /** Touch ID only on a tap (here or in the menu bar panel), never by itself. */
  const handleBiometricUnlock = useCallback(async () => {
    if (loading || lockedOut) return;
    setLoading(true);
    setError("");
    logger.info("lock", "biometric unlock attempt");
    tumbler.unlock();
    let pw: string;
    try {
      pw = await biometricService.unlock();
    } catch (err) {
      logger.info("lock", "biometric unlock cancelled");
      tumbler.fail();
      if (!alive.current) return;
      setLoading(false);
      if (err instanceof BiometryChangedError) {
        setBiometricEnabled(false);
        setError(t("biometric.fingerprintsChanged", { name: method }));
        focusField();
      }
      return;
    }
    await doUnlock(pw, true);
  }, [doUnlock, loading, lockedOut, tumbler, method, t, setBiometricEnabled]);

  useTrayUnlockRequest(handleBiometricUnlock);

  useMountEffect(() => {
    alive.current = true;
    const checks = takeLockChecks();
    void (async () => {
      const password = await checks.password;
      if (!alive.current) return;
      if (password === "needed") {
        setNeedsPassword(true);
        setChecking(false);
        return;
      }
      if (password === "none") {
        await doUnlock("");
        if (alive.current) setChecking(false);
        return;
      }
      const status = await checks.status;
      if (!alive.current) return;
      if (status && status.locked_seconds > 0) lockFor(status.locked_seconds);
      setChecking(false);
    })();
    void checks.biometric.then((enabled) => {
      if (alive.current) setBiometricState(enabled);
    });
    return () => {
      alive.current = false;
    };
  });

  const handleUnlock = () => {
    if (!password || loading || lockedOut) return;
    void doUnlock(password);
  };

  const handleReset = async () => {
    if (resetInput !== "RESET") return;
    setResetting(true);
    try {
      await biometricService.disable().catch(() => {});
      await walletBridge.reset();
      setIsInitialized(false);
      setIsLocked(false);
      setShowReset(false);
      navigate("/onboarding");
    } catch {
      setError(t("lock.resetFailed"));
      setResetting(false);
    }
  };

  const openReset = () => {
    setShowReset(true);
    setResetInput("");
  };

  const note = lockedOut ? t("lock.tooManyAttempts", { seconds: lockoutSeconds }) : error;
  const primaryLabel = lockedOut
    ? t("lock.waitSeconds", { seconds: lockoutSeconds })
    : loading
      ? t("lock.unlockingButton")
      : t("lock.unlockButton");

  return (
    <div className="h-screen flex flex-col items-center justify-center bg-surface relative overflow-hidden">
      <TumblerBackdrop tumbler={tumbler} price={lockPrice} />

      <div className="max-w-sm w-full px-6 relative z-10">
        <div className="text-center space-y-4">
          <LockMascot working={loading} />
          <h1 className="text-[1.375rem] font-bold text-content">
            {needsPassword ? t("addWallet.passwordTitle") : t("lock.welcomeBack")}
          </h1>
        </div>

        <div className="mt-8 min-h-56">
          {checking ? null : needsPassword ? (
            <SetPasswordForm
              onSet={async (pw) => {
                await doUnlock(pw);
                if (alive.current) setNeedsPassword(false);
              }}
            />
          ) : biometricMode ? (
            <div className="space-y-2">
              <p role="alert" className="min-h-12 text-center text-[0.8125rem] text-danger">
                {note}
              </p>
              <Button
                fullWidth
                size="lg"
                onClick={() => void handleBiometricUnlock()}
                disabled={lockedOut}
                loading={loading}
              >
                {!lockedOut && <Fingerprint size={18} aria-hidden="true" />}
                {lockedOut
                  ? t("lock.waitSeconds", { seconds: lockoutSeconds })
                  : t("lock.unlockWithBiometric", { method })}
              </Button>
              <Button
                fullWidth
                size="lg"
                variant="ghost"
                disabled={loading}
                onClick={() => {
                  setUsePassword(true);
                  setError("");
                  focusField();
                }}
              >
                {t("lock.usePassword")}
              </Button>
            </div>
          ) : (
            <div className="space-y-2">
              <div ref={fieldRef}>
                <div
                  className={`h-12 flex items-center gap-2 pl-4 pr-1.5 rounded-xl bg-surface-input transition-shadow ${
                    error
                      ? "ring-1 ring-danger"
                      : "focus-within:ring-1 focus-within:ring-content-muted/50"
                  }`}
                >
                  <input
                    type={reveal ? "text" : "password"}
                    value={password}
                    onChange={(e) => {
                      setPassword(e.target.value);
                      tumbler.type(e.target.value.length);
                      if (error) setError("");
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleUnlock();
                    }}
                    placeholder={t("lock.password")}
                    aria-label={t("lock.password")}
                    aria-invalid={!!error}
                    autoComplete="current-password"
                    spellCheck={false}
                    autoFocus
                    disabled={loading || lockedOut}
                    className="flex-1 min-w-0 bg-transparent text-body text-content placeholder:text-content-muted outline-none disabled:opacity-60"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      setReveal((v) => !v);
                      focusField();
                    }}
                    aria-pressed={reveal}
                    disabled={loading || lockedOut}
                    className="h-9 px-3 rounded-lg text-meta font-semibold text-content-muted hover:text-content hover:bg-surface-highlight transition-colors cursor-pointer disabled:opacity-40"
                  >
                    {reveal ? t("addWallet.hide") : t("addWallet.show")}
                  </button>
                </div>
                <p
                  role="alert"
                  className="min-h-12 pt-2 pl-1 text-[0.8125rem] leading-snug text-danger"
                >
                  {note}
                </p>
              </div>

              <Button
                fullWidth
                size="lg"
                onClick={handleUnlock}
                disabled={!password || lockedOut}
                loading={loading}
              >
                {primaryLabel}
              </Button>

              <div className="flex items-center justify-center gap-6 pt-1">
                {biometricEnabled && (
                  <button
                    type="button"
                    onClick={() => {
                      setUsePassword(false);
                      void handleBiometricUnlock();
                    }}
                    disabled={loading || lockedOut}
                    className="py-2 text-[0.8125rem] font-semibold text-content-secondary hover:text-content transition-colors cursor-pointer disabled:opacity-50"
                  >
                    {t("lock.useBiometricShort", { method })}
                  </button>
                )}
                <button
                  type="button"
                  onClick={openReset}
                  className="py-2 text-[0.8125rem] font-semibold text-content-muted hover:text-content transition-colors cursor-pointer"
                >
                  {t("lock.forgotPassword")}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      <Modal
        isOpen={showReset}
        onClose={() => setShowReset(false)}
        title={t("lock.resetWallet")}
        hideClose
      >
        <ResetModalContent
          resetInput={resetInput}
          setResetInput={setResetInput}
          resetting={resetting}
          onCancel={() => setShowReset(false)}
          onReset={handleReset}
        />
      </Modal>
    </div>
  );
}

function ResetModalContent({
  resetInput,
  setResetInput,
  resetting,
  onCancel,
  onReset,
}: {
  resetInput: string;
  setResetInput: (v: string) => void;
  resetting: boolean;
  onCancel: () => void;
  onReset: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2 rounded-xl bg-danger/10 border border-danger/20 p-3">
        <AlertTriangle size={16} className="text-danger shrink-0 mt-0.5" />
        <div>
          <p className="text-sm text-danger font-medium">{t("lock.resetDeleteWarning")}</p>
          <p className="text-sm text-content-muted mt-1">{t("lock.resetDeleteDesc")}</p>
        </div>
      </div>
      <Input
        label={t("settings.typeResetToConfirm")}
        value={resetInput}
        onChange={(e) => setResetInput(e.target.value)}
        placeholder="RESET"
      />
      <div className="flex gap-3">
        <Button variant="secondary" fullWidth onClick={onCancel} disabled={resetting}>
          {t("common.cancel")}
        </Button>
        <Button
          variant="danger"
          fullWidth
          onClick={onReset}
          disabled={resetInput !== "RESET"}
          loading={resetting}
        >
          {t("settings.deleteEverything")}
        </Button>
      </div>
    </div>
  );
}
