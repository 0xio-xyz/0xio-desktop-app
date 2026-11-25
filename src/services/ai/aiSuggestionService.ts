import { useSyncExternalStore } from "react";
import { logger } from "src/lib/logger";

export type ProviderType =
  | "none"
  | "groq"
  | "openai"
  | "anthropic"
  | "openrouter"
  | "ollama"
  | "lmstudio"
  | "custom";

interface ProviderKey {
  provider: ProviderType;
  apiKey: string;
  model?: string;
  customEndpoint?: string;
  customModel?: string;
  label?: string;
}

export interface AISuggestionConfig {
  provider: ProviderType;
  apiKey: string;
  model?: string;
  customEndpoint?: string;
  customModel?: string;
  savedKeys?: ProviderKey[];
}

interface AISuggestionResult {
  suggestion: string | null;
  source: "pattern" | "ai";
}

const STORAGE_KEY = "ai_suggestion_config";

const DEFAULT_CONFIG: AISuggestionConfig = {
  provider: "none",
  apiKey: "",
  savedKeys: [],
};

const KEYLESS = new Set<ProviderType>(["ollama", "lmstudio"]);

// API keys are self-identifying by prefix; pasting one anywhere selects its provider.
// Order matters: sk-ant-/sk-or- must be tested before the bare sk- of OpenAI.
export function detectProviderFromKey(key: string): ProviderType | null {
  const k = key.trim();
  if (k.startsWith("gsk_")) return "groq";
  if (k.startsWith("sk-ant-")) return "anthropic";
  if (k.startsWith("sk-or-")) return "openrouter";
  if (k.startsWith("sk-")) return "openai";
  return null;
}

function getActiveModel(config: AISuggestionConfig): string {
  return config.model || config.customModel || "";
}

export function isAiReady(config: AISuggestionConfig): boolean {
  if (config.provider === "none" || !getActiveModel(config)) return false;
  if (KEYLESS.has(config.provider)) return true;
  if (config.provider === "custom") return !!config.customEndpoint;
  return !!config.apiKey;
}

export function getProviderLabel(provider: ProviderType): string {
  switch (provider) {
    case "groq":
      return "Groq";
    case "openai":
      return "OpenAI";
    case "anthropic":
      return "Anthropic";
    case "openrouter":
      return "OpenRouter";
    case "ollama":
      return "Ollama";
    case "lmstudio":
      return "LM Studio";
    case "custom":
      return "Custom";
    default:
      return "None";
  }
}

export function getSavedKeys(config: AISuggestionConfig): ProviderKey[] {
  return config.savedKeys || [];
}

export function saveKeyToConfig(config: AISuggestionConfig, key: ProviderKey): AISuggestionConfig {
  const saved = [...(config.savedKeys || [])];
  const idx = saved.findIndex((k) => k.provider === key.provider);
  if (idx >= 0) saved[idx] = key;
  else saved.push(key);
  return { ...config, savedKeys: saved };
}

export function removeKeyFromConfig(
  config: AISuggestionConfig,
  provider: ProviderType,
): AISuggestionConfig {
  const savedKeys = (config.savedKeys || []).filter((k) => k.provider !== provider);
  if (config.provider !== provider) return { ...config, savedKeys };
  const next = savedKeys[0];
  return next
    ? {
        ...config,
        provider: next.provider,
        apiKey: next.apiKey,
        model: next.model,
        customEndpoint: next.customEndpoint,
        customModel: next.customModel,
        savedKeys,
      }
    : { provider: "none", apiKey: "", savedKeys };
}

export function switchToProvider(
  config: AISuggestionConfig,
  provider: ProviderType,
  model?: string,
): AISuggestionConfig {
  const saved = (config.savedKeys || []).find((k) => k.provider === provider);
  if (!saved && provider !== "none" && !KEYLESS.has(provider)) return config;
  const chosen = model || saved?.model || "";
  let next: AISuggestionConfig = {
    ...config,
    provider,
    apiKey: saved?.apiKey || "",
    model: chosen,
    customEndpoint: saved?.customEndpoint,
    customModel: provider === "custom" ? chosen : undefined,
  };
  if (saved) next = saveKeyToConfig(next, { ...saved, model: chosen });
  return next;
}

let cachedRaw: string | null | undefined;
let cachedConfig: AISuggestionConfig = DEFAULT_CONFIG;
const listeners = new Set<() => void>();

export function getConfig(): AISuggestionConfig {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return DEFAULT_CONFIG;
  }
  if (raw === cachedRaw) return cachedConfig;
  cachedRaw = raw;
  try {
    cachedConfig = raw ? { ...DEFAULT_CONFIG, ...JSON.parse(raw) } : DEFAULT_CONFIG;
  } catch {
    cachedConfig = DEFAULT_CONFIG;
  }
  return cachedConfig;
}

export function saveConfig(config: AISuggestionConfig): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  for (const l of listeners) l();
}

function subscribeConfig(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function useAiConfig(): AISuggestionConfig {
  return useSyncExternalStore(subscribeConfig, getConfig);
}

export function getInstantSuggestion(error: string, language: string): string | null {
  return getPatternSuggestion(error, language);
}

function getPatternSuggestion(error: string, language: string): string | null {
  const lower = error.toLowerCase();

  if (language === "aml") {
    if (lower.includes("expected program or contract"))
      return "AML code must live inside a single Program block:\n\nProgram MyProgram {\n  state { count: int }\n  constructor() { self.count = 0 }\n  fn increment() { self.count = self.count + 1 }\n}";
    if (lower.includes("type mismatch") || lower.includes("expected int"))
      return "Check that variable types match. AML types: int, string, address, bool, map[K]V.";
    if (lower.includes("undefined variable") || lower.includes("undeclared"))
      return "Variable must be declared in state {} block or as a local variable before use.";
    if (lower.includes("undefined function") || lower.includes("unknown function"))
      return "Function not found. Built-ins: caller, self_addr, origin, value, require(), call(), to_string(), concat(), transfer().";
    if (lower.includes("unexpected token") || lower.includes("syntax error"))
      return "Check for missing brackets, parentheses, or semicolons. AML uses {} for blocks.";
    if (lower.includes("register") || lower.includes("too many local"))
      return "Max 31 local variables per function. Hoist variables to function top and reuse across branches.";
    if (lower.includes("||") || lower.includes("logical or"))
      return "Logical OR (||) is not supported in AML. Use separate if blocks instead.";
    if (lower.includes("call") && lower.includes("array"))
      return 'call() uses flat args: call(contract, "method", arg1, arg2) - NOT [arg1, arg2].';
  }

  if (language === "assembly") {
    if (lower.includes("invalid opcode") || lower.includes("unknown instruction"))
      return "Unknown instruction. Valid opcodes: PUSH, POP, ADD, SUB, MUL, DIV, MOD, CALL, RETURN, JUMP, JUMPI, STORE, LOAD.";
    if (lower.includes("stack underflow"))
      return "Not enough values on stack. Ensure PUSH precedes arithmetic operations.";
    if (lower.includes("stack overflow"))
      return "Too many values on stack. Add POP or RETURN to consume values.";
    if (lower.includes("invalid label") || lower.includes("undefined label"))
      return "Jump target not found. Define labels with LABEL: syntax before use in JUMP/JUMPI.";
  }

  if (lower.includes("expected {") || lower.includes("expected }"))
    return "Missing opening or closing brace. Every block needs matching {}.";
  if (lower.includes("overflow") || lower.includes("too large"))
    return "Value exceeds allowed range. Integers are 64-bit signed.";
  if (lower.includes("constructor"))
    return "Constructor issues: constructor() runs once at deploy. It cannot have a return type.";

  return null;
}

const SYSTEM_PROMPT = `You are an expert in the Octra Network smart contract languages: AML (AppliedML) and Assembly (OASM).

AML key rules:
- EVERYTHING lives inside one Program block: Program Name { state {...} constructor() {...} fn ... } - a file without it fails with "expected program or contract"
- Function return types use a colon: fn name(args): int
- Types: int, u64, u128, string, address, bool, map[K]V
- No logical OR (||) - use separate if blocks
- Max 31 local variables (registers) per function
- call() uses flat args: call(contract, "method", arg1, arg2) - NOT [arg1, arg2]
- Built-ins: caller, self_addr, origin, value, require(), call(), to_string(), concat(), transfer(to, amount)
- while loops and nested maps work
- State variables go in state {} block

Assembly key rules:
- Stack-based, opcodes: PUSH, POP, ADD, SUB, MUL, DIV, MOD, CALL, RETURN, JUMP, JUMPI, STORE, LOAD
- Labels defined with LABEL: syntax
- Arguments accessed with PUSH argN

Given a compilation error and source code, explain the error concisely and suggest a fix. Be specific - reference the exact line and show corrected code if possible. Keep response under 150 words.`;

async function getAISuggestion(
  error: string,
  source: string,
  language: string,
  config: AISuggestionConfig,
): Promise<string | null> {
  if (!isAiReady(config)) return null;

  const userMessage = `Language: ${language}\n\nError:\n${error}\n\nSource code:\n${source}`;

  try {
    const { complete } = await import("src/services/ai/providerClient");
    const text = await complete(
      [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userMessage },
      ],
      config,
      { maxTokens: 2048 },
    );
    return text || null;
  } catch (err) {
    logger.warn("ai", `AI suggestion error: ${err}`);
    return null;
  }
}

export async function getSuggestion(
  error: string,
  source: string,
  language: string,
): Promise<AISuggestionResult> {
  const patternResult = getPatternSuggestion(error, language);
  const config = getConfig();

  if (isAiReady(config)) {
    try {
      const aiResult = await getAISuggestion(error, source, language, config);
      if (aiResult) {
        return { suggestion: aiResult, source: "ai" };
      }
    } catch {}
  }

  if (patternResult) {
    return { suggestion: patternResult, source: "pattern" };
  }

  return { suggestion: null, source: "pattern" };
}
