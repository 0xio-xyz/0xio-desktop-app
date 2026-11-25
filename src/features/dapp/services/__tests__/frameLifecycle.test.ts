import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
vi.mock("src/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  createFrameServer,
  maskStatus,
  type FrameRun,
} from "src/features/dapp/services/frameLifecycle";
import type { SdkRequest, SdkResponse } from "src/features/dapp/services/dappRequest";

const SITE = "https://pool.example";
const RID = "a".repeat(32);
const WIRE = "f".repeat(32);
const HASH = "ab".repeat(32);

const req = (method: string, extra: Partial<SdkRequest> = {}): SdkRequest => ({
  id: "q1",
  method,
  params: {},
  timestamp: 0,
  ...extra,
});

const okRes = (data: unknown): SdkResponse => ({ id: "q1", success: true, data, timestamp: 0 });
const rejected: SdkResponse = {
  id: "q1",
  success: false,
  error: { code: "USER_REJECTED", message: "User rejected" },
  timestamp: 0,
};

function server(opts: {
  admit?: unknown;
  finish?: unknown;
  status?: unknown;
  connected?: boolean;
  handle?: (run: FrameRun | null) => Promise<SdkResponse>;
}) {
  const calls: Array<[string, Record<string, unknown> | undefined]> = [];
  const followed: unknown[] = [];
  let open: FrameRun | null = null;
  let release: ((r: SdkResponse) => void) | null = null;
  const s = createFrameServer({
    call: async <T>(cmd: string, args?: Record<string, unknown>) => {
      calls.push([cmd, args]);
      if (cmd === "site_wallet_hello")
        return {
          protocol: 2,
          kind: "desktop",
          version: "0.6.0",
          capabilities: ["request_id"],
        } as T;
      if (cmd === "site_frame_open") {
        const next = Array.isArray(opts.admit) ? opts.admit.shift() : opts.admit;
        return (next ?? { kind: "new", wire: WIRE }) as T;
      }
      if (cmd === "site_frame_status") return (opts.status ?? { result: {} }) as T;
      const update = (args?.update ?? {}) as { kind?: string };
      if (update.kind === "finish") return (opts.finish ?? { status: "submitted" }) as T;
      return {} as T;
    },
    network: () => "mainnet",
    siteView: () => ({ connected: opts.connected ?? true, signer: "oct1" }),
    handle: (_r, _o, run) => {
      open = run;
      if (opts.handle) return opts.handle(run);
      return new Promise<SdkResponse>((resolve) => {
        release = resolve;
      });
    },
    closeReview: (run, why) => {
      if (run.approved) return;
      run.ended = why;
      release?.(rejected);
    },
    follow: (w) => followed.push(w),
  });
  return {
    s,
    calls,
    followed,
    run: () => open,
    finish: (r: SdkResponse) => release?.(r),
    updates: () =>
      calls.filter(([c]) => c === "site_frame_update").map(([, a]) => (a?.update ?? {}) as any),
  };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("a page of the in-app browser speaks protocol 2", () => {
  it("answers wallet_hello with the protocol, the kind and the capabilities", async () => {
    const { s } = server({});
    const r = await s.serve(req("wallet_hello"), SITE, "iframe:1:0");
    expect(r.data).toEqual({
      protocol: 2,
      kind: "desktop",
      version: "0.6.0",
      capabilities: ["request_id"],
    });
  });

  it("keeps protocol 1 requests on today's path, with no record", async () => {
    const t = server({ handle: async () => okRes({ signature: "s" }) });
    const r = await t.s.serve(req("signMessage"), SITE, "iframe:1:0");
    expect(r).toMatchObject({ success: true, data: { signature: "s" } });
    expect(r.rid).toBeUndefined();
    expect(t.calls.map(([c]) => c)).toEqual([]);
  });

  it("opens one record on the frame's network and finishes it with the local hash", async () => {
    const t = server({
      finish: { status: "submitted", watch: { id: WIRE, hashes: [HASH] } },
      handle: async () => okRes({ txHash: HASH }),
    });
    const r = await t.s.serve(req("send_transaction", { rid: RID }), SITE, "iframe:1:0");
    const open = t.calls.find(([c]) => c === "site_frame_open")![1]!;
    expect(open).toMatchObject({ origin: SITE, frame: "iframe:1:0", network: "mainnet", rid: RID });
    expect(t.updates()[0]).toMatchObject({ kind: "finish", reply: { result: { txHash: HASH } } });
    expect(r).toMatchObject({ success: true, rid: RID, status: "submitted" });
    expect(t.followed).toHaveLength(1);
  });

  it("refuses a reused id, a malformed one and one over the running cap", async () => {
    for (const [kind, code] of [
      ["reused", "REQUEST_ID_REUSED"],
      ["invalid", "INVALID_PARAMS"],
      ["busy", "RATE_LIMIT_EXCEEDED"],
    ]) {
      const t = server({ admit: { kind } });
      const r = await t.s.serve(req("send_transaction", { rid: RID }), SITE, "f");
      expect(r.error!.code).toBe(code);
      expect(t.run()).toBeNull();
    }
  });

  it("answers a stored request from the record and never runs it again", async () => {
    const t = server({
      admit: { kind: "stored", reply: { result: { txHash: HASH }, rid: RID, status: "confirmed" } },
    });
    const r = await t.s.serve(req("send_transaction", { rid: RID }), SITE, "f");
    expect(r).toMatchObject({
      success: true,
      data: { txHash: HASH },
      rid: RID,
      status: "confirmed",
    });
    expect(t.run()).toBeNull();
  });

  it("joins a running request: one run, the same answer", async () => {
    let runs = 0;
    let release: (r: SdkResponse) => void = () => {};
    const t = server({
      admit: [
        { kind: "new", wire: WIRE },
        { kind: "join", wire: WIRE },
      ],
      handle: () => {
        runs++;
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    });
    const first = t.s.serve(req("send_transaction", { rid: RID }), SITE, "f1");
    await settle();
    const second = t.s.serve({ ...req("send_transaction", { rid: RID }), id: "q2" }, SITE, "f2");
    await settle();
    release(okRes({ txHash: HASH }));
    const [a, b] = await Promise.all([first, second]);
    expect(runs).toBe(1);
    expect(a.data).toEqual(b.data);
    expect(b.id).toBe("q2");
  });

  it("an unanswered review closes with its page; an approved one runs on", async () => {
    const t = server({ finish: { status: "rejected" } });
    const p = t.s.serve(req("send_transaction", { rid: RID }), SITE, "iframe:1:0");
    await settle();
    t.s.pageGone("iframe:1:0");
    const r = await p;
    expect(r.error).toMatchObject({
      code: "USER_REJECTED",
      message: "The page closed before 0xio Desktop answered.",
      details: { requestId: RID, status: "rejected" },
    });

    const u = server({});
    const q = u.s.serve(req("send_transaction", { rid: RID }), SITE, "iframe:1:1");
    await settle();
    u.run()!.approved = true;
    u.s.pageGone("iframe:1:1");
    u.finish(okRes({ txHash: HASH }));
    expect((await q).success).toBe(true);
  });

  it("a review left open expires as USER_REJECTED with status expired", async () => {
    const t = server({ finish: { status: "expired" } });
    const p = t.s.serve(req("send_transaction", { rid: RID }), SITE, "f");
    await settle();
    t.run()!.ended = "expired";
    t.finish(rejected);
    const r = await p;
    expect(t.updates()[0].reply.error).toEqual({
      code: "USER_REJECTED",
      message: "The review in 0xio Desktop was not answered in 5 minutes.",
      details: { status: "expired" },
    });
    expect(r.error!.details).toEqual({ requestId: RID, status: "expired" });
  });

  it("cancel_request closes the site's own unapproved review and answers its status", async () => {
    const t = server({ status: { result: { requestId: RID, status: "rejected" } } });
    const p = t.s.serve(req("send_transaction", { rid: RID }), SITE, "f");
    await settle();
    const c = await t.s.serve(req("cancel_request", { params: { rid: RID } }), SITE, "f");
    expect(c.data).toMatchObject({ status: "rejected" });
    expect((await p).error!.message).toBe("The request was cancelled.");
  });

  it("request_status hides locked, the network and the signer from a site that is not connected", async () => {
    const full = { requestId: RID, status: "locked", network: "mainnet", address: "oct1", seq: 3 };
    const out = server({ status: { result: full }, connected: false });
    const r = await out.s.serve(req("request_status", { params: { rid: RID } }), SITE, "f");
    expect(r.data).toEqual({ requestId: RID, status: "review_open", seq: 3 });
    const inside = server({ status: { result: full } });
    expect(
      (await inside.s.serve(req("request_status", { params: { rid: RID } }), SITE, "f")).data,
    ).toEqual(full);
  });

  it("masks for a site connected with another wallet: no signer", () => {
    expect(
      maskStatus(
        { status: "signing", address: "oct2", network: "mainnet" },
        { connected: true, signer: "oct1" },
      ),
    ).toEqual({ status: "signing", network: "mainnet" });
  });
});
