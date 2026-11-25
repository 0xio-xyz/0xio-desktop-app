import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
vi.mock("src/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  approveOnce,
  checkOnce,
  nextPollMs,
  startSigning,
  watchSiteTx,
  WATCH_FOR_MS,
  type SiteWatch,
  type WatchDeps,
} from "src/features/dapp/services/siteLifecycle";
import type { TransactionDetail } from "src/types/transaction";

const H1 = "a".repeat(64);
const H2 = "b".repeat(64);

const detail = (status: string, extra: Partial<TransactionDetail> = {}): TransactionDetail => ({
  hash: H1,
  from: "",
  to: "",
  amount_raw: "0",
  op_type: "standard",
  status,
  timestamp: 0,
  nonce: 0,
  ...extra,
});

const watch = (method: string, hashes = [H1]): SiteWatch => ({
  id: "1".repeat(32),
  method,
  hashes,
  network: "mainnet",
  address: "oct1",
});

function fakeChain(
  answers: Record<string, (TransactionDetail | null)[]>,
  opts: { receipt?: () => Promise<unknown>; scope?: () => boolean } = {},
) {
  let t = 0;
  const sleeps: number[] = [];
  const reads: string[] = [];
  const deps: WatchDeps = {
    read: async (hash) => {
      reads.push(hash);
      const list = answers[hash] ?? [];
      return list.length > 1 ? list.shift()! : (list[0] ?? null);
    },
    receipt:
      opts.receipt ??
      (async () => ({
        contract: "oct9",
        method: "deposit",
        success: true,
        effort: 3,
        events: [{ event: "Minted", values: ["5"] }],
        error: null,
      })),
    viewPubkey: async () => "dmlldw==",
    scopeHolds: opts.scope ?? (() => true),
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
    now: () => t,
  };
  return { deps, sleeps, reads };
}

describe("approving a site review", () => {
  it("answers approved only after Rust took the request as running", async () => {
    const report = vi.fn(async () => undefined);
    expect(await startSigning("x", report)).toBe(true);
    expect(report).toHaveBeenCalledWith("x", { status: "signing" });
    const ended = vi.fn(async () => {
      throw new Error("This request has ended");
    });
    expect(await startSigning("x", ended)).toBe(false);
  });

  it("answers once, and a request that ended meanwhile is answered not approved", async () => {
    const resolve = vi.fn();
    const holder = { resolve };
    const start = vi.fn(async () => false);
    const first = approveOnce(holder, "id", start);
    expect(holder.resolve).toBeNull();
    expect(approveOnce(holder, "id", start)).toBeNull();
    await first;
    expect(start).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith({ approved: false });
    expect(approveOnce(undefined, "id", start)).toBeNull();
  });

  it("an approved review runs once Rust agrees", async () => {
    const resolve = vi.fn();
    await approveOnce({ resolve }, "id", async () => true);
    expect(resolve).toHaveBeenCalledWith({ approved: true });
  });
});

describe("watching what a site request submitted", () => {
  it("reads every 2.5 s for a minute, then every 10 s", () => {
    expect(nextPollMs(0)).toBe(2_500);
    expect(nextPollMs(59_999)).toBe(2_500);
    expect(nextPollMs(60_000)).toBe(10_000);
  });

  it("a contract call is confirmed with its receipt", async () => {
    const c = fakeChain({
      [H1]: [detail("pending"), detail("pending"), detail("confirmed", { epoch: 77 })],
    });
    const v = await watchSiteTx(watch("call_contract"), c.deps);
    expect(v).toEqual({
      status: "confirmed",
      epoch: 77,
      receipt: {
        contract: "oct9",
        method: "deposit",
        success: true,
        effort: 3,
        events: [{ event: "Minted", values: ["5"] }],
        error: null,
      },
    });
    expect(c.sleeps).toEqual([2_500, 2_500, 2_500]);
  });

  it("a send is confirmed without a receipt", async () => {
    const c = fakeChain({ [H1]: [detail("confirmed", { epoch: 3 })] });
    expect(await watchSiteTx(watch("send_transaction"), c.deps)).toEqual({
      status: "confirmed",
      epoch: 3,
      receiptUnavailable: "not_contract",
    });
  });

  it("a receipt the endpoint refuses is reported as refused, never as a failure", async () => {
    const c = fakeChain(
      { [H1]: [detail("confirmed")] },
      { receipt: async () => Promise.reject(new Error("single scanner read required")) },
    );
    expect(await watchSiteTx(watch("callContract"), c.deps)).toEqual({
      status: "confirmed",
      receiptUnavailable: "refused",
    });
    const odd = fakeChain({ [H1]: [detail("confirmed")] }, { receipt: async () => "nope" });
    expect(await watchSiteTx(watch("deploy_contract"), odd.deps)).toMatchObject({
      status: "confirmed",
      receiptUnavailable: "error",
    });
  });

  it("a rejection or a drop on chain fails at execution with the node's reason", async () => {
    const c = fakeChain({ [H1]: [detail("rejected", { reject_reason: "insufficient balance" })] });
    expect(await watchSiteTx(watch("send_transaction"), c.deps)).toEqual({
      status: "failed",
      code: "EXECUTION_FAILED",
      message: "Rejected on chain (insufficient balance)",
    });
    const d = fakeChain({ [H1]: [detail("dropped")] });
    expect(await watchSiteTx(watch("send_transaction"), d.deps)).toMatchObject({
      status: "failed",
      message: "Dropped by the chain",
    });
  });

  it("a sequence is confirmed only once every transaction is", async () => {
    const c = fakeChain({
      [H1]: [detail("confirmed", { epoch: 5 })],
      [H2]: [detail("pending"), detail("confirmed", { epoch: 6 })],
    });
    const v = await watchSiteTx(watch("send_contract_transaction_sequence", [H1, H2]), c.deps);
    expect(v).toEqual({ status: "confirmed", epoch: 6, receiptUnavailable: "not_contract" });
    expect(c.sleeps.length).toBe(2);
  });

  it("stops when the site leaves the network or wallet that signed", async () => {
    let holds = true;
    const c = fakeChain({ [H1]: [detail("pending")] }, { scope: () => holds });
    const v = watchSiteTx(watch("send_transaction"), {
      ...c.deps,
      sleep: async (ms) => {
        await c.deps.sleep(ms);
        if (c.sleeps.length === 3) holds = false;
      },
    });
    expect(await v).toEqual({ status: "unwatched" });
    expect(c.reads.length).toBe(2);
  });

  it("gives up after 10 minutes and leaves the rest to a read on demand", async () => {
    const c = fakeChain({ [H1]: [null] });
    expect(await watchSiteTx(watch("send_transaction"), c.deps)).toEqual({ status: "unwatched" });
    const total = c.sleeps.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThanOrEqual(WATCH_FOR_MS);
    expect(total).toBeLessThan(WATCH_FOR_MS + 10_000);
  });

  it("one read answers a request asked about later", async () => {
    const c = fakeChain({ [H1]: [detail("pending")] });
    expect(await checkOnce(watch("send_transaction"), c.deps)).toBeNull();
    expect(await checkOnce(watch("send_transaction", []), c.deps)).toBeNull();
    const failing = { ...c.deps, read: async () => Promise.reject(new Error("429")) };
    expect(await checkOnce(watch("send_transaction"), failing)).toBeNull();
  });

  it("a confirmed registration carries the view key it registered", async () => {
    const c = fakeChain({ [H1]: [detail("confirmed", { epoch: 9 })] });
    expect(await watchSiteTx(watch("register_private_view_key"), c.deps)).toEqual({
      status: "confirmed",
      epoch: 9,
      receiptUnavailable: "not_contract",
      result: { status: "registered", view_pubkey: "dmlldw==", pvac: true },
    });
  });
});
