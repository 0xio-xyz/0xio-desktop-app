// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, waitFor } from "@testing-library/react";

vi.mock("src/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  enqueue,
  getQueue,
  remove,
  resetQueue,
  retry,
  setHold,
  type JobSpec,
} from "src/features/privacy/services/proofQueue";
import {
  claimBatch,
  getActivity,
  resetActivity,
  toast,
  watchQueue,
} from "src/services/notices/activity";

const SCOPE = { networkId: "mainnet", address: `oct${"A".repeat(44)}` };
const OTHER = { networkId: "mainnet", address: `oct${"B".repeat(44)}` };

function deferred() {
  let resolve!: (v: { txHash?: string }) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<{ txHash?: string }>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function job(kind: JobSpec["kind"], run: JobSpec["run"], scope = SCOPE): JobSpec {
  return { kind, scope, amount: 1_000_000, steps: ["a", "b", "c"], run };
}

const statusOf = (id: string) => getQueue().jobs.find((j) => j.id === id)?.status;

beforeEach(() => {
  resetQueue();
  localStorage.clear();
});
afterEach(cleanup);

describe("proof queue", () => {
  it("runs one job at a time, in the order confirmed", async () => {
    const first = deferred();
    const second = vi.fn(async () => ({}));
    const a = enqueue(job("encrypt", () => first.promise));
    const b = enqueue(job("decrypt", second));
    expect(statusOf(a)).toBe("running");
    expect(statusOf(b)).toBe("queued");
    expect(second).not.toHaveBeenCalled();
    first.resolve({ txHash: "h" });
    await waitFor(() => expect(second).toHaveBeenCalled());
    const done = getQueue().done[`${SCOPE.networkId}:${SCOPE.address}`] ?? [];
    expect(done.map((e) => e.kind)).toContain("encrypt");
  });

  it("records the step each job reached", async () => {
    const d = deferred();
    let step: (n: number) => void = () => {};
    const id = enqueue(
      job("claim", (s) => {
        step = s;
        return d.promise;
      }),
    );
    act(() => step(2));
    const j = getQueue().jobs.find((x) => x.id === id)!;
    expect(j.step).toBe(2);
    expect(j.marks).toHaveLength(3);
    d.resolve({});
  });

  it("pauses the jobs behind a failed one until Retry or Remove", async () => {
    const failing = vi
      .fn()
      .mockRejectedValueOnce(new Error("The range proof did not verify."))
      .mockResolvedValue({});
    const next = vi.fn(async () => ({}));
    const a = enqueue(job("decrypt", failing));
    const b = enqueue(job("claim", next));
    await waitFor(() => expect(statusOf(a)).toBe("failed"));
    expect(statusOf(b)).toBe("queued");
    expect(next).not.toHaveBeenCalled();
    retry(a);
    await waitFor(() => expect(next).toHaveBeenCalled());
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it("Remove takes the failed job off and the next one runs", async () => {
    const next = vi.fn(async () => ({}));
    const a = enqueue(job("decrypt", async () => Promise.reject(new Error("bad"))));
    enqueue(job("claim", next));
    await waitFor(() => expect(statusOf(a)).toBe("failed"));
    remove(a);
    await waitFor(() => expect(next).toHaveBeenCalled());
  });

  it("a failure pauses only its own wallet", async () => {
    const other = vi.fn(async () => ({}));
    const a = enqueue(job("decrypt", async () => Promise.reject(new Error("bad"))));
    await waitFor(() => expect(statusOf(a)).toBe("failed"));
    enqueue(job("encrypt", other, OTHER));
    await waitFor(() => expect(other).toHaveBeenCalled());
  });

  it("holds a wallet's jobs while its key update is on hold", async () => {
    const run = vi.fn(async () => ({}));
    setHold(SCOPE, true);
    const a = enqueue(job("encrypt", run));
    expect(statusOf(a)).toBe("queued");
    expect(run).not.toHaveBeenCalled();
    setHold(SCOPE, false);
    await waitFor(() => expect(run).toHaveBeenCalled());
  });

  it("drops a job its owner takes back, such as a refusal before signing", async () => {
    const a = enqueue({
      ...job("refresh", async () => Promise.reject(new Error("fee"))),
      onFail: () => true,
    });
    await waitFor(() => expect(getQueue().jobs.find((j) => j.id === a)).toBeUndefined());
  });
});

describe("result toasts", () => {
  let stop: () => void;
  beforeEach(() => {
    resetActivity();
    stop = watchQueue();
  });
  afterEach(() => stop());

  it("one toast per job when it lands, with View for its transaction", async () => {
    const a = enqueue(job("encrypt", async () => ({ txHash: "h1" })));
    await waitFor(() => expect(statusOf(a)).toBe("done"));
    expect(getActivity().toasts).toEqual([
      expect.objectContaining({
        title: "activity.encrypted",
        values: { amount: 1_000_000 },
        view: { hash: "h1", network: "mainnet" },
      }),
    ]);
  });

  it("a stopped job ends in a failed toast that leads back to Try again", async () => {
    const a = enqueue(job("decrypt", async () => Promise.reject(new Error("no"))));
    await waitFor(() => expect(statusOf(a)).toBe("failed"));
    expect(getActivity().toasts[0]).toMatchObject({
      title: "activity.decryptFailed",
      failed: true,
      retry: { route: "/privacy", ref: a },
    });
  });

  it("Claim all reports once, when the last claim lands", async () => {
    const gate = deferred();
    const ids = [
      enqueue(job("claim", async () => ({}))),
      enqueue(job("claim", () => gate.promise)),
    ];
    claimBatch(ids);
    await waitFor(() => expect(statusOf(ids[0])).toBe("done"));
    expect(getActivity().toasts).toHaveLength(0);
    await act(async () => gate.resolve({ txHash: "h2" }));
    await waitFor(() => expect(getActivity().toasts).toHaveLength(1));
    expect(getActivity().toasts[0]).toMatchObject({
      title: "activity.claimedN",
      values: { count: 2, amount: 2_000_000 },
    });
  });

  it("keeps three toasts at most, newest on top", () => {
    for (let i = 0; i < 4; i++) toast({ title: `t${i}` });
    expect(getActivity().toasts.map((t) => t.title)).toEqual(["t3", "t2", "t1"]);
  });
});
