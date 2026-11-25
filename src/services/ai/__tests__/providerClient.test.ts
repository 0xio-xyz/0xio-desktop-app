import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FIRST_BYTE_MS,
  IDLE_MS,
  parseSseChunk,
  silenceGuard,
} from "src/services/ai/providerClient";

const sse = (...events: unknown[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");

describe("parseSseChunk", () => {
  it("collects text deltas and keeps the unfinished tail", () => {
    const out: string[] = [];
    const rest = parseSseChunk(
      sse({ choices: [{ delta: { content: "he" } }] }, { choices: [{ delta: { content: "y" } }] }) +
        'data: {"choi',
      "openai",
      (t) => out.push(t),
    );
    expect(out.join("")).toBe("hey");
    expect(rest).toBe('data: {"choi');
  });

  it("ignores thinking deltas but not text", () => {
    const out: string[] = [];
    parseSseChunk(
      sse(
        { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hmm" } },
        { type: "content_block_delta", delta: { type: "text_delta", text: "ok" } },
      ),
      "anthropic",
      (t) => out.push(t),
    );
    expect(out).toEqual(["ok"]);
  });

  it("reports thinking without text, for both wires", () => {
    let thought = 0;
    const out: string[] = [];
    parseSseChunk(
      sse(
        { type: "content_block_start", content_block: { type: "thinking" } },
        { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "a" } },
        { type: "ping" },
      ),
      "anthropic",
      (t) => out.push(t),
      () => thought++,
    );
    parseSseChunk(
      sse({ choices: [{ delta: { reasoning_content: "b" } }] }),
      "openai",
      (t) => out.push(t),
      () => thought++,
    );
    expect(thought).toBe(3);
    expect(out).toEqual([]);
  });

  it("throws on an error event sent inside a 200 stream", () => {
    expect(() =>
      parseSseChunk(
        sse({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }),
        "anthropic",
        () => {},
      ),
    ).toThrow("Overloaded");
    expect(() =>
      parseSseChunk(sse({ error: { message: "Rate limit reached" } }), "openai", () => {}),
    ).toThrow("Rate limit reached");
  });
});

describe("silenceGuard", () => {
  afterEach(() => vi.useRealTimers());

  it("aborts with a readable reason when nothing arrives", () => {
    vi.useFakeTimers();
    const guard = silenceGuard(undefined, "anthropic");
    vi.advanceTimersByTime(FIRST_BYTE_MS - 1);
    expect(guard.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(guard.signal.aborted).toBe(true);
    expect(guard.timedOut()).toMatch(/No answer from anthropic for 90 seconds/);
  });

  it("keeps waiting while bytes keep arriving", () => {
    vi.useFakeTimers();
    const guard = silenceGuard(undefined, "openai");
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(IDLE_MS - 1);
      guard.touch();
    }
    expect(guard.signal.aborted).toBe(false);
    guard.done();
  });

  it("follows the caller's stop without a timeout reason", () => {
    const outer = new AbortController();
    const guard = silenceGuard(outer.signal, "groq");
    outer.abort();
    expect(guard.signal.aborted).toBe(true);
    expect(guard.timedOut()).toBeNull();
    guard.done();
  });
});
