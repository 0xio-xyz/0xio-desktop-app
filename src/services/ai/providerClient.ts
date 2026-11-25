import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { logger } from "src/lib/logger";
import type { AISuggestionConfig } from "src/services/ai/aiSuggestionService";
import { endpointBase } from "src/services/ai/modelCatalog";

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

interface ProviderRequest {
  endpoint: string;
  headers: Record<string, string>;
  wire: "anthropic" | "openai";
  /** OpenAI proper rejects max_tokens on reasoning models; its compat peers still use it. */
  maxTokensKey: "max_tokens" | "max_completion_tokens";
  /** Only OpenAI proper is known to accept stream_options; strict compat servers reject unknown fields. */
  streamUsage?: true;
}

export function buildRequest(config: AISuggestionConfig): ProviderRequest {
  switch (config.provider) {
    case "groq":
      return {
        endpoint: "https://api.groq.com/openai/v1/chat/completions",
        headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
        wire: "openai",
        maxTokensKey: "max_tokens",
      };
    case "openai":
      return {
        endpoint: "https://api.openai.com/v1/chat/completions",
        headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
        wire: "openai",
        maxTokensKey: "max_completion_tokens",
        streamUsage: true,
      };
    case "openrouter":
      return {
        endpoint: "https://openrouter.ai/api/v1/chat/completions",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://0xio.xyz",
          "X-Title": "0xio Desktop",
        },
        wire: "openai",
        maxTokensKey: "max_tokens",
      };
    case "anthropic":
      return {
        endpoint: "https://api.anthropic.com/v1/messages",
        headers: {
          "x-api-key": config.apiKey,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        wire: "anthropic",
        maxTokensKey: "max_tokens",
      };
    case "ollama":
      return {
        endpoint: "http://localhost:11434/v1/chat/completions",
        headers: { "Content-Type": "application/json" },
        wire: "openai",
        maxTokensKey: "max_tokens",
      };
    case "lmstudio":
      return {
        endpoint: "http://localhost:1234/v1/chat/completions",
        headers: { "Content-Type": "application/json" },
        wire: "openai",
        maxTokensKey: "max_tokens",
      };
    case "custom": {
      if (!config.customEndpoint) throw new Error("No custom endpoint configured");
      return {
        endpoint: `${endpointBase(config.customEndpoint)}/chat/completions`,
        headers: {
          ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
          "Content-Type": "application/json",
        },
        wire: "openai",
        maxTokensKey: "max_tokens",
      };
    }
    default:
      throw new Error("No AI provider configured");
  }
}

const CACHE_BREAKPOINTS = 4;
const EPHEMERAL = { type: "ephemeral" } as const;

// Callers order messages as prompt, file, history, new message so the prefix repeats turn after
// turn: Anthropic caches up to each marked block, OpenAI-compatible servers cache it on their own.
export function buildBody(
  req: ProviderRequest,
  model: string,
  messages: ChatMessage[],
  maxTokens: number,
  stream: boolean,
): string {
  // An empty content block is a hard 400 on Anthropic (and on strict compat servers); an aborted
  // turn can leave one in the history.
  const clean = messages.filter((m) => m.content.trim() !== "");
  if (req.wire === "anthropic") {
    const system = clean.filter((m) => m.role === "system");
    const turns = clean.filter((m) => m.role !== "system");
    const firstMarked = system.length - (CACHE_BREAKPOINTS - 1);
    const prior = turns.length - 2;
    return JSON.stringify({
      model,
      max_tokens: maxTokens,
      ...(system.length
        ? {
            system: system.map((m, i) => ({
              type: "text",
              text: m.content,
              ...(i >= firstMarked ? { cache_control: EPHEMERAL } : {}),
            })),
          }
        : {}),
      messages: turns.map((m, i) =>
        i === prior
          ? {
              role: m.role,
              content: [{ type: "text", text: m.content, cache_control: EPHEMERAL }],
            }
          : { role: m.role, content: m.content },
      ),
      ...(stream ? { stream: true } : {}),
    });
  }
  return JSON.stringify({
    model,
    [req.maxTokensKey]: maxTokens,
    messages: clean.map((m) => ({ role: m.role, content: m.content })),
    ...(stream ? { stream: true } : {}),
    ...(stream && req.streamUsage ? { stream_options: { include_usage: true } } : {}),
  });
}

export type Usage = Record<string, number>;

const USAGE_FIELDS = {
  anthropic: [
    "input_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
    "output_tokens",
  ],
  openai: ["prompt_tokens", "completion_tokens"],
} as const;

function pickUsage(wire: "anthropic" | "openai", raw: unknown): Usage | null {
  const u = raw as any;
  if (!u || typeof u !== "object") return null;
  const out: Usage = {};
  for (const k of USAGE_FIELDS[wire]) if (typeof u[k] === "number") out[k] = u[k];
  const cached = u.prompt_tokens_details?.cached_tokens;
  if (wire === "openai" && typeof cached === "number") out.cached_tokens = cached;
  return Object.keys(out).length ? out : null;
}

function extractUsage(wire: "anthropic" | "openai", event: unknown): Usage | null {
  const e = event as any;
  if (wire === "anthropic") {
    if (e?.type === "message_start") return pickUsage(wire, e.message?.usage);
    if (e?.type === "message_delta") return pickUsage(wire, e.usage);
    return null;
  }
  return pickUsage(wire, e?.usage);
}

export function formatUsage(usage: Usage): string {
  return Object.entries(usage)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
}

function extractText(wire: "anthropic" | "openai", data: unknown): string {
  const d = data as any;
  if (wire === "anthropic") {
    // Current Claude models think by default: content[0] is a thinking block,
    // so the text block must be found by type, never by position.
    const blocks: any[] = Array.isArray(d?.content) ? d.content : [];
    return blocks.find((b) => b?.type === "text")?.text || "";
  }
  return d?.choices?.[0]?.message?.content || "";
}

function extractDelta(wire: "anthropic" | "openai", event: unknown): string {
  const e = event as any;
  if (wire === "anthropic") {
    return e?.type === "content_block_delta" && e?.delta?.type === "text_delta" ? e.delta.text : "";
  }
  return e?.choices?.[0]?.delta?.content || "";
}

function isThinking(wire: "anthropic" | "openai", event: unknown): boolean {
  const e = event as any;
  if (wire === "anthropic") {
    return (
      (e?.type === "content_block_delta" && e?.delta?.type === "thinking_delta") ||
      (e?.type === "content_block_start" && e?.content_block?.type === "thinking")
    );
  }
  const d = e?.choices?.[0]?.delta;
  return !!(d?.reasoning_content || d?.reasoning);
}

export type StreamStatus = "waiting" | "thinking" | "writing";

// A provider that fails mid-answer sends the error as a stream event with a 200 status.
function streamError(event: unknown): string | null {
  const e = event as any;
  if (e?.type === "error" || e?.error) {
    return e?.error?.message || (typeof e?.error === "string" ? e.error : "") || "stream error";
  }
  return null;
}

export function parseSseChunk(
  buffer: string,
  wire: "anthropic" | "openai",
  onDelta: (text: string) => void,
  onThinking: () => void = () => {},
  onUsage: (usage: Usage) => void = () => {},
): string {
  // Some servers/proxies emit CRLF SSE; without this, deltas would only flush at stream end.
  const events = buffer.split(/\r?\n\r?\n/);
  const rest = events.pop() ?? "";
  for (const evt of events) {
    for (const line of evt.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let event: unknown;
      try {
        event = JSON.parse(payload);
      } catch {
        continue;
      }
      const failed = streamError(event);
      if (failed) throw new Error(failed);
      const usage = extractUsage(wire, event);
      if (usage) onUsage(usage);
      const delta = extractDelta(wire, event);
      if (delta) onDelta(delta);
      else if (isThinking(wire, event)) onThinking();
    }
  }
  return rest;
}

async function throwApiError(res: Response, provider: string): Promise<never> {
  const errText = await res.text().catch(() => "");
  logger.error("ai", `${provider} error ${res.status}: ${errText.slice(0, 300)}`);
  throw new Error(
    `${provider} API error: ${res.status}${errText ? ` - ${errText.slice(0, 200)}` : ""}`,
  );
}

interface CompletionOptions {
  maxTokens?: number;
  signal?: AbortSignal;
  onStatus?: (status: StreamStatus) => void;
}

function resolveModel(config: AISuggestionConfig): string {
  const model = config.model || config.customModel;
  if (!model) throw new Error("No model selected");
  return model;
}

export const FIRST_BYTE_MS = 90_000;
export const IDLE_MS = 60_000;

// Aborts when the provider stays silent; any received bytes (thinking included) reset it.
export function silenceGuard(outer: AbortSignal | undefined, provider: string) {
  const controller = new AbortController();
  let timedOut: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (ms: number) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = `No answer from ${provider} for ${Math.round(ms / 1000)} seconds. Try again or pick another model.`;
      controller.abort();
    }, ms);
  };
  const onOuter = () => controller.abort();
  if (outer?.aborted) controller.abort();
  outer?.addEventListener("abort", onOuter, { once: true });
  arm(FIRST_BYTE_MS);
  return {
    signal: controller.signal,
    touch: () => arm(IDLE_MS),
    timedOut: () => timedOut,
    done: () => {
      clearTimeout(timer);
      outer?.removeEventListener("abort", onOuter);
    },
  };
}

export async function complete(
  messages: ChatMessage[],
  config: AISuggestionConfig,
  opts: CompletionOptions = {},
): Promise<string> {
  const req = buildRequest(config);
  const model = resolveModel(config);
  const guard = silenceGuard(opts.signal, config.provider);
  const started = Date.now();
  try {
    const res = await tauriFetch(req.endpoint, {
      method: "POST",
      headers: req.headers,
      body: buildBody(req, model, messages, opts.maxTokens ?? 4096, false),
      signal: guard.signal,
    });
    if (!res.ok) await throwApiError(res, config.provider);
    const data = await res.json();
    const usage = pickUsage(req.wire, (data as any)?.usage);
    if (usage) logger.info("ai", `${config.provider} ${model} usage ${formatUsage(usage)}`);
    const text = extractText(req.wire, data);
    if (!text) throw new Error(`${config.provider} returned an empty answer`);
    logger.info("ai", `${config.provider} ${model} answered in ${Date.now() - started} ms`);
    return text;
  } catch (err) {
    const timedOut = guard.timedOut();
    logger.warn(
      "ai",
      `${config.provider} ${model} failed after ${Date.now() - started} ms: ${timedOut ?? (err instanceof Error ? err.message : String(err))}`,
    );
    throw timedOut ? new Error(timedOut) : err;
  } finally {
    guard.done();
  }
}

export async function streamCompletion(
  messages: ChatMessage[],
  config: AISuggestionConfig,
  onDelta: (text: string) => void,
  opts: CompletionOptions = {},
): Promise<string> {
  const req = buildRequest(config);
  const model = resolveModel(config);
  const guard = silenceGuard(opts.signal, config.provider);
  const started = Date.now();
  let full = "";
  let status: StreamStatus = "waiting";
  let firstByte = 0;
  const usage: Usage = {};
  const onUsage = (u: Usage) => Object.assign(usage, u);
  const setStatus = (next: StreamStatus) => {
    if (status === next) return;
    status = next;
    opts.onStatus?.(next);
    logger.info("ai", `${config.provider} ${model} ${next} after ${Date.now() - started} ms`);
  };
  const collect = (t: string) => {
    guard.touch();
    setStatus("writing");
    full += t;
    onDelta(t);
  };
  const thinking = () => {
    guard.touch();
    if (status === "waiting") setStatus("thinking");
  };
  opts.onStatus?.("waiting");
  logger.info("ai", `${config.provider} ${model} request sent`);
  try {
    const res = await tauriFetch(req.endpoint, {
      method: "POST",
      headers: req.headers,
      body: buildBody(req, model, messages, opts.maxTokens ?? 4096, true),
      signal: guard.signal,
    });
    if (!res.ok) await throwApiError(res, config.provider);
    logger.info(
      "ai",
      `${config.provider} ${model} status ${res.status} after ${Date.now() - started} ms`,
    );

    if (res.body) {
      const reader = res.body.getReader();
      guard.signal.addEventListener("abort", () => void reader.cancel().catch(() => {}), {
        once: true,
      });
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        // Models that think silently send only keep-alive pings, sometimes 30 s apart.
        guard.touch();
        if (!firstByte) {
          firstByte = Date.now() - started;
          logger.info("ai", `${config.provider} ${model} first data after ${firstByte} ms`);
        }
        buffer = parseSseChunk(
          buffer + decoder.decode(value, { stream: true }),
          req.wire,
          collect,
          thinking,
          onUsage,
        );
      }
      parseSseChunk(buffer + "\n\n", req.wire, collect, thinking, onUsage);
    } else {
      parseSseChunk((await res.text()) + "\n\n", req.wire, collect, thinking, onUsage);
    }
    if (!full) throw new Error(`${config.provider} returned an empty answer`);
    logger.info("ai", `${config.provider} ${model} answered in ${Date.now() - started} ms`);
    return full;
  } catch (err) {
    const timedOut = guard.timedOut();
    logger.warn(
      "ai",
      `${config.provider} ${model} failed after ${Date.now() - started} ms: ${timedOut ?? (err instanceof Error ? err.message : String(err))}`,
    );
    throw timedOut ? new Error(timedOut) : err;
  } finally {
    guard.done();
    if (Object.keys(usage).length)
      logger.info("ai", `${config.provider} ${model} usage ${formatUsage(usage)}`);
  }
}
