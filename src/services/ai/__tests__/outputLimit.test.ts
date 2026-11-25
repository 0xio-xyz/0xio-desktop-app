import { describe, expect, it } from "vitest";
import { parseSseChunk } from "src/services/ai/providerClient";
import { parseModelList } from "src/services/ai/modelCatalog";

const sse = (...events: unknown[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");

describe("stop reason", () => {
  it("reports an anthropic answer cut at max_tokens", () => {
    const stops: string[] = [];
    parseSseChunk(
      sse({
        type: "message_delta",
        delta: { stop_reason: "max_tokens" },
        usage: { output_tokens: 16000 },
      }),
      "anthropic",
      () => {},
      () => {},
      () => {},
      (r) => stops.push(r),
    );
    expect(stops).toEqual(["max_tokens"]);
  });

  it("reports an openai answer cut by length and a normal stop", () => {
    const stops: string[] = [];
    parseSseChunk(
      sse(
        { choices: [{ delta: {}, finish_reason: "length" }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ),
      "openai",
      () => {},
      () => {},
      () => {},
      (r) => stops.push(r),
    );
    expect(stops).toEqual(["length", "stop"]);
  });
});

describe("model output limits", () => {
  it("reads max_tokens from the anthropic list", () => {
    const models = parseModelList("anthropic", {
      data: [
        {
          type: "model",
          id: "claude-mythos-5-2",
          display_name: "Claude Mythos 5.2",
          max_tokens: 128000,
        },
        { type: "model", id: "old", display_name: "Old" },
      ],
    });
    expect(models[0].maxOutput).toBe(128000);
    expect(models[1].maxOutput).toBeUndefined();
  });

  it("reads the top provider limit from openrouter", () => {
    const models = parseModelList("openrouter", {
      data: [
        {
          id: "a/b",
          architecture: { output_modalities: ["text"] },
          top_provider: { max_completion_tokens: 32768 },
        },
      ],
    });
    expect(models[0].maxOutput).toBe(32768);
  });
});
