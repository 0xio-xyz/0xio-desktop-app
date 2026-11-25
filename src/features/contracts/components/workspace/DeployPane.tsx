import { useTranslation } from "src/i18n/react";
import FeePicker from "src/shared/ui/FeePicker";
import { PillSwitch } from "src/shared/ui/look";
import { Toggle } from "src/features/settings/components/parts";
import CopyButton from "src/shared/ui/CopyButton";
import type { FeeQuote } from "src/hooks/transactions/useFees";
import type { ContractReceipt, DeployResult } from "src/types/contract";

export interface CtorParam {
  name: string;
  type: string;
}

export const NUMERIC_TYPES = new Set(["int", "u64", "u128", "u256"]);

interface Props {
  title: string;
  blocked: string;
  contractName: string;
  namePlaceholder: string;
  onName: (v: string) => void;
  ctorParams: CtorParam[] | null;
  ctorValues: Record<string, string>;
  onCtorValue: (name: string, v: string) => void;
  rawParams: boolean;
  onRawParams: (on: boolean) => void;
  constructorJson: string;
  onConstructorJson: (v: string) => void;
  ctorPlaceholder: string;
  ctorJsonError: "invalid" | "count" | null;
  predicted: string;
  sourceLabel: string;
  sizeLabel: string;
  quote: FeeQuote;
  ou: string;
  onOu: (ou: string) => void;
  feeDisabled: boolean;
  gate: string;
  onGateCancel: () => void;
  onGateDeploy: () => void;
  result: DeployResult | null;
  receipt: ContractReceipt | null;
  verified: boolean | null;
  verifying: boolean;
  onVerify: () => void;
  onInteract?: () => void;
  reviewDisabled: boolean;
  onReview: () => void;
  onBuild: () => void;
}

export default function DeployPane(p: Props) {
  const { t } = useTranslation();

  if (p.blocked) {
    return (
      <div className="pane">
        <div className="phead px-4.5 pt-1 pb-2.5">
          <span className="text-[15px] font-semibold">{p.title}</span>
        </div>
        <div className="flex flex-col gap-3 px-4.5">
          <div className="quiet">{p.blocked}</div>
          <button type="button" className="key big press" onClick={p.onBuild}>
            {t("contracts.compile.build")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="pane">
      <div className="phead px-4.5 pt-1 pb-2.5">
        <span className="truncate text-[15px] font-semibold">{p.title}</span>
      </div>
      <div className="dform">
        <div className="fl">
          <label className="fll" htmlFor="dep-name">
            <span>{t("contracts.compile.nameLabel")}</span>
            <span className="text-(--fg-3)">{t("contracts.ws.optional")}</span>
          </label>
          <input
            id="dep-name"
            className="finp"
            value={p.contractName}
            onChange={(e) => p.onName(e.target.value)}
            placeholder={p.namePlaceholder}
          />
        </div>
        <div className="phead mt-1">
          <span className="caps">{t("contracts.compile.ctor")}</span>
          {p.ctorParams != null && p.ctorParams.length > 0 && (
            <span className="inline-flex items-center gap-2 text-[12.5px] text-(--fg-2)">
              JSON
              <Toggle
                on={p.rawParams}
                onChange={p.onRawParams}
                label={t("contracts.interact.jsonMode")}
              />
            </span>
          )}
        </div>
        {p.ctorParams != null && p.ctorParams.length === 0 ? (
          <div className="quiet">{t("contracts.ws.noArgs")}</div>
        ) : p.ctorParams == null || p.rawParams ? (
          <div className="fl">
            {p.ctorParams != null && (
              <div className="mono text-right text-[11.5px] text-(--fg-3)">
                [{p.ctorParams.map((cp) => cp.type || "?").join(", ")}]
              </div>
            )}
            <textarea
              className="finp mono"
              value={p.constructorJson}
              onChange={(e) => p.onConstructorJson(e.target.value)}
              placeholder={p.ctorPlaceholder}
              aria-label={t("contracts.compile.ctor")}
              rows={Math.max(4, (p.ctorParams?.length ?? 2) + 2)}
              spellCheck={false}
            />
            <p role="alert" className="min-h-5 text-[12.5px] text-(--neg)">
              {p.ctorJsonError === "invalid"
                ? t("contracts.interact.jsonInvalid")
                : p.ctorJsonError === "count"
                  ? t("contracts.interact.jsonCount", { count: p.ctorParams?.length ?? 0 })
                  : ""}
            </p>
          </div>
        ) : (
          p.ctorParams.map((cp) => {
            const v = p.ctorValues[cp.name] ?? "";
            const numeric = NUMERIC_TYPES.has(cp.type);
            const invalid = numeric && v.trim() !== "" && !/^-?\d+$/.test(v.trim());
            return (
              <div key={cp.name} className="fl">
                <label className="fll" htmlFor={`ctor-${cp.name}`}>
                  <span className="mono">{cp.name}</span>
                  <span className="mono text-(--fg-3)">{cp.type || "?"}</span>
                </label>
                {cp.type === "bool" ? (
                  <PillSwitch<"true" | "false">
                    label={cp.name}
                    value={v === "true" ? "true" : "false"}
                    onChange={(next) => p.onCtorValue(cp.name, next)}
                    options={[
                      { value: "true", label: "true" },
                      { value: "false", label: "false" },
                    ]}
                  />
                ) : (
                  <input
                    id={`ctor-${cp.name}`}
                    className="finp mono"
                    value={v}
                    onChange={(e) => p.onCtorValue(cp.name, e.target.value)}
                    placeholder={numeric ? "0" : cp.type === "address" ? "oct..." : cp.type || ""}
                    aria-invalid={invalid || undefined}
                    spellCheck={false}
                  />
                )}
              </div>
            );
          })
        )}
        {p.gate && (
          <div className="gate">
            <p>{p.gate}</p>
            <button type="button" className="ghost press" onClick={p.onGateCancel}>
              {t("common.cancel")}
            </button>
            <button type="button" className="key press" onClick={p.onGateDeploy}>
              {t("contracts.compile.deployAnyway")}
            </button>
          </div>
        )}
        {p.result && (
          <div className="done">
            <div className="kv">
              <span className="text-(--fg)! font-semibold">{t("contracts.compile.deployed")}</span>
              <span>{p.receipt ? p.receipt.status : ""}</span>
            </div>
            <div className="kv">
              <span>{t("contracts.interact.contract")}</span>
              <span
                className="mono inline-flex items-center gap-1.5"
                title={p.result.contractAddress}
              >
                <span className="truncate">{p.result.contractAddress}</span>
                <CopyButton text={p.result.contractAddress} size={12} />
              </span>
            </div>
            <div className="kv">
              <span>{t("sendFlow.hash")}</span>
              <span className="mono inline-flex items-center gap-1.5" title={p.result.txHash}>
                <span className="truncate">{p.result.txHash}</span>
                <CopyButton text={p.result.txHash} size={12} />
              </span>
            </div>
            {p.receipt?.error && <div className="quiet neg">{p.receipt.error}</div>}
            <div className="acts mt-1">
              {p.verified != null && (
                <span className="word">
                  {p.verified
                    ? t("contracts.compile.verified")
                    : t("contracts.compile.notVerified")}
                </span>
              )}
              <button
                type="button"
                className="ghost press"
                onClick={p.onVerify}
                disabled={p.verifying}
              >
                {p.verified === true
                  ? t("contracts.compile.reverify")
                  : t("contracts.compile.verify")}
              </button>
              {p.onInteract && (
                <button type="button" className="ghost press" onClick={p.onInteract}>
                  {t("contracts.compile.goInteract")}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
      <div className="dfoot">
        <div className="kvb pt-0!">
          <span>{t("contracts.compile.deploysTo")}</span>
          <span className="mono">{p.predicted}</span>
        </div>
        <div className="kv">
          <span>{t("contracts.ws.source")}</span>
          <span>{p.sourceLabel}</span>
        </div>
        <div className="kv">
          <span>{t("contracts.compile.codeSize")}</span>
          <span className="mono">{p.sizeLabel}</span>
        </div>
        <div className="kv">
          <span>{t("sendFlow.networkFee")}</span>
          <span className="overflow-visible!">
            <FeePicker
              quote={p.quote}
              ou={p.ou}
              onChange={p.onOu}
              disabled={p.feeDisabled}
              defaultOnly
            />
          </span>
        </div>
        <button
          type="button"
          className="key big press w-full"
          onClick={p.onReview}
          disabled={p.reviewDisabled}
          data-t="review"
        >
          {t("contracts.compile.reviewDeploy")}
        </button>
      </div>
    </div>
  );
}
