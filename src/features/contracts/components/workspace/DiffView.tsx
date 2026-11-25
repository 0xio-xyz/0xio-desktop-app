import { useMemo } from "react";
import { useTranslation } from "src/i18n/react";
import { diffLines } from "src/features/contracts/components/editor/lineDiff";
import { Line } from "src/features/contracts/components/workspace/Tokens";

export type DiffMode = "split" | "inline";

interface Props {
  base: string;
  current: string;
  baseLabel: string;
  fileName: string;
  mode: DiffMode;
  onMode: (mode: DiffMode) => void;
  onRevert: () => void;
  revertDisabled: boolean;
  onBack: () => void;
}

export default function DiffView({
  base,
  current,
  baseLabel,
  fileName,
  mode,
  onMode,
  onRevert,
  revertDisabled,
  onBack,
}: Props) {
  const { t } = useTranslation();
  const d = useMemo(() => diffLines(base, current), [base, current]);
  const n = (v: number | null) => (v == null ? "" : String(v));

  return (
    <div className="diff" data-t="diffview">
      <div className="dbar">
        <div className="seg sm" role="tablist" aria-label={t("contracts.ws.diffLayout")}>
          {(["split", "inline"] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              className={`press${mode === m ? " on" : ""}`}
              onClick={() => onMode(m)}
            >
              {t(m === "split" ? "contracts.ws.split" : "contracts.ws.inline")}
            </button>
          ))}
        </div>
        <span className="mono inline-flex flex-none gap-2 text-[12px]">
          <span className="pos">+{d.adds}</span>
          <span className="neg">-{d.dels}</span>
        </span>
        <div className="flex-1" />
        <button type="button" className="ghost press" onClick={onRevert} disabled={revertDisabled}>
          {t("contracts.ws.revert")}
        </button>
        <button type="button" className="ghost press" onClick={onBack}>
          {t("contracts.compile.backToCode")}
        </button>
      </div>
      {mode === "split" ? (
        <div className="dcols mono">
          <div className="dcol">
            <div className="dcap">
              <b>{baseLabel}</b>
              <span>{fileName}</span>
            </div>
            {d.split.map((r, i) => (
              <div key={i} className={`dr ${r.left.kind}`}>
                <span className="dn">{n(r.left.n)}</span>
                <span className="dx">
                  <Line text={r.left.text} />
                </span>
              </div>
            ))}
          </div>
          <div className="dgap" />
          <div className="dcol">
            <div className="dcap">
              <b>{t("contracts.ws.current")}</b>
              <span>{fileName}</span>
            </div>
            {d.split.map((r, i) => (
              <div key={i} className={`dr ${r.right.kind}`}>
                <span className="dn">{n(r.right.n)}</span>
                <span className="dx">
                  <Line text={r.right.text} />
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="dcols mono">
          <div className="dcol">
            <div className="dcap">
              <b>{baseLabel}</b>
              <span>{t("contracts.ws.and")}</span>
              <b>{t("contracts.ws.current")}</b>
            </div>
            {d.inline.map((r, i) => (
              <div key={i} className={`dr ${r.sign === "-" ? "del" : r.sign === "+" ? "add" : ""}`}>
                <span className="dn">{n(r.a)}</span>
                <span className="dn">{n(r.b)}</span>
                <span className="dsg">{r.sign}</span>
                <span className="dx">
                  <Line text={r.text} />
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
