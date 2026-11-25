import { afterEach, describe, expect, it, vi } from "vitest";
import vectors from "src/test/fixtures/rpc-retry-vectors.json";
import {
  GATE_MAX_REQUEST_S,
  PAUSES_S,
  PAUSE_SPREAD,
  POLL_SLOTS,
  RETRY_AFTER_CAP_S,
  RETRY_WINDOW_S,
  RpcGate,
  SLOTS,
  STATE_CHANGED_CODE,
  classify,
  gateRoom,
  isWrite,
  pauseSeconds,
  retryAfterHeader,
  retryWindowSeconds,
  shouldRepeat,
  type RpcFault,
  type RpcLane,
  type RpcLink,
} from "src/services/network/rpcRetry";
import { outputStateOf } from "src/features/privacy/services/claimLedger";

const parse = (body: string | undefined) => {
  try {
    return body ? JSON.parse(body) : undefined;
  } catch {
    return undefined;
  }
};

describe("rpc retry vectors", () => {
  it("pins the constants and the write list", () => {
    const c = vectors.constants;
    expect([RETRY_WINDOW_S, RETRY_AFTER_CAP_S, PAUSE_SPREAD, STATE_CHANGED_CODE]).toEqual([
      c.retryWindowSeconds,
      c.retryAfterCapSeconds,
      c.pauseSpread,
      c.stateChangedCode,
    ]);
    expect(PAUSES_S).toEqual(c.pausesSeconds);
    expect([SLOTS, POLL_SLOTS, GATE_MAX_REQUEST_S]).toEqual([
      c.slots,
      c.pollSlots,
      c.gateMaxRequestSeconds,
    ]);
    for (const m of vectors.writes) expect(isWrite(m)).toBe(true);
    for (const m of ["octra_balance", "octra_transaction", "contract_call", "staging_view"])
      expect(isWrite(m)).toBe(false);
  });

  it.each(vectors.classify)("classify: $name", (v) => {
    const step = classify(
      v.link as RpcLink,
      (v as { status?: number }).status,
      parse((v as { body?: string }).body),
    );
    expect({ fault: step.fault, unsent: step.unsent }).toEqual({
      fault: v.fault,
      unsent: v.unsent,
    });
  });

  it.each(vectors.repeat)("repeat $fault unsent=$unsent write=$write", (v) => {
    expect(shouldRepeat({ fault: v.fault as RpcFault, unsent: v.unsent }, v.write)).toBe(v.repeat);
  });

  it.each(vectors.pause)("pause attempt $attempt retryAfter $retryAfter draw $draw", (v) => {
    expect(pauseSeconds(v.attempt, v.retryAfter, v.draw)).toBeCloseTo(v.seconds, 9);
  });

  it.each(vectors.retryAfterHeader)("Retry-After '$header'", (v) => {
    expect(retryAfterHeader(v.header)).toBe(v.value);
  });

  it.each(vectors.window)("window for a $requestSeconds s request", (v) => {
    expect(retryWindowSeconds(v.requestSeconds)).toBe(v.windowSeconds);
  });

  it.each(vectors.gateRoom)("gate room busy $busy polls $polls users $usersWaiting $lane", (v) => {
    expect(gateRoom(v.busy, v.polls, v.usersWaiting, v.lane as RpcLane)).toBe(v.room);
  });

  it.each(vectors.claimOutput)("claim output: $name", (v) => {
    expect(outputStateOf(v.reply)).toBe(v.state);
  });
});

describe("rpc gate", () => {
  afterEach(() => vi.useRealTimers());

  it("lets four in, polls take two and yield to a waiting user call", async () => {
    const gate = new RpcGate();
    const far = Date.now() + 60_000;
    expect(await gate.enter("poll", far)).toBe(true);
    expect(await gate.enter("poll", far)).toBe(true);
    const order: string[] = [];
    const poll = gate.enter("poll", far).then((ok) => order.push(`poll:${ok}`));
    expect(await gate.enter("user", far)).toBe(true);
    expect(await gate.enter("user", far)).toBe(true);
    const user = gate.enter("user", far).then((ok) => order.push(`user:${ok}`));
    await Promise.resolve();
    expect(order).toEqual([]);
    gate.leave("poll");
    await user;
    expect(order).toEqual(["user:true"]);
    gate.leave("user");
    await poll;
    expect(order).toEqual(["user:true", "poll:true"]);
  });

  it("a user call waits up to its deadline, then gives up", async () => {
    vi.useFakeTimers();
    const gate = new RpcGate();
    const far = Date.now() + 60_000;
    for (let i = 0; i < SLOTS; i++) expect(await gate.enter("user", far)).toBe(true);
    const waiting = gate.enter("user", Date.now() + RETRY_WINDOW_S * 1000);
    await vi.advanceTimersByTimeAsync(RETRY_WINDOW_S * 1000 + 1);
    expect(await waiting).toBe(false);
    gate.leave("user");
    expect(await gate.enter("poll", far)).toBe(true);
  });
});
