import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  bodies: [] as any[],
  reply: "",
  info: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: vi.fn(async (_url: string, init: { body: string }) => {
    m.bodies.push(JSON.parse(init.body));
    return new Response(m.reply);
  }),
}));
vi.mock("src/lib/logger", () => ({
  logger: { debug: vi.fn(), info: m.info, warn: vi.fn(), error: vi.fn() },
}));

import { chatWithAI, HISTORY_CHARS, trimHistory } from "src/services/ai/aiChatService";
import type { AISuggestionConfig } from "src/services/ai/aiSuggestionService";
import { buildBody, buildRequest, type ChatMessage } from "src/services/ai/providerClient";

const sse = (...events: unknown[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
const cfg = (provider: AISuggestionConfig["provider"]): AISuggestionConfig => ({
  provider,
  apiKey: "test-key",
  model: "m1",
  customEndpoint: provider === "custom" ? "https://example.test/v1" : undefined,
});
const EPH = { type: "ephemeral" };

const anthropicReply = sse(
  {
    type: "message_start",
    message: {
      usage: {
        input_tokens: 12,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 4100,
        output_tokens: 1,
      },
    },
  },
  { type: "content_block_delta", delta: { type: "text_delta", text: "ok" } },
  { type: "message_delta", usage: { output_tokens: 7 } },
);
const openaiReply = sse(
  { choices: [{ delta: { content: "ok" } }] },
  {
    choices: [],
    usage: {
      prompt_tokens: 5000,
      completion_tokens: 3,
      prompt_tokens_details: { cached_tokens: 4096 },
    },
  },
);

const history: ChatMessage[] = [
  { role: "user", content: "q1" },
  { role: "assistant", content: "a1" },
  { role: "user", content: "q2" },
];

beforeEach(() => {
  m.bodies.length = 0;
  m.info.mockClear();
});

describe("anthropic request", () => {
  it("sends prompt and file as cached system blocks and marks the earlier turn", async () => {
    m.reply = anthropicReply;
    await chatWithAI(history, cfg("anthropic"), {
      sourceCode: "Program A {}",
      selection: "fn x()",
      language: "aml",
      mode: "auto",
      onDelta: () => {},
    });
    const body = m.bodies[0];
    expect(body.system).toHaveLength(2);
    expect(body.system[0]).toMatchObject({ type: "text", cache_control: EPH });
    expect(body.system[0].text).toMatch(/^You are the contract assistant/);
    expect(body.system[0].text).toContain("## Auto mode");
    expect(body.system[1].text).toContain("Program A {}");
    expect(body.system[1].text).toContain("fn x()");
    expect(body.system[1].cache_control).toEqual(EPH);
    expect(body.messages).toEqual([
      { role: "user", content: "q1" },
      { role: "assistant", content: [{ type: "text", text: "a1", cache_control: EPH }] },
      { role: "user", content: "q2" },
    ]);
    expect(body.stream).toBe(true);
    expect(body.stream_options).toBeUndefined();
  });

  it("never sends an empty block and leaves the file block out when there is no file", async () => {
    m.reply = anthropicReply;
    await chatWithAI(
      [
        { role: "user", content: "q1" },
        { role: "assistant", content: "" },
        { role: "user", content: "q2" },
      ],
      cfg("anthropic"),
      { sourceCode: "  ", selection: "", language: "aml", onDelta: () => {} },
    );
    const body = m.bodies[0];
    expect(body.system).toHaveLength(1);
    expect(body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "q1", cache_control: EPH }] },
      { role: "user", content: "q2" },
    ]);
    const text = JSON.stringify(body);
    expect(text).not.toContain('"text":""');
    expect(text).not.toContain('"content":""');
  });

  it("has no history breakpoint on the first message and never more than four", () => {
    const req = buildRequest(cfg("anthropic"));
    const one = JSON.parse(buildBody(req, "m1", [{ role: "user", content: "hi" }], 10, true));
    expect(one.system).toBeUndefined();
    expect(one.messages).toEqual([{ role: "user", content: "hi" }]);

    const sys = Array.from({ length: 5 }, (_, i) => ({
      role: "system" as const,
      content: `s${i}`,
    }));
    const many = buildBody(req, "m1", [...sys, ...history], 10, true);
    expect(many.match(/cache_control/g)).toHaveLength(4);
  });

  it("logs one usage line with the cache numbers and no content", async () => {
    m.reply = anthropicReply;
    await chatWithAI(history, cfg("anthropic"), {
      sourceCode: "",
      language: "aml",
      onDelta: () => {},
    });
    const lines = m.info.mock.calls.map((c) => String(c[1])).filter((l) => l.includes("usage"));
    expect(lines).toEqual([
      "anthropic m1 usage input_tokens=12 cache_creation_input_tokens=0 cache_read_input_tokens=4100 output_tokens=7",
    ]);
  });
});

describe("openai-compatible requests", () => {
  it("keeps prompt, file, history, new message in order as plain messages", async () => {
    m.reply = openaiReply;
    await chatWithAI(history, cfg("groq"), {
      sourceCode: "Program A {}",
      language: "aml",
      onDelta: () => {},
    });
    const body = m.bodies[0];
    expect(body.messages.map((x: ChatMessage) => x.role)).toEqual([
      "system",
      "system",
      "user",
      "assistant",
      "user",
    ]);
    expect(body.messages[1].content).toContain("Program A {}");
    expect(body.messages.slice(2).map((x: ChatMessage) => x.content)).toEqual(["q1", "a1", "q2"]);
    expect(JSON.stringify(body)).not.toContain("cache_control");
  });

  it("asks for stream usage only from OpenAI itself", async () => {
    m.reply = openaiReply;
    for (const p of ["openai", "groq", "openrouter", "ollama", "lmstudio", "custom"] as const) {
      await chatWithAI(history, cfg(p), { sourceCode: "", language: "aml", onDelta: () => {} });
    }
    const opts = m.bodies.map((b) => b.stream_options);
    expect(opts).toEqual([
      { include_usage: true },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(m.bodies[0].max_completion_tokens).toBe(16000);
  });

  it("logs cached prompt tokens when the provider reports them", async () => {
    m.reply = openaiReply;
    await chatWithAI(history, cfg("openai"), {
      sourceCode: "",
      language: "aml",
      onDelta: () => {},
    });
    const lines = m.info.mock.calls.map((c) => String(c[1])).filter((l) => l.includes("usage"));
    expect(lines).toEqual([
      "openai m1 usage prompt_tokens=5000 completion_tokens=3 cached_tokens=4096",
    ]);
  });
});

describe("trimHistory", () => {
  const turn = (i: number, size: number): ChatMessage[] => [
    { role: "user", content: `${i}`.padEnd(size, "u") },
    { role: "assistant", content: `${i}`.padEnd(size, "a") },
  ];

  it("keeps a short history whole", () => {
    expect(trimHistory(history)).toBe(history);
  });

  it("drops the oldest turns, starts on a user message and keeps the cut stable", () => {
    const size = HISTORY_CHARS / 20;
    const long = Array.from({ length: 12 }, (_, i) => turn(i, size)).flat();
    const a = trimHistory([...long, { role: "user", content: "new" }]);
    const b = trimHistory([...long, { role: "user", content: "x".repeat(size / 2) }]);
    expect(a[0].role).toBe("user");
    expect(a.reduce((n, x) => n + x.content.length, 0)).toBeLessThanOrEqual(HISTORY_CHARS);
    expect(a[0]).toBe(b[0]);
  });

  it("always keeps the new message", () => {
    const big: ChatMessage = { role: "user", content: "x".repeat(HISTORY_CHARS * 2) };
    expect(trimHistory([...history, big])).toEqual([big]);
  });
});
