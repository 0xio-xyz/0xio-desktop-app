import { useTranslation } from "src/i18n/react";
import type { AuditFinding } from "src/services/ai/aiChatService";
import type { CompileResult } from "src/types/contract";

export interface BuildRecord {
  file: string;
  text: string;
  language: "aml" | "assembly";
  result: CompileResult | null;
  error: string;
}

export interface AuditRecord {
  file: string;
  text: string;
  findings: AuditFinding[];
}

export interface Problem {
  sev: "error" | "warning" | "info";
  text: string;
  line: number | null;
  col: number | null;
}

export interface OutputLine {
  time: string;
  type: "info" | "error" | "success" | "warn";
  msg: string;
}

interface Props {
  build: BuildRecord | null;
  building: boolean;
  activeName: string;
  sourceLabel: string;
  stale: boolean;
  level: string | null;
  problems: Problem[];
  suggestion: string | null;
  audit: AuditRecord | null;
  auditSourceLabel: string;
  auditing: boolean;
  auditError: string;
  noProvider: boolean;
  modelLabel: string;
  output: OutputLine[];
  canBuild: boolean;
  deployReady: boolean;
  onBuild: () => void;
  onAudit: () => void;
  onJump: (line: number) => void;
  onFix: (f: AuditFinding) => void;
  onSetUp: () => void;
  onContinue: () => void;
}

const Dots = ({ label }: { label: string }) => (
  <span className="ld" role="img" aria-label={label}>
    <b />
    <b />
    <b />
  </span>
);

const short = (h: string) => (h.length > 14 ? `${h.slice(0, 6)}...${h.slice(-4)}` : h);

export default function BuildPane(p: Props) {
  const { t } = useTranslation();
  const b = p.build;
  const ok = !!b?.result && !b.error;
  const fileName = (f: string) => f.split("/").pop() ?? f;

  return (
    <div className="pane">
      <div className="pact">
        <button
          type="button"
          className="key big press"
          onClick={p.onBuild}
          disabled={!p.canBuild}
          aria-busy={p.building}
          data-t="build"
        >
          {t("contracts.compile.build")}
        </button>
        <button
          type="button"
          className="ghost big press"
          onClick={p.onAudit}
          disabled={!p.canBuild || p.auditing}
          aria-busy={p.auditing}
          data-t="audit"
        >
          {t("contracts.compile.audit")}
        </button>
      </div>
      <div className="pscroll">
        <div className="bsec">
          <div className="phead">
            <span className="caps">{t("contracts.compile.build")}</span>
            <span className="mono truncate text-[12px] text-(--fg-3)">
              {b ? fileName(b.file) : ""}
            </span>
          </div>
          {p.building && (
            <div className="run">
              <Dots label={t("contracts.ws.building")} />
              {t("contracts.ws.building")}
              <span className="mono truncate text-(--fg-3)">{p.activeName}</span>
            </div>
          )}
          {!b && !p.building && <div className="quiet">{t("contracts.ws.notBuilt")}</div>}
          {b && (
            <div className={`res${p.building ? " dim" : ""}`}>
              <div className="kv">
                <span>{t("contracts.ws.result")}</span>
                <span className={ok ? "pos" : "neg"}>
                  {ok ? t("contracts.ws.built") : t("contracts.ws.failed")}
                </span>
              </div>
              <div className="kv">
                <span>{t("contracts.ws.source")}</span>
                <span>{p.sourceLabel}</span>
              </div>
              {p.stale && (
                <div className="kv">
                  <span>{t("contracts.ws.editor")}</span>
                  <span>{t("contracts.ws.changedSinceBuild")}</span>
                </div>
              )}
              {b.result && (
                <>
                  <div className="kv">
                    <span>{t("contracts.compile.size")}</span>
                    <span className="mono">
                      {t("contracts.compile.bytes", {
                        count: b.result.size,
                        size: b.result.size.toLocaleString(),
                      })}
                    </span>
                  </div>
                  <div className="kv">
                    <span>{t("contracts.compile.instructions")}</span>
                    <span className="mono">{b.result.instructions.toLocaleString()}</span>
                  </div>
                  {p.level && (
                    <div className="kv">
                      <span>{t("contracts.compile.verifier")}</span>
                      <span
                        className={p.level === "error" ? "neg" : p.level === "safe" ? "pos" : ""}
                      >
                        {t(`contracts.compile.verifier_${p.level}`, p.level)}
                      </span>
                    </div>
                  )}
                  {b.result.certificate?.source_hash && (
                    <div className="kv">
                      <span>{t("contracts.compile.sourceHash")}</span>
                      <span className="mono">{short(b.result.certificate.source_hash)}</span>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
          <div className="h-1.5 flex-none" />
          {p.problems.map((x, i) => (
            <button
              key={i}
              type="button"
              className="prow press"
              onClick={() => x.line != null && p.onJump(x.line)}
              disabled={x.line == null}
            >
              <span className={`sev ${x.sev}`}>{t(`contracts.ws.sev_${x.sev}`)}</span>
              <span className="tx" title={x.text}>
                {x.text}
              </span>
              {x.line != null && (
                <span className="lc mono">
                  {x.line}
                  {x.col != null ? `:${x.col}` : ""}
                </span>
              )}
            </button>
          ))}
          {p.suggestion && <div className="out px-2.5 pt-1">{p.suggestion}</div>}
          {ok && p.problems.length === 0 && !p.stale && (
            <div className="quiet px-2.5">{t("contracts.ws.noProblems")}</div>
          )}
        </div>

        <div className="phead mt-4.5">
          <span className="caps">{t("contracts.compile.audit")}</span>
        </div>
        {p.auditing && (
          <div className="run">
            <Dots label={t("contracts.compile.auditing")} />
            {t("contracts.ws.auditingWith")}
            <span className="truncate text-(--fg)">{p.modelLabel}</span>
          </div>
        )}
        {!p.auditing && p.noProvider && (
          <div className="quiet">
            <span>{t("contracts.compile.noAiProvider")}</span>
            <button type="button" className="ghost press" onClick={p.onSetUp}>
              {t("contracts.compile.setUp")}
            </button>
          </div>
        )}
        {!p.auditing && !p.noProvider && p.auditError && (
          <div className="quiet neg">{p.auditError}</div>
        )}
        {!p.audit && !p.auditing && !p.auditError && !p.noProvider && (
          <div className="quiet">{t("contracts.ws.notAudited")}</div>
        )}
        {p.audit && (
          <div className={`res${p.auditing ? " dim" : ""}`}>
            <div className="kv">
              <span>{t("contracts.ws.source")}</span>
              <span>{p.auditSourceLabel}</span>
            </div>
            {p.audit.findings.map((f, i) => (
              <div key={i} className="frow">
                <button
                  type="button"
                  className="prow press"
                  onClick={() => f.line != null && p.onJump(f.line)}
                >
                  <span className={`sev ${f.severity}`}>{t(`contracts.ws.sev_${f.severity}`)}</span>
                  <span className="tx" title={f.detail ? `${f.title}\n${f.detail}` : f.title}>
                    {f.title}
                  </span>
                  {f.line != null && (
                    <span className="lc mono">{t("contracts.ws.line", { line: f.line })}</span>
                  )}
                </button>
                <div className="fix">
                  <button
                    type="button"
                    className="ghost press"
                    onClick={() => p.onFix(f)}
                    data-t="fix"
                  >
                    {t("contracts.ws.fixWithAssistant")}
                  </button>
                </div>
              </div>
            ))}
            {p.audit.findings.length === 0 && (
              <div className="quiet">{t("contracts.compile.auditClean")}</div>
            )}
          </div>
        )}

        {p.output.length > 0 && (
          <>
            <div className="phead mt-4.5">
              <span className="caps">{t("contracts.ws.output")}</span>
            </div>
            <div className="out mono">
              {p.output.map((o, i) => (
                <div key={i} className={o.type === "error" ? "neg" : undefined}>
                  {o.time} {o.msg}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
      <div className="dfoot">
        <button
          type="button"
          className="key big press w-full"
          onClick={p.onContinue}
          disabled={!p.deployReady}
          data-t="continue"
        >
          {t("contracts.compile.continueDeploy")}
        </button>
      </div>
    </div>
  );
}
