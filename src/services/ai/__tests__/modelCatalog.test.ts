import { describe, expect, it, vi } from "vitest";
import fixtures from "src/test/fixtures/ai-model-lists.json";

vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));

const { parseModelList, modelsRequest, reconcileSelection, endpointBase, maskKey, catalogSources } =
  await import("src/services/ai/modelCatalog");

describe("parseModelList", () => {
  it("reads Anthropic display names in the API's order", () => {
    expect(parseModelList("anthropic", fixtures.anthropic)).toEqual([
      { id: "claude-opus-5", label: "Claude Opus 5" },
      { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
      { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
    ]);
  });

  it("keeps OpenAI chat models only, newest first", () => {
    expect(parseModelList("openai", fixtures.openai).map((m) => m.id)).toEqual([
      "gpt-4.1-mini",
      "gpt-4.1",
      "o4-mini",
      "gpt-4o",
    ]);
    expect(parseModelList("openai", fixtures.openai)[0].label).toBe("GPT-4.1 mini");
  });

  it("drops inactive, speech and guard models from Groq", () => {
    expect(parseModelList("groq", fixtures.groq).map((m) => m.id)).toEqual([
      "llama-3.3-70b-versatile",
      "llama-3.1-8b-instant",
    ]);
  });

  it("keeps OpenRouter models that answer in text", () => {
    expect(parseModelList("openrouter", fixtures.openrouter).map((m) => m.id)).toEqual([
      "anthropic/claude-sonnet-5",
      "deepseek/deepseek-chat",
      "meta-llama/llama-3.3-70b-instruct",
    ]);
  });

  it("lists Ollama's installed chat models without embeddings", () => {
    expect(parseModelList("ollama", fixtures.ollama)).toEqual([
      { id: "llama3.2:latest", label: "llama3.2" },
      { id: "qwen2.5-coder:7b", label: "qwen2.5-coder:7b" },
    ]);
  });

  it("lists LM Studio's loaded models without embeddings", () => {
    expect(parseModelList("lmstudio", fixtures.lmstudio).map((m) => m.id)).toEqual([
      "qwen2.5-7b-instruct",
    ]);
  });

  it("survives a body that is not a list", () => {
    expect(parseModelList("openai", null)).toEqual([]);
    expect(parseModelList("ollama", { error: "x" })).toEqual([]);
  });
});

describe("modelsRequest", () => {
  it("sends each provider's own auth header", () => {
    expect(modelsRequest("anthropic", "sk-ant-x").headers).toMatchObject({
      "x-api-key": "sk-ant-x",
      "anthropic-version": "2023-06-01",
    });
    expect(modelsRequest("groq", "gsk_1").url).toBe("https://api.groq.com/openai/v1/models");
    expect(modelsRequest("openai", "sk-1").headers).toEqual({ Authorization: "Bearer sk-1" });
    expect(modelsRequest("ollama", "")).toEqual({
      url: "http://localhost:11434/api/tags",
      headers: {},
    });
    expect(modelsRequest("lmstudio", "").url).toBe("http://localhost:1234/v1/models");
    expect(modelsRequest("custom", "", "localhost:8080/v1/").url).toBe(
      "http://localhost:8080/v1/models",
    );
  });

  it("finds the base of a stored chat completions URL", () => {
    expect(endpointBase("https://api.example.com/v1/chat/completions")).toBe(
      "https://api.example.com/v1",
    );
  });
});

describe("reconcileSelection", () => {
  const models = [
    { id: "claude-opus-5", label: "Claude Opus 5" },
    { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
  ];
  const base = { provider: "anthropic" as const, apiKey: "sk-ant-x" };

  it("keeps a saved model the provider still lists", () => {
    const c = { ...base, model: "claude-sonnet-5" };
    expect(reconcileSelection(c, "anthropic", models)).toBe(c);
  });

  it("moves to the first listed model when the saved one is gone", () => {
    expect(reconcileSelection({ ...base, model: "claude-3-opus" }, "anthropic", models).model).toBe(
      "claude-opus-5",
    );
    expect(reconcileSelection(base, "anthropic", models).model).toBe("claude-opus-5");
  });

  it("starts with the first provider found when nothing was chosen", () => {
    const next = reconcileSelection({ provider: "none", apiKey: "" }, "ollama", [
      { id: "llama3.2:latest", label: "llama3.2" },
    ]);
    expect([next.provider, next.model]).toEqual(["ollama", "llama3.2:latest"]);
  });

  it("leaves another provider's selection alone", () => {
    const c = { ...base, model: "x" };
    expect(reconcileSelection(c, "openai", models)).toBe(c);
  });
});

describe("catalogSources", () => {
  it("lists saved keys masked, the custom endpoint and both local servers", () => {
    const s = catalogSources({
      provider: "openai",
      apiKey: "sk-abcd1234",
      savedKeys: [
        { provider: "openai", apiKey: "sk-abcd1234" },
        { provider: "custom", apiKey: "", customEndpoint: "http://localhost:8080/v1" },
      ],
    });
    expect(s.map((x) => [x.provider, x.source])).toEqual([
      ["openai", "sk-...1234"],
      ["custom", "localhost:8080/v1"],
      ["ollama", "localhost:11434"],
      ["lmstudio", "localhost:1234"],
    ]);
    expect(JSON.stringify(s.map((x) => x.source))).not.toContain("abcd");
  });

  it("masks keys by provider prefix", () => {
    expect(maskKey("sk-ant-api03-xyz9f2a")).toBe("sk-ant-...9f2a");
    expect(maskKey("gsk_0000e1b")).toBe("gsk_...0e1b");
  });
});
