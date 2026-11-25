import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("src/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("src/services/notices/noticeNative", () => ({ announce: vi.fn() }));

import {
  WORK_HOLD_MAX_MS,
  autoLockDue,
  watchAutoLock,
  type IdleReport,
} from "src/features/security/services/autoLock";
import { enqueue, resetQueue, retry, getQueue } from "src/features/privacy/services/proofQueue";
import { endSend, startSend } from "src/services/notices/activity";
import { holdWork, workInFlight } from "src/services/app/workInFlight";

const MIN = 60_000;
const scope = { networkId: "devnet", address: "octA" };

function job() {
  let finish!: (hash: string) => void;
  let fail!: (e: Error) => void;
  const id = enqueue({
    kind: "encrypt",
    scope,
    amount: 1,
    steps: ["a", "b"],
    run: (step) =>
      new Promise((resolve, reject) => {
        step(0);
        finish = (txHash) => resolve({ txHash });
        fail = reject;
      }),
  } as Parameters<typeof enqueue>[0]);
  return { id, finish: (h = "h") => finish(h), fail: (e = new Error("no")) => fail(e) };
}

function watch(minutes = 15) {
  const lock = vi.fn();
  const reports: IdleReport[] = [];
  const w = watchAutoLock({ minutes, lock, report: (r) => reports.push(r) });
  return { ...w, lock, reports };
}

beforeEach(() => {
  vi.useFakeTimers();
  resetQueue();
});
afterEach(() => vi.useRealTimers());

describe("auto-lock", () => {
  it("locks after the quiet time and not before", async () => {
    const w = watch(15);
    await vi.advanceTimersByTimeAsync(14 * MIN);
    expect(w.lock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(MIN);
    expect(w.lock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(w.lock).toHaveBeenCalledTimes(1);
  });

  it("starts counting from the unlock and from each activity", async () => {
    await vi.advanceTimersByTimeAsync(120 * MIN);
    const w = watch(15);
    await vi.advanceTimersByTimeAsync(10 * MIN);
    w.activity();
    await vi.advanceTimersByTimeAsync(14 * MIN);
    expect(w.lock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(MIN);
    expect(w.lock).toHaveBeenCalledTimes(1);
  });

  it("never locks when set to 0 and says so", async () => {
    const w = watch(0);
    await vi.advanceTimersByTimeAsync(24 * 60 * MIN);
    expect(w.lock).not.toHaveBeenCalled();
    expect(w.reports[0]).toEqual({ autoLockMinutes: 0, active: true, working: false });
  });

  it("waits for a running job and locks the moment the queue drains", async () => {
    const w = watch(1);
    const first = job();
    const second = job();
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(w.lock).not.toHaveBeenCalled();
    first.finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(workInFlight()).toBe(true);
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(w.lock).not.toHaveBeenCalled();
    second.finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(w.lock).toHaveBeenCalledTimes(1);
  });

  it("does not wait for jobs stuck behind a failed one", async () => {
    const w = watch(1);
    const first = job();
    job();
    first.fail();
    await vi.advanceTimersByTimeAsync(0);
    expect(getQueue().jobs.map((j) => j.status)).toEqual(["failed", "queued"]);
    expect(workInFlight()).toBe(false);
    await vi.advanceTimersByTimeAsync(MIN);
    expect(w.lock).toHaveBeenCalledTimes(1);
    retry(first.id);
    expect(workInFlight()).toBe(true);
  });

  it("waits for a public send and for work held from the menu bar", async () => {
    const w = watch(1);
    startSend({ id: "s1", amount: 1, unit: "OCT", to: "octB", steps: ["a"], marks: [] });
    const release = holdWork();
    await vi.advanceTimersByTimeAsync(3 * MIN);
    expect(w.lock).not.toHaveBeenCalled();
    endSend("s1");
    await vi.advanceTimersByTimeAsync(MIN);
    expect(w.lock).not.toHaveBeenCalled();
    release();
    expect(w.lock).toHaveBeenCalledTimes(1);
  });

  it("stops waiting for work that shows no progress for the hold limit", async () => {
    const w = watch(1);
    job();
    await vi.advanceTimersByTimeAsync(WORK_HOLD_MAX_MS - MIN);
    expect(w.lock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(MIN);
    expect(w.lock).toHaveBeenCalledTimes(1);
  });

  it("locks instead of taking late activity as a reason to stay open", async () => {
    const w = watch(1);
    vi.setSystemTime(Date.now() + 8 * 60 * MIN);
    w.activity();
    expect(w.lock).toHaveBeenCalledTimes(1);
  });

  it("reports activity, work starting and work ending", async () => {
    const w = watch(15);
    expect(w.reports).toEqual([{ autoLockMinutes: 15, active: true, working: false }]);
    w.activity();
    expect(w.reports).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10_000);
    w.activity();
    expect(w.reports).toHaveLength(2);
    const running = job();
    expect(w.reports[w.reports.length - 1]).toEqual({
      autoLockMinutes: 15,
      active: false,
      working: true,
    });
    running.finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(w.reports[w.reports.length - 1]).toEqual({
      autoLockMinutes: 15,
      active: false,
      working: false,
    });
  });

  it("stops watching once stopped", async () => {
    const w = watch(1);
    w.stop();
    await vi.advanceTimersByTimeAsync(10 * MIN);
    w.activity();
    expect(w.lock).not.toHaveBeenCalled();
  });
});

describe("autoLockDue", () => {
  const base = { now: 100 * MIN, lastActivity: 0, lockMs: 15 * MIN, working: false, workSince: 0 };
  it("holds while working, up to the limit", () => {
    expect(autoLockDue(base)).toBe(true);
    expect(autoLockDue({ ...base, working: true, workSince: 90 * MIN })).toBe(false);
    expect(autoLockDue({ ...base, working: true, workSince: 100 * MIN - WORK_HOLD_MAX_MS })).toBe(
      true,
    );
    expect(autoLockDue({ ...base, lockMs: 0 })).toBe(false);
    expect(autoLockDue({ ...base, lastActivity: 90 * MIN })).toBe(false);
  });
});
