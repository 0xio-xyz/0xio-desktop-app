import React, { useState, useMemo, useRef } from "react";
import { useTranslation } from "src/i18n/react";
import { Settings } from "src/shared/ui/icons";
import Modal from "src/shared/ui/Modal";
import Button from "src/shared/ui/Button";
import { useTokenPrice } from "src/hooks/wallet/useTokenPrice";

interface OUSettingsProps {
  ou: string;
  // `mode` is the selected preset id ("slow"/"normal"/"fast"/"custom") - lets the persistence keep
  // a fetched preset dynamic instead of freezing its snapshot value.
  onOUChange: (ou: string, mode?: string) => void;
  defaultOU: string;
  fees?: { minimum: string; recommended: string; fast?: string };
  iconOnly?: boolean;
  children?: React.ReactNode;
}

/** Node policy ceiling (webcli pvac_upgrade_policy.hpp max_fee_raw). */
const MAX_OU = 10_000_000;

function toOct(ouStr: string): string {
  const v = parseFloat(ouStr || "0");
  if (!isFinite(v) || v <= 0) return "0";
  return (v / 1_000_000).toFixed(6).replace(/\.?0+$/, "") || "0";
}

// Presets come from the fee API verbatim: Slow is the network minimum, Fast shows only when the
// node quoted one. Without fee data there is no known minimum, so only Normal is offered.
export function ouPresets(
  fees: OUSettingsProps["fees"],
  defaultOU: string,
  t: (key: string) => string,
): Array<{ id: string; label: string; ou: string }> {
  if (fees) {
    return [
      { id: "slow", label: t("fee.slow"), ou: fees.minimum },
      { id: "normal", label: t("fee.normal"), ou: fees.recommended },
      ...(fees.fast ? [{ id: "fast", label: t("fee.fast"), ou: fees.fast }] : []),
    ];
  }
  return [{ id: "normal", label: t("fee.normal"), ou: String(parseInt(defaultOU) || 0) }];
}

export default React.memo(function OUSettings({
  ou,
  onOUChange,
  defaultOU,
  fees,
  iconOnly = false,
  children,
}: OUSettingsProps) {
  const { t } = useTranslation();
  const tokenPrices = useTokenPrice();

  const presets = useMemo(() => ouPresets(fees, defaultOU, t), [fees, defaultOU, t]);

  const [isOpen, setIsOpen] = useState(false);
  const [selected, setSelected] = useState("normal");
  const [customDraft, setCustomDraft] = useState(ou);
  const customRef = useRef<HTMLInputElement>(null);

  const activeOU =
    selected === "custom" ? customDraft : (presets.find((p) => p.id === selected)?.ou ?? defaultOU);

  const activeNum = parseInt(activeOU || "0", 10) || 0;
  const minOU = fees ? parseInt(fees.minimum, 10) || 0 : 0;
  const defNum = parseInt(defaultOU, 10) || 0;

  // Hard errors disable Save - these values are rejected by the node, so letting them
  // through only defers the failure to broadcast time.
  const error =
    activeNum <= 0
      ? t("fee.invalid")
      : fees && activeNum < minOU
        ? t("fee.belowMinimum", { min: minOU.toLocaleString() })
        : activeNum > MAX_OU
          ? t("fee.aboveMaximum", { max: MAX_OU.toLocaleString() })
          : null;
  // Soft caution only: without fee data the operation minimum is unknown.
  const caution =
    !error && !fees && activeNum < defNum
      ? t("fee.belowDefault", { def: defNum.toLocaleString() })
      : null;

  const estimatedOct = useMemo(() => toOct(activeOU), [activeOU]);
  const estimatedUsd = useMemo(
    () => tokenPrices.getUsdValue("OCT", (parseInt(activeOU || "0", 10) || 0) / 1_000_000),
    [activeOU, tokenPrices],
  );

  const displayOU = ou || defaultOU;

  const handleOpen = () => {
    // Match numerically so a Normal value formatted slightly differently still selects Normal.
    const ouNum = parseInt(ou, 10) || 0;
    const match = presets.find((p) => (parseInt(p.ou, 10) || 0) === ouNum);
    setSelected(match ? match.id : "custom");
    setCustomDraft(ou);
    setIsOpen(true);
  };

  const handleSave = () => {
    if (error) return;
    onOUChange(String(activeNum), selected);
    setIsOpen(false);
  };

  return (
    <>
      {children ? (
        <button
          type="button"
          onClick={handleOpen}
          aria-label={t("send.networkFee")}
          className="inline-flex cursor-pointer items-center rounded-md hover:opacity-80 focus-visible:ring-2 focus-visible:ring-accent outline-none"
        >
          {children}
        </button>
      ) : iconOnly ? (
        <button
          type="button"
          onClick={handleOpen}
          aria-label={t("send.networkFee")}
          title={`Fee: ${Number(displayOU).toLocaleString()} OU (~${toOct(displayOU)} OCT)`}
          className="flex items-center justify-center rounded-full bg-surface-highlight p-1.5 text-content-secondary hover:text-content transition-colors"
        >
          <Settings size={14} className="shrink-0" />
        </button>
      ) : (
        <button
          type="button"
          onClick={handleOpen}
          className="flex items-center text-xs sm:text-sm text-content-secondary hover:text-content px-2.5 py-1 rounded-full bg-surface-highlight transition-colors min-w-0"
        >
          <span className="truncate tabular-nums">
            Fee: {Number(displayOU).toLocaleString()} OU (~{toOct(displayOU)} OCT)
          </span>
        </button>
      )}

      <Modal
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
        title={t("send.networkFee")}
        size="sm"
        hideClose
      >
        <div className="space-y-4">
          <div
            className="grid gap-1 rounded-xl bg-surface-highlight p-1 text-micro"
            style={{ gridTemplateColumns: `repeat(${presets.length + 1}, 1fr)` }}
          >
            {presets.map((preset) => (
              <button
                key={preset.id}
                type="button"
                aria-pressed={selected === preset.id}
                onClick={() => setSelected(preset.id)}
                title={`${Number(preset.ou).toLocaleString()} OU`}
                className={`h-8 cursor-pointer rounded-lg px-1 font-semibold transition-colors ${
                  selected === preset.id
                    ? "bg-surface-card text-content shadow-sm"
                    : "text-content-muted hover:text-content"
                }`}
              >
                {preset.label}
              </button>
            ))}
            {selected === "custom" ? (
              <div
                onClick={() => customRef.current?.focus()}
                className="flex h-8 cursor-text items-center rounded-lg bg-surface-card px-1 shadow-sm"
              >
                <input
                  ref={customRef}
                  type="text"
                  inputMode="numeric"
                  autoFocus
                  value={customDraft}
                  onChange={(e) => {
                    if (/^\d*$/.test(e.target.value)) setCustomDraft(e.target.value);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleSave();
                  }}
                  placeholder={t("fee.custom")}
                  aria-label={t("fee.customOu")}
                  className="w-full bg-transparent text-center font-mono tabular-nums text-content outline-none placeholder:text-content-muted"
                />
              </div>
            ) : (
              <button
                type="button"
                aria-pressed={false}
                onClick={() => setSelected("custom")}
                className="h-8 cursor-pointer rounded-lg px-1 font-semibold text-content-muted transition-colors hover:text-content"
              >
                {t("fee.custom")}
              </button>
            )}
          </div>

          {error && <p className="text-[0.75rem] text-danger">{error}</p>}
          {caution && <p className="text-[0.75rem] text-content-secondary">{caution}</p>}

          <div className="flex items-baseline justify-between text-[0.75rem]">
            <span className="text-content-muted">{t("fee.estimated")}</span>
            <span className="font-mono font-semibold tabular-nums text-content">
              {activeNum > 0 ? `${activeNum.toLocaleString()} OU ` : ""}
              <span className="font-normal text-content-muted">
                ~{estimatedOct} OCT{estimatedUsd ? ` ≈ ${estimatedUsd}` : ""}
              </span>
            </span>
          </div>

          <div className="flex gap-2">
            <Button variant="secondary" fullWidth size="sm" onClick={() => setIsOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button variant="primary" fullWidth size="sm" onClick={handleSave} disabled={!!error}>
              {t("common.save")}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
});
