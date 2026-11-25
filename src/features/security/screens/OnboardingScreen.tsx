import { useCallback, useRef, useState } from "react";
import { useNavigate } from "src/lib/router";
import { flushSync } from "react-dom";
import { useTranslation } from "src/i18n/react";
import { useWallet, type WalletData } from "src/contexts/useWallet";
import { walletBridge } from "src/services/wallet/walletBridge";
import { biometricService } from "src/services/wallet/biometricService";
import useMountEffect from "src/hooks/ui/useMountEffect";
import BrandPanel from "src/features/security/onboarding/BrandPanel";
import ChooseStep from "src/features/security/onboarding/ChooseStep";
import AdvancedStep from "src/features/security/onboarding/AdvancedStep";
import SecretStep, { type FoundWallet } from "src/features/security/onboarding/SecretStep";
import PasswordStep from "src/features/security/onboarding/PasswordStep";
import BiometricStep from "src/features/security/onboarding/BiometricStep";
import SealedPhraseStep from "src/features/security/onboarding/SealedPhraseStep";
import ReadyStep from "src/features/security/onboarding/ReadyStep";
import { AsideButton, StepHeader } from "src/features/security/onboarding/StepParts";
import { biometricLabel } from "src/features/security/onboarding/biometricLabel";
import { authErrorText } from "src/features/security/components/PhraseReveal";
import { logger } from "src/lib/logger";

type Flow = "choose" | "advanced" | "create" | "import" | "watch";
type StepId = "secret" | "password" | "confirm" | "biometric" | "phrase" | "ready";

/** A sealed wallet's phrase can only be shown before the seal, so it is shown once right before ready. */
function stepsFor(
  flow: Exclude<Flow, "choose" | "advanced">,
  o: { biometric: boolean; sealed: boolean; found: FoundWallet | null },
): StepId[] {
  if (flow === "watch" || o.found?.kind === "address") return ["secret", "ready"];
  const protect: StepId[] = [
    "password",
    "confirm",
    ...(o.biometric ? (["biometric"] as StepId[]) : []),
  ];
  if (flow === "create")
    return [...protect, ...(o.sealed ? (["phrase"] as StepId[]) : []), "ready"];
  return ["secret", ...protect, "ready"];
}

const messageOf = (err: unknown, fallback: string) =>
  err instanceof Error ? err.message : typeof err === "string" && err ? err : fallback;

export default function OnboardingScreen() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { setIsInitialized, setIsLocked, setWallets, setActiveWallet } = useWallet();
  const [flow, setFlow] = useState<Flow>("choose");
  const [at, setAt] = useState(0);
  const [sealed, setSealed] = useState(false);
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [secretText, setSecretText] = useState("");
  const [found, setFound] = useState<FoundWallet | null>(null);
  const [saved, setSaved] = useState<WalletData[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [biometric, setBiometric] = useState(false);
  const method = biometricLabel();
  const alive = useRef(true);

  useMountEffect(() => {
    alive.current = true;
    biometricService
      .isAvailable()
      .then((r) => {
        if (alive.current) setBiometric(r.available);
      })
      .catch(() => {});
    return () => {
      alive.current = false;
    };
  });

  const steps =
    flow === "choose" || flow === "advanced" ? [] : stepsFor(flow, { biometric, sealed, found });
  const step = steps[at];

  const start = (next: Flow) => {
    setFlow(next);
    setAt(0);
    setPassword("");
    setAgain("");
    setSecretText("");
    setFound(null);
    setSaved(null);
    setError("");
  };

  const go = (to: number) => {
    setError("");
    setAt(to);
  };

  const finish = useCallback(
    (wallets: WalletData[]) => {
      flushSync(() => {
        setWallets(wallets);
        setActiveWallet(wallets.find((w) => w.is_active) || wallets[0]);
        setIsInitialized(true);
        setIsLocked(false);
      });
      navigate("/");
    },
    [setWallets, setActiveWallet, setIsInitialized, setIsLocked, navigate],
  );

  const save = async (pw: string, secret: FoundWallet | null): Promise<WalletData[]> => {
    if (saved) return saved;
    let list: WalletData[];
    if (flow === "create") {
      // A sealed Create stays waiting for its seal in the vault until the phrase step is done,
      // so a quit before that step brings the phrase back on the next launch.
      list = [await walletBridge.create(pw, sealed)];
      logger.info("onboarding", "wallet created");
    } else if (secret?.kind === "address") {
      list = [await walletBridge.importAddress(secret.address)];
      logger.info("onboarding", "watch-only wallet added");
    } else if (secret?.kind === "phrase") {
      list = await walletBridge.importMnemonic(secret.words, pw);
      logger.info("onboarding", "wallet imported from a recovery phrase");
    } else if (secret?.kind === "key") {
      list = [await walletBridge.importPrivateKey(secret.key, pw)];
      logger.info("onboarding", "wallet imported from a private key");
    } else {
      throw new Error(t("wallet.importFailed"));
    }
    setSaved(list);
    return list;
  };

  const seal = async (list: WalletData[]) => {
    await walletBridge.activateHellMode();
    logger.info("onboarding", "sealed: phrase and key export off");
    const sealedList = list.map((w) => ({ ...w, exportable: false, needs_backup: false }));
    setSaved(sealedList);
    return sealedList;
  };

  const saveAndContinue = async (useBiometric: boolean, secret = found) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const list = await save(password, secret);
      if (!alive.current) return;
      if (useBiometric) {
        try {
          await biometricService.enable(password);
        } catch {
          if (alive.current) setError(t("addWallet.biometricFailed", { method }));
          return;
        }
      }
      const next = stepsFor(flow as "create" | "import" | "watch", {
        biometric,
        sealed,
        found: secret,
      });
      if (sealed && secret?.kind !== "address" && flow === "import") await seal(list);
      if (!alive.current) return;
      setAt(next.indexOf(sealed && flow === "create" ? "phrase" : "ready"));
    } catch (err) {
      logger.warn("onboarding", "save failed");
      if (alive.current)
        setError(authErrorText(err, t) ?? messageOf(err, t("wallet.creationFailed")));
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const back = () => {
    if (at === 0) {
      start("choose");
      return;
    }
    go(at - 1);
  };

  const oneWay = step === "biometric" || step === "phrase" || step === "ready";
  const savedWallet = saved?.find((w) => w.is_active) ?? saved?.[0] ?? null;

  let aside: React.ReactNode = null;
  if (step === "biometric")
    aside = (
      <AsideButton disabled={busy} onClick={() => void saveAndContinue(false)}>
        {t("addWallet.notNow")}
      </AsideButton>
    );

  let body: React.ReactNode = null;
  if (flow === "choose")
    body = (
      <ChooseStep
        sealed={sealed}
        onCreateNew={() => start("create")}
        onImport={() => start("import")}
        onWatch={() => start("watch")}
        onAdvanced={() => setFlow("advanced")}
      />
    );
  else if (flow === "advanced")
    body = <AdvancedStep sealed={sealed} onSealed={setSealed} onDone={() => setFlow("choose")} />;
  else if (step === "secret")
    body = (
      <SecretStep
        watchOnly={flow === "watch"}
        initialText={secretText}
        onText={setSecretText}
        busy={busy}
        error={error}
        onNext={(f) => {
          setFound(f);
          if (f.kind === "address") void saveAndContinue(false, f);
          else go(at + 1);
        }}
      />
    );
  else if (step === "password")
    body = (
      <PasswordStep
        phase="create"
        value={password}
        onChange={setPassword}
        first={password}
        busy={false}
        onNext={() => {
          setAgain("");
          go(at + 1);
        }}
      />
    );
  else if (step === "confirm")
    body = (
      <PasswordStep
        phase="confirm"
        value={again}
        onChange={(v) => {
          setAgain(v);
          setError("");
        }}
        first={password}
        busy={busy}
        error={error}
        onNext={() => {
          if (biometric) go(at + 1);
          else void saveAndContinue(false);
        }}
      />
    );
  else if (step === "biometric")
    body = (
      <BiometricStep
        method={method}
        busy={busy}
        error={error}
        onUse={() => void saveAndContinue(true)}
      />
    );
  else if (step === "phrase" && savedWallet)
    body = (
      <SealedPhraseStep
        wallet={savedWallet}
        password={password}
        onDone={async () => {
          const list = await walletBridge.finishSeal(savedWallet.id);
          setSaved(list);
          if (alive.current) go(steps.indexOf("ready"));
        }}
      />
    );
  else if (step === "ready" && savedWallet)
    body = (
      <ReadyStep
        name={savedWallet.name}
        address={savedWallet.address}
        viewOnly={savedWallet.wallet_type === "watch"}
        onOpen={() => saved && finish(saved)}
      />
    );

  if (step === "phrase" && savedWallet)
    return <div className="h-screen w-full overflow-hidden bg-surface">{body}</div>;

  return (
    <div className="h-screen w-full flex bg-surface overflow-hidden">
      <BrandPanel />
      <div className="flex-1 flex flex-col relative h-full bg-surface">
        <div className="w-full h-full max-w-115 px-8 mx-auto flex flex-col">
          <StepHeader
            onBack={flow !== "choose" && !oneWay && !busy ? back : undefined}
            aside={aside}
          />
          <div
            key={`${flow}-${step ?? ""}`}
            className="flex-1 min-h-0 flex flex-col animate-in fade-in duration-200 ease-out"
          >
            {body}
          </div>
        </div>
      </div>
    </div>
  );
}
