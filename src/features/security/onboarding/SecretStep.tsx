import { useRef, useState } from "react";
import { useTranslation } from "src/i18n/react";
import WalletAvatar from "src/shared/ui/WalletAvatar";
import useMountEffect from "src/hooks/ui/useMountEffect";
import { walletBridge } from "src/services/wallet/walletBridge";
import { getBalance } from "src/services/network/networkService";
import { formatOCT } from "src/lib/format";
import {
  detectSecret,
  replaceWord,
  type Detection,
  type SecretChecks,
} from "src/features/security/onboarding/readSecret";
import { loadSecretChecks } from "src/features/security/onboarding/wordlist";
import {
  FlowCopy,
  FlowLayout,
  NoteLine,
  PrimaryButton,
  middleCut,
} from "src/features/security/onboarding/StepParts";

const SECRET_INPUT_MAX = 1024;

export type FoundWallet =
  | { kind: "phrase"; words: string[]; address: string; isPadded: boolean }
  | { kind: "key"; key: string; address: string; isPadded: boolean }
  | { kind: "address"; address: string };

export default function SecretStep({
  watchOnly = false,
  initialText = "",
  onText,
  busy,
  error = "",
  onNext,
}: {
  watchOnly?: boolean;
  initialText?: string;
  onText?: (text: string) => void;
  busy: boolean;
  error?: string;
  onNext: (found: FoundWallet) => void;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState(initialText);
  const [checks, setChecks] = useState<SecretChecks | null>(null);
  const [detection, setDetection] = useState<Detection>({ kind: "empty" });
  const [failed, setFailed] = useState(false);
  const [found, setFound] = useState<FoundWallet | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const seq = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useMountEffect(() => {
    let alive = true;
    loadSecretChecks()
      .then((c) => {
        if (!alive) return;
        setChecks(c);
        if (initialText) read(initialText, c);
      })
      .catch(() => {});
    return () => {
      alive = false;
      seq.current++;
      if (timer.current) clearTimeout(timer.current);
    };
  });

  const readBalance = (address: string, run: number) =>
    getBalance(address)
      .then((r) => {
        if (run === seq.current) setBalance(r.balance);
      })
      .catch(() => {});

  const resolve = async (d: Detection, run: number) => {
    try {
      let next: FoundWallet;
      if (d.kind === "phrase") {
        const p = await walletBridge.previewSecret(d.words.join(" "));
        next = { kind: "phrase", words: d.words, address: p.address, isPadded: p.is_padded };
      } else if (d.kind === "key") {
        const p = await walletBridge.previewSecret(d.key);
        next = { kind: "key", key: d.key, address: p.address, isPadded: p.is_padded };
      } else if (d.kind === "address") {
        next = { kind: "address", address: d.address };
      } else {
        return;
      }
      if (run !== seq.current) return;
      setFound(next);
      void readBalance(next.address, run);
    } catch {
      if (run === seq.current) setFailed(true);
    }
  };

  const read = (input: string, using: SecretChecks | null = checks) => {
    const value = input.slice(0, SECRET_INPUT_MAX);
    setText(value);
    onText?.(value);
    const run = ++seq.current;
    if (timer.current) clearTimeout(timer.current);
    setFound(null);
    setFailed(false);
    setBalance(null);
    if (!using) {
      setDetection({ kind: "empty" });
      return;
    }
    const d = detectSecret(value, using);
    setDetection(d);
    const secret = d.kind === "phrase" || d.kind === "key";
    if (secret && watchOnly) return;
    if (secret || d.kind === "address")
      timer.current = setTimeout(() => void resolve(d, run), d.kind === "address" ? 0 : 350);
  };

  const paste = () =>
    navigator.clipboard
      .readText()
      .then((v) => {
        read(v.trim());
        const kind = checks
          ? detectSecret(v.trim().slice(0, SECRET_INPUT_MAX), checks).kind
          : watchOnly
            ? "address"
            : "key";
        const harmless = ["empty", "address", "evmAddress", ...(watchOnly ? ["partial"] : [])];
        if (!harmless.includes(kind)) void walletBridge.clearPastedSecret(v).catch(() => {});
      })
      .catch(() => {});

  const ready = !!found && !busy;
  const next = () => {
    if (found && ready) onNext(found);
  };

  let note = "";
  let negative = false;
  const k = detection.kind;
  if (watchOnly && (k === "phrase" || k === "key")) {
    negative = true;
    note = t("addWallet.watchNeedsAddress");
  } else if (detection.kind === "typing" && detection.count > 1)
    note = t("addWallet.detectCount", { n: detection.count, target: detection.target });
  else if (detection.kind === "tooMany") {
    negative = true;
    note = t("addWallet.detectTooMany", { n: detection.count });
  } else if (detection.kind === "badWord") {
    negative = true;
    note = t("addWallet.detectBadWord", { word: detection.word });
  } else if (detection.kind === "phrase") {
    negative = failed;
    note = failed
      ? t("addWallet.phraseInvalid")
      : t("addWallet.detectWords", { n: detection.words.length });
  } else if (detection.kind === "key") {
    negative = failed;
    note = failed ? t("addWallet.keyInvalid") : t("addWallet.detectKey");
  } else if (detection.kind === "address") note = watchOnly ? "" : t("addWallet.detectAddress");
  else if (detection.kind === "evmKey") {
    negative = true;
    note = t("addWallet.detectEvmKey");
  } else if (detection.kind === "evmAddress") {
    negative = true;
    note = t("addWallet.detectEvmAddress");
  }

  const kindLabel =
    found?.kind === "address"
      ? t("addWallet.kindViewOnly")
      : found?.kind === "key"
        ? t("addWallet.kindKey")
        : t("addWallet.kindPhrase");
  const suggestion = detection.kind === "badWord" ? detection.suggestion : null;

  return (
    <FlowLayout
      footer={
        <PrimaryButton onClick={next} disabled={!found} loading={busy}>
          {t("onboarding.continue")}
        </PrimaryButton>
      }
    >
      <FlowCopy
        title={watchOnly ? t("addWallet.watchTitle") : t("addWallet.addTitle")}
        sub={watchOnly ? t("addWallet.watchSub") : t("addWallet.addSub")}
      />

      <div className="flex flex-col gap-2 rounded-xl bg-surface-input px-4 py-3 focus-within:ring-1 focus-within:ring-content-muted/50 transition-shadow">
        <textarea
          value={text}
          maxLength={SECRET_INPUT_MAX}
          onChange={(e) => read(e.target.value)}
          autoFocus
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          aria-label={watchOnly ? t("wallet.publicAddress") : t("addWallet.fieldLabel")}
          placeholder={watchOnly ? t("wallet.addressPlaceholder") : t("addWallet.fieldPlaceholder")}
          className="w-full h-24 bg-transparent resize-none outline-none font-mono text-meta leading-relaxed text-content placeholder:text-content-muted"
        />
        <button
          type="button"
          onClick={paste}
          className="self-start h-7 px-3 rounded-full bg-content/10 text-meta font-semibold text-content hover:bg-content/15 transition-colors cursor-pointer"
        >
          {t("addWallet.paste")}
        </button>
      </div>

      <NoteLine negative={negative || !!error}>{error || note}</NoteLine>

      <div className="mt-2 min-h-16">
        {suggestion && (
          <button
            type="button"
            onClick={() => {
              if (detection.kind === "badWord")
                read(replaceWord(text, detection.index, suggestion));
            }}
            className="h-7 px-3 rounded-full bg-accent/15 text-accent text-meta font-semibold cursor-pointer hover:bg-accent/25 transition-colors"
          >
            {t("addWallet.useWord", { word: suggestion })}
          </button>
        )}
        {found && (
          <div className="flex items-center gap-3 rounded-xl bg-surface-card p-3.5 animate-in fade-in duration-200">
            <WalletAvatar address={found.address} size={36} />
            <span className="flex-1 min-w-0 flex flex-col gap-0.5">
              <span className="font-mono text-meta text-content whitespace-nowrap">
                {middleCut(found.address)}
              </span>
              <span className="text-meta text-content-muted">{kindLabel}</span>
            </span>
            {balance !== null && (
              <span className="text-body font-semibold text-content whitespace-nowrap tabular-nums">
                {formatOCT(balance)} <span className="text-content-muted font-medium">OCT</span>
              </span>
            )}
          </div>
        )}
      </div>
    </FlowLayout>
  );
}
