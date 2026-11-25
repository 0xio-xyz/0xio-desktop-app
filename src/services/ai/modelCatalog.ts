import { useSyncExternalStore } from "react";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { logger } from "src/lib/logger";
import {
  getConfig,
  getSavedKeys,
  saveConfig,
  switchToProvider,
  type AISuggestionConfig,
  type ProviderType,
} from "src/services/ai/aiSuggestionService";

type CatalogProvider = Exclude<ProviderType, "none">;

interface ModelInfo {
  id: string;
  label: string;
  /** Largest output the provider allows for this model, when its list says. */
  maxOutput?: number;
}

const positive = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined;

type CatalogStatus = "idle" | "loading" | "ok" | "error" | "none";

export interface CatalogEntry {
  provider: CatalogProvider;
  status: CatalogStatus;
  models: ModelInfo[];
  source: string;
}

export const LOCAL_PROVIDERS: CatalogProvider[] = ["ollama", "lmstudio"];

export const LOCAL_HOSTS: Record<string, string> = {
  ollama: "localhost:11434",
  lmstudio: "localhost:1234",
};

const CACHE_KEY = "ai_model_cache_v2";
const STALE_MS = 6 * 60 * 60_000;
const KEYED_TIMEOUT_MS = 15_000;
const LOCAL_TIMEOUT_MS = 2_500;

type Json = Record<string, unknown>;
const arr = (v: unknown): Json[] => (Array.isArray(v) ? (v as Json[]) : []);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

const NOT_CHAT_OPENAI =
  /embedding|whisper|tts|dall-e|davinci|babbage|moderation|transcribe|realtime|audio|image|search|computer-use|sora/i;
const NOT_CHAT_GROQ = /whisper|tts|playai|guard/i;
const NOT_CHAT_LOCAL = /embed|bert/i;

function openaiLabel(id: string): string {
  return id
    .replace(/^gpt-/, "GPT-")
    .replace(/^chatgpt-/, "ChatGPT ")
    .replace(/-(mini|nano|turbo|preview|latest|pro)\b/g, " $1");
}

export function parseModelList(provider: CatalogProvider, body: unknown): ModelInfo[] {
  const d = (body ?? {}) as Json;
  switch (provider) {
    case "anthropic":
      return arr(d.data)
        .filter((m) => str(m.id) && (!m.type || m.type === "model"))
        .map((m) => ({
          id: str(m.id),
          label: str(m.display_name) || str(m.id),
          maxOutput: positive(m.max_tokens),
        }));
    case "openai":
      return arr(d.data)
        .filter((m) => str(m.id) && !NOT_CHAT_OPENAI.test(str(m.id)))
        .sort((x, y) => Number(y.created ?? 0) - Number(x.created ?? 0))
        .map((m) => ({ id: str(m.id), label: openaiLabel(str(m.id)) }));
    case "groq":
      return arr(d.data)
        .filter((m) => str(m.id) && m.active !== false && !NOT_CHAT_GROQ.test(str(m.id)))
        .map((m) => ({ id: str(m.id), label: str(m.id) }));
    case "openrouter":
      return arr(d.data)
        .filter((m) => {
          if (!str(m.id)) return false;
          const a = (m.architecture ?? {}) as Json;
          if (Array.isArray(a.output_modalities)) return a.output_modalities.includes("text");
          const modality = str(a.modality);
          return !modality || modality.endsWith("->text") || modality.includes("->text");
        })
        .map((m) => ({
          id: str(m.id),
          label: str(m.id),
          maxOutput: positive(((m.top_provider ?? {}) as Json).max_completion_tokens),
        }));
    case "ollama":
      return arr(d.models)
        .map((m) => str(m.name) || str(m.model))
        .filter((id) => id && !NOT_CHAT_LOCAL.test(id))
        .map((id) => ({ id, label: id.replace(/:latest$/, "") }));
    case "lmstudio":
    case "custom":
      return arr(d.data)
        .map((m) => str(m.id))
        .filter((id) => id && !NOT_CHAT_LOCAL.test(id))
        .map((id) => ({ id, label: id }));
  }
}

export function endpointBase(endpoint: string): string {
  const t = endpoint.trim().replace(/\/+$/, "");
  const withScheme = /^https?:\/\//i.test(t) ? t : `http://${t}`;
  return withScheme.replace(/\/chat\/completions$/, "");
}

export function modelsRequest(
  provider: CatalogProvider,
  apiKey: string,
  endpoint?: string,
): { url: string; headers: Record<string, string> } {
  const bearer: Record<string, string> = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  switch (provider) {
    case "openai":
      return { url: "https://api.openai.com/v1/models", headers: bearer };
    case "anthropic":
      return {
        url: "https://api.anthropic.com/v1/models?limit=100",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
      };
    case "groq":
      return { url: "https://api.groq.com/openai/v1/models", headers: bearer };
    case "openrouter":
      return { url: "https://openrouter.ai/api/v1/models", headers: bearer };
    case "ollama":
      return { url: "http://localhost:11434/api/tags", headers: {} };
    case "lmstudio":
      return { url: "http://localhost:1234/v1/models", headers: {} };
    case "custom":
      return { url: `${endpointBase(endpoint ?? "")}/models`, headers: bearer };
  }
}

export function maskKey(key: string): string {
  const k = key.trim();
  if (!k) return "";
  const pre = k.startsWith("sk-ant-")
    ? "sk-ant-"
    : k.startsWith("sk-or-")
      ? "sk-or-"
      : k.startsWith("gsk_")
        ? "gsk_"
        : k.startsWith("sk-")
          ? "sk-"
          : "";
  return `${pre}...${k.slice(-4)}`;
}

export function reconcileSelection(
  config: AISuggestionConfig,
  provider: CatalogProvider,
  models: ModelInfo[],
): AISuggestionConfig {
  if (models.length === 0) return config;
  if (config.provider === "none") return switchToProvider(config, provider, models[0].id);
  if (config.provider !== provider) return config;
  const model = config.model || config.customModel || "";
  if (models.some((m) => m.id === model)) return config;
  return { ...config, model: models[0].id };
}

interface Cached {
  source: string;
  at: number;
  models: ModelInfo[];
}

function readCache(): Record<string, Cached> {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY) ?? "{}") ?? {};
  } catch {
    return {};
  }
}

function writeCache(provider: string, value: Cached | null) {
  const all = readCache();
  if (value) all[provider] = value;
  else delete all[provider];
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(all));
  } catch {}
}

export function catalogSources(
  config: AISuggestionConfig,
): { provider: CatalogProvider; apiKey: string; endpoint?: string; source: string }[] {
  const out: { provider: CatalogProvider; apiKey: string; endpoint?: string; source: string }[] =
    [];
  for (const k of getSavedKeys(config)) {
    if (k.provider === "none" || LOCAL_PROVIDERS.includes(k.provider)) continue;
    if (k.provider === "custom") {
      if (k.customEndpoint)
        out.push({
          provider: "custom",
          apiKey: k.apiKey,
          endpoint: k.customEndpoint,
          source: endpointBase(k.customEndpoint).replace(/^https?:\/\//, ""),
        });
      continue;
    }
    if (k.apiKey) out.push({ provider: k.provider, apiKey: k.apiKey, source: maskKey(k.apiKey) });
  }
  for (const p of LOCAL_PROVIDERS) out.push({ provider: p, apiKey: "", source: LOCAL_HOSTS[p] });
  return out;
}

type Listener = () => void;
let entries: Record<string, CatalogEntry> = {};
let snapshot: CatalogEntry[] = [];
const listeners = new Set<Listener>();
const inflight = new Map<string, number>();

function emit() {
  const order = catalogSources(getConfig()).map((s) => s.provider);
  snapshot = order.filter((p) => entries[p]).map((p) => entries[p]);
  for (const l of listeners) l();
}

function setEntry(e: CatalogEntry) {
  entries = { ...entries, [e.provider]: e };
  emit();
}

async function load(src: ReturnType<typeof catalogSources>[number], force: boolean): Promise<void> {
  const cached = readCache()[src.provider];
  const usable = cached && cached.source === src.source ? cached : null;
  if (usable && !force && Date.now() - usable.at < STALE_MS) {
    setEntry({ provider: src.provider, status: "ok", models: usable.models, source: src.source });
    return;
  }
  const seq = (inflight.get(src.provider) ?? 0) + 1;
  inflight.set(src.provider, seq);
  const prev = entries[src.provider];
  setEntry({
    provider: src.provider,
    status: "loading",
    models: prev?.source === src.source ? prev.models : (usable?.models ?? []),
    source: src.source,
  });
  const local = LOCAL_PROVIDERS.includes(src.provider);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), local ? LOCAL_TIMEOUT_MS : KEYED_TIMEOUT_MS);
  try {
    const req = modelsRequest(src.provider, src.apiKey, src.endpoint);
    const res = await tauriFetch(req.url, {
      method: "GET",
      headers: req.headers,
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const models = parseModelList(src.provider, await res.json());
    if (inflight.get(src.provider) !== seq) return;
    writeCache(src.provider, { source: src.source, at: Date.now(), models });
    setEntry({ provider: src.provider, status: "ok", models, source: src.source });
    const config = getConfig();
    const next = reconcileSelection(config, src.provider, models);
    if (next !== config) saveConfig(next);
  } catch (e) {
    if (inflight.get(src.provider) !== seq) return;
    logger.warn(
      "ai",
      `model list for ${src.provider} unavailable: ${e instanceof Error ? e.message : "error"}`,
    );
    setEntry({
      provider: src.provider,
      status: local ? "none" : "error",
      models: [],
      source: src.source,
    });
  } finally {
    clearTimeout(timer);
  }
}

export const modelCatalog = {
  refreshAll(force = false) {
    const sources = catalogSources(getConfig());
    const keep = new Set(sources.map((s) => s.provider));
    entries = Object.fromEntries(
      Object.entries(entries).filter(([p]) => keep.has(p as CatalogProvider)),
    );
    emit();
    for (const s of sources) void load(s, force);
  },
  refresh(provider: CatalogProvider) {
    const src = catalogSources(getConfig()).find((s) => s.provider === provider);
    if (src) void load(src, true);
  },
  forget(provider: CatalogProvider) {
    writeCache(provider, null);
    entries = Object.fromEntries(Object.entries(entries).filter(([p]) => p !== provider));
    emit();
  },
  label(provider: string, id: string): string {
    return entries[provider]?.models.find((m) => m.id === id)?.label ?? id;
  },
  maxOutput(provider: string, id: string): number | undefined {
    return entries[provider]?.models.find((m) => m.id === id)?.maxOutput;
  },
  subscribe(l: Listener) {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  },
  get: () => snapshot,
};

export function useModelCatalog(): CatalogEntry[] {
  return useSyncExternalStore(modelCatalog.subscribe, modelCatalog.get);
}
