import React, { useRef, useState } from "react";
import { Trans, useTranslation } from "src/i18n/react";
import { ChevronLeft } from "src/shared/ui/icons";
import "src/css/look-ext.css";
import WalletAvatar from "src/shared/ui/WalletAvatar";
import { Btn, EASE, FOCUS } from "src/shared/ui/look";
import useMountEffect from "src/hooks/ui/useMountEffect";

type SecretKind = "phrase" | "key";

const BARS = ["w-[42%]", "w-[54%]", "w-[36%]", "w-[48%]", "w-[58%]", "w-[40%]"];
const FADE = "animate-in fade-in-0 duration-200 ease-out motion-reduce:animate-none";

const GRID = {
  12: "grid-cols-3 grid-rows-4 gap-2.5 text-[min(1.75rem,3.8cqw)] @3xl:grid-cols-4 @3xl:grid-rows-3 @3xl:text-[min(1.75rem,2.88cqw)]",
  24: "grid-cols-3 grid-rows-8 gap-2 text-[min(1.25rem,3.8cqw)] @2xl:grid-cols-4 @2xl:grid-rows-6 @2xl:text-[min(1.25rem,2.88cqw)] @4xl:grid-cols-6 @4xl:grid-rows-4 @4xl:text-[min(1.25rem,1.9cqw)]",
};

export function useCopied(ms = 1500) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useMountEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  });
  const flash = () => {
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), ms);
  };
  return { copied, flash };
}

function Words({ words, shown, count }: { words: string[] | null; shown: boolean; count: number }) {
  const visible = shown && !!words;
  const cells = visible ? words : Array.from({ length: count }, () => "");
  return (
    <div
      aria-hidden={!visible}
      data-testid="phrase-grid"
      className={`grid h-95 select-none ${cells.length > 12 ? GRID[24] : GRID[12]}`}
    >
      {cells.map((word, i) => (
        <span
          key={i}
          className="flex min-w-0 items-center gap-[0.45em] rounded-2xl bg-surface-highlight px-[0.9em]"
        >
          <span className="w-[1.5em] shrink-0 font-mono text-[max(0.5em,0.75rem)] text-content-muted tabular-nums">
            {i + 1}
          </span>
          {visible ? (
            <span className={`font-semibold tracking-[-0.01em] whitespace-nowrap ${FADE}`}>
              {word}
            </span>
          ) : (
            <span className={`h-3 shrink-0 rounded-md bg-(--bg-3) ${BARS[i % BARS.length]}`} />
          )}
        </span>
      ))}
    </div>
  );
}

function KeyLines({ value, shown }: { value: string | null; shown: boolean }) {
  const visible = shown && !!value;
  const half = visible ? Math.ceil(value.length / 2) : 22;
  const lines = visible ? [value.slice(0, half), value.slice(half)] : ["", ""];
  return (
    <div
      aria-hidden={!visible}
      data-testid="private-key"
      className="flex h-95 flex-col items-center justify-center gap-2 rounded-2xl bg-surface-highlight select-none"
      style={{ fontSize: `min(2.5rem, ${(100 / (half * 0.64 + 1.5)).toFixed(2)}cqw)` }}
    >
      {lines.map((line, i) => (
        <span key={i} className="flex h-[1.5em] items-center">
          {visible ? (
            <span className={`font-mono tracking-[0.04em] whitespace-nowrap ${FADE}`}>{line}</span>
          ) : (
            <span className="h-4 w-[13em] rounded-lg bg-(--bg-3)" />
          )}
        </span>
      ))}
    </div>
  );
}

export function SecretHeader({
  title,
  wallet,
  onBack,
}: {
  title: string;
  wallet?: { name: string; address: string } | null;
  onBack?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="mt-1 flex h-10 shrink-0 items-center justify-between gap-4">
      <div className="flex min-w-0 items-center gap-1">
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            aria-label={t("common.back")}
            className={`-ml-2.5 grid size-9 shrink-0 cursor-pointer place-items-center rounded-full text-content-secondary hover:bg-surface-card hover:text-content ${EASE} ${FOCUS}`}
          >
            <ChevronLeft size={20} aria-hidden="true" />
          </button>
        )}
        <h1 className="truncate text-[1.75rem] leading-none font-semibold tracking-[-0.02em] text-content">
          {title}
        </h1>
      </div>
      {wallet && (
        <span className="inline-flex min-w-0 shrink-0 items-center gap-2.25 text-body font-medium whitespace-nowrap text-content-secondary">
          <WalletAvatar address={wallet.address} size={22} />
          <span className="truncate">{wallet.name}</span>
        </span>
      )}
    </div>
  );
}

export function SecretStage({ children }: { children: React.ReactNode }) {
  return (
    <div data-look="ext" className="h-full w-full overflow-y-auto bg-surface scrollbar-hide">
      <div className="mx-auto flex w-full max-w-5xl flex-col px-7 pt-11.5 pb-7">{children}</div>
    </div>
  );
}

export default function SecretSurface({
  kind,
  words,
  count = 12,
  secretKey,
  shown,
  onShow,
  onHide,
  onCopy,
  copied,
  risk,
  error,
  close,
}: {
  kind: SecretKind;
  words?: string[] | null;
  count?: number;
  secretKey?: string | null;
  shown: boolean;
  onShow: () => void;
  onHide: () => void;
  onCopy: () => void;
  copied: boolean;
  risk: "phrase" | "key" | "onlyTime";
  error?: string;
  close: {
    label: string;
    onClick: () => void;
    primary?: boolean;
    disabled?: boolean;
    busy?: boolean;
  };
}) {
  const { t } = useTranslation();
  return (
    <section
      aria-label={t(kind === "phrase" ? "secret.phrase" : "secret.key")}
      className="look-raise rounded-[22px] bg-surface-card p-5.5"
    >
      <div className="@container">
        {kind === "phrase" ? (
          <Words words={words ?? null} shown={shown} count={count} />
        ) : (
          <KeyLines value={secretKey ?? null} shown={shown} />
        )}
        <div className="mt-3.5 flex flex-wrap items-center gap-2.5 @4xl:flex-nowrap">
          <div
            role={error ? "alert" : undefined}
            className={`flex min-h-11.5 min-w-0 basis-full items-center rounded-[14px] bg-surface-highlight px-4.5 py-2 text-lead @4xl:flex-1 @4xl:basis-0 ${error ? "text-danger" : "text-content-secondary"}`}
          >
            <span>
              {error || (
                <Trans
                  i18nKey={`backup.risk.${risk}`}
                  components={{ b: <b className="font-semibold text-content" /> }}
                />
              )}
            </span>
          </div>
          <Btn
            className="w-28 shrink-0 px-2!"
            aria-pressed={shown}
            onClick={shown ? onHide : onShow}
          >
            {shown ? t("backup.hide") : t("backup.show")}
          </Btn>
          <Btn className={`w-28 shrink-0 px-2! ${copied ? "bg-(--bg-3)!" : ""}`} onClick={onCopy}>
            {copied ? t("backup.copied") : t("backup.copy")}
          </Btn>
          <Btn
            weight={close.primary ? "primary" : "secondary"}
            className={`min-w-53 flex-1 shrink-0 @4xl:w-53 @4xl:flex-none ${close.primary ? "look-key" : "bg-(--bg-3)! hover:opacity-90"}`}
            disabled={close.disabled || close.busy}
            onClick={close.onClick}
          >
            {close.label}
          </Btn>
        </div>
      </div>
    </section>
  );
}
