import { useState } from "react";
import { useTranslation } from "src/i18n/react";
import {
  detectProviderFromKey,
  getConfig,
  getProviderLabel,
  getSavedKeys,
  removeKeyFromConfig,
  saveConfig,
  saveKeyToConfig,
  switchToProvider,
  useAiConfig,
  isAiReady,
  type ProviderType,
} from "src/services/ai/aiSuggestionService";
import {
  LOCAL_HOSTS,
  LOCAL_PROVIDERS,
  endpointBase,
  maskKey,
  modelCatalog,
  useModelCatalog,
  type CatalogEntry,
} from "src/services/ai/modelCatalog";
import useMountEffect from "src/hooks/ui/useMountEffect";
import { FOCUS, Group, SubPage } from "src/features/settings/components/parts";

const EASE = "transition-colors duration-200 ease-out motion-reduce:transition-none";
const PILL = `inline-flex h-8 shrink-0 cursor-pointer items-center rounded-full bg-(--bg-3) px-3.5 text-[0.8125rem] font-medium whitespace-nowrap text-content hover:bg-(--line-2) disabled:cursor-default disabled:opacity-50 ${EASE} ${FOCUS}`;
const KEY = `inline-flex h-10 shrink-0 cursor-pointer items-center rounded-full bg-content px-4.5 text-[0.8125rem] font-semibold text-surface disabled:cursor-default disabled:bg-(--bg-3) disabled:text-content-muted ${FOCUS}`;
const ROW = "flex min-h-14 items-center gap-3 rounded-xl bg-surface-highlight py-2 pr-2 pl-3.5";
const FIELD =
  "flex h-10 min-w-0 flex-1 items-center gap-2 rounded-full bg-surface-highlight pr-1.5 pl-4 focus-within:ring-2 focus-within:ring-accent";
const INPUT =
  "h-full min-w-0 flex-1 bg-transparent font-mono text-[0.8125rem] text-content outline-none placeholder:text-content-muted";

function Dots({ label }: { label: string }) {
  return (
    <span role="img" aria-label={label} className="inline-flex items-center gap-1">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="size-1 animate-pulse rounded-full bg-content-muted motion-reduce:animate-none"
          style={{ animationDelay: `${i * 150}ms` }}
        />
      ))}
    </span>
  );
}

function Status({ entry, local }: { entry?: CatalogEntry; local?: boolean }) {
  const { t } = useTranslation();
  if (!entry || entry.status === "loading" || entry.status === "idle")
    return entry?.models.length ? (
      <span className="text-meta text-content-muted">
        {t("settings.aiModelCount", { count: entry.models.length })}
      </span>
    ) : (
      <Dots label={t("contracts.ws.loading")} />
    );
  if (entry.status === "ok")
    return (
      <span className="text-meta whitespace-nowrap text-content-secondary">
        {t("settings.aiModelCount", { count: entry.models.length })}
      </span>
    );
  if (entry.status === "none" || (local && entry.status === "error"))
    return (
      <span className="text-meta whitespace-nowrap text-content-muted">
        {t("settings.aiNotRunning")}
      </span>
    );
  return (
    <>
      <span className="text-meta whitespace-nowrap text-content-secondary">
        {t("contracts.ws.couldNotReach")}
      </span>
      <button type="button" className={PILL} onClick={() => modelCatalog.refresh(entry.provider)}>
        {t("contracts.ws.retry")}
      </button>
    </>
  );
}

export default function AiAssistantPage({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation();
  const config = useAiConfig();
  const catalog = useModelCatalog();
  const [keyInput, setKeyInput] = useState("");
  const [endpoint, setEndpoint] = useState("");

  useMountEffect(() => modelCatalog.refreshAll(false));

  const entry = (p: ProviderType) => catalog.find((e) => e.provider === p);
  const keyed = getSavedKeys(config).filter(
    (k) => k.apiKey && k.provider !== "custom" && !LOCAL_PROVIDERS.includes(k.provider as never),
  );
  const custom = getSavedKeys(config).find((k) => k.provider === "custom" && k.customEndpoint);
  const detected = detectProviderFromKey(keyInput);

  const addKey = () => {
    const key = keyInput.trim();
    const provider = detectProviderFromKey(key);
    if (!provider) return;
    let next = saveKeyToConfig(getConfig(), { provider, apiKey: key });
    if (!isAiReady(next) || next.provider === provider) next = switchToProvider(next, provider);
    saveConfig(next);
    setKeyInput("");
    if (provider !== "none") modelCatalog.refresh(provider);
  };

  const remove = (provider: ProviderType) => {
    saveConfig(removeKeyFromConfig(getConfig(), provider));
    modelCatalog.forget(provider as Exclude<ProviderType, "none">);
    modelCatalog.refreshAll(false);
  };

  const addEndpoint = () => {
    const base = endpointBase(endpoint);
    if (!endpoint.trim()) return;
    let next = saveKeyToConfig(getConfig(), {
      provider: "custom",
      apiKey: "",
      customEndpoint: base,
    });
    if (!isAiReady(next)) next = switchToProvider(next, "custom");
    saveConfig(next);
    setEndpoint("");
    modelCatalog.refresh("custom");
  };

  return (
    <SubPage title={t("settings.aiAssistant")} onBack={onBack} backLabel={t("common.back")}>
      <Group caption={t("settings.aiKeys")}>
        <div className="flex flex-col gap-1.5 p-1">
          {keyed.map((k) => (
            <div key={k.provider} className={ROW}>
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-[0.84375rem] font-medium text-content">
                  {getProviderLabel(k.provider)}
                </span>
                <span className="truncate font-mono text-[0.75rem] text-content-muted">
                  {maskKey(k.apiKey)}
                </span>
              </div>
              <Status entry={entry(k.provider)} />
              <button
                type="button"
                className={PILL}
                onClick={() => remove(k.provider)}
                aria-label={t("settings.aiRemoveLabel", { provider: getProviderLabel(k.provider) })}
              >
                {t("settings.aiRemove")}
              </button>
            </div>
          ))}
          <label htmlFor="ai-key-in" className="px-1 pt-2.5 text-meta text-content-secondary">
            {t("settings.aiAddKey")}
          </label>
          <div className="flex items-center gap-2">
            <div className={FIELD}>
              <input
                id="ai-key-in"
                type="password"
                value={keyInput}
                onChange={(e) => setKeyInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addKey()}
                placeholder={t("settings.aiPasteKey")}
                autoComplete="off"
                spellCheck={false}
                className={INPUT}
                data-t="keyin"
              />
              {keyInput.trim() && (
                <span
                  className={`inline-flex h-6.5 shrink-0 items-center rounded-full px-2.5 text-[0.75rem] ${detected ? "bg-(--bg-3) text-content" : "text-content-muted"}`}
                >
                  {detected ? getProviderLabel(detected) : t("settings.aiUnknownKey")}
                </span>
              )}
            </div>
            <button
              type="button"
              className={KEY}
              onClick={addKey}
              disabled={!detected}
              data-t="addkey"
            >
              {t("settings.aiAdd")}
            </button>
          </div>
        </div>
      </Group>

      <Group
        caption={t("settings.aiOnComputer")}
        right={
          <button
            type="button"
            onClick={() => modelCatalog.refreshAll(true)}
            className={`inline-flex h-7.5 cursor-pointer items-center rounded-full px-2.5 text-[0.8125rem] font-medium tracking-normal normal-case text-content-secondary hover:bg-surface-highlight hover:text-content ${EASE} ${FOCUS}`}
          >
            {t("settings.aiScanAgain")}
          </button>
        }
      >
        <div className="flex flex-col gap-1.5 p-1">
          {LOCAL_PROVIDERS.map((p) => {
            const e = entry(p);
            return (
              <div key={p} className="flex flex-col rounded-xl bg-surface-highlight">
                <div className={`${ROW} bg-transparent`}>
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="text-[0.84375rem] font-medium text-content">
                      {getProviderLabel(p)}
                    </span>
                    <span className="truncate font-mono text-[0.75rem] text-content-muted">
                      {LOCAL_HOSTS[p]}
                    </span>
                  </div>
                  <Status entry={e} local />
                </div>
                {e?.status === "ok" && e.models.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 px-3.5 pb-2.5">
                    {e.models.map((m) => (
                      <span
                        key={m.id}
                        className="inline-flex h-6 items-center rounded-full bg-(--bg-3) px-2.5 font-mono text-[0.75rem] text-content-secondary"
                      >
                        {m.id}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          {custom && (
            <div className={ROW}>
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-[0.84375rem] font-medium text-content">
                  {getProviderLabel("custom")}
                </span>
                <span className="truncate font-mono text-[0.75rem] text-content-muted">
                  {endpointBase(custom.customEndpoint ?? "").replace(/^https?:\/\//, "")}
                </span>
              </div>
              <Status entry={entry("custom")} />
              <button
                type="button"
                className={PILL}
                onClick={() => remove("custom")}
                aria-label={t("settings.aiRemoveLabel", { provider: getProviderLabel("custom") })}
              >
                {t("settings.aiRemove")}
              </button>
            </div>
          )}
          <label htmlFor="ai-ep-in" className="px-1 pt-2.5 text-meta text-content-secondary">
            {t("settings.aiAddEndpoint")}
          </label>
          <div className="flex items-center gap-2">
            <div className={FIELD}>
              <input
                id="ai-ep-in"
                value={endpoint}
                onChange={(e) => setEndpoint(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addEndpoint()}
                placeholder="http://localhost:8080/v1"
                autoComplete="off"
                spellCheck={false}
                className={INPUT}
              />
            </div>
            <button type="button" className={KEY} onClick={addEndpoint} disabled={!endpoint.trim()}>
              {t("settings.aiAdd")}
            </button>
          </div>
        </div>
      </Group>
    </SubPage>
  );
}
