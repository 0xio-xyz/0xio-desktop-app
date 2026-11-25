import type { SdkRequest, SdkResponse } from "src/features/dapp/services/dappRequest";
import type { SiteWatch } from "src/features/dapp/services/siteLifecycle";

type Status = string;

export interface FrameRun {
  wire: string;
  rid: string;
  frame: string;
  origin: string;
  approved: boolean;
  ended: "closed" | "expired" | "cancelled" | null;
}

interface SiteView {
  connected: boolean;
  signer: string | null;
}

/** What a site that is not connected may not see: `locked`, the network and the signer. */
export function maskStatus(data: Record<string, unknown>, view: SiteView): Record<string, unknown> {
  const out = { ...data };
  if (!view.connected) {
    if (out.status === "locked") out.status = "review_open";
    delete out.network;
    delete out.address;
  } else if (out.address !== undefined && out.address !== view.signer) {
    delete out.address;
  }
  return out;
}

function withRid(res: SdkResponse, rid: string, status?: Status): SdkResponse {
  const out: SdkResponse = { ...res, rid, ...(status ? { status } : {}) };
  if (res.error) {
    out.error = {
      ...res.error,
      details: { requestId: rid, ...(status ? { status } : {}), ...(res.error.details ?? {}) },
    };
  }
  return out;
}

type Reply = {
  result?: unknown;
  error?: { code: string; message: string; details?: Record<string, unknown> };
  rid?: string;
  status?: Status;
};

function replyOf(res: SdkResponse): Reply {
  if (res.success) return { result: res.data ?? null };
  const e = res.error ?? { code: "UNKNOWN_ERROR", message: "Request failed" };
  return {
    error: { code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) },
  };
}

function responseOf(id: string, reply: Reply): SdkResponse {
  return {
    id,
    success: !reply.error,
    ...(reply.error ? { error: reply.error } : { data: reply.result }),
    ...(reply.rid ? { rid: reply.rid } : {}),
    ...(reply.status ? { status: reply.status } : {}),
    timestamp: Date.now(),
  };
}

const ENDED: Record<NonNullable<FrameRun["ended"]>, { message: string; status?: Status }> = {
  closed: { message: "The page closed before 0xio Desktop answered." },
  cancelled: { message: "The request was cancelled." },
  expired: {
    message: "The review in 0xio Desktop was not answered in 5 minutes.",
    status: "expired",
  },
};

function endedAnswer(res: SdkResponse, run: FrameRun): SdkResponse {
  if (!run.ended || run.approved || res.success) return res;
  const why = ENDED[run.ended];
  return {
    ...res,
    error: {
      code: "USER_REJECTED",
      message: why.message,
      ...(why.status ? { details: { status: why.status } } : {}),
    },
  };
}

const fail = (id: string, code: string, message: string): SdkResponse => ({
  id,
  success: false,
  error: { code, message },
  timestamp: Date.now(),
});

const ok = (id: string, data: unknown): SdkResponse => ({
  id,
  success: true,
  data,
  timestamp: Date.now(),
});

interface FrameServerDeps {
  call<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
  network(): string;
  siteView(origin: string, network: string): SiteView;
  handle(req: SdkRequest, origin: string, run: FrameRun | null): Promise<SdkResponse>;
  closeReview(run: FrameRun, why: NonNullable<FrameRun["ended"]>): void;
  follow(watch: SiteWatch, origin: string): void;
}

type Admit =
  | { kind: "new" | "join"; wire: string }
  | { kind: "stored"; reply: Reply }
  | { kind: "reused" | "busy" | "invalid" | "none" };

export function createFrameServer(d: FrameServerDeps) {
  const inflight = new Map<string, Promise<SdkResponse>>();
  const runs = new Map<string, FrameRun>();
  const key = (origin: string, rid: string) => `${origin} ${rid}`;

  const status = async (origin: string, rid: unknown) => {
    const r = await d.call<{ result?: Record<string, unknown>; error?: { message: string } }>(
      "site_frame_status",
      { origin, rid },
    );
    if (!r.result) return null;
    const network = typeof r.result.network === "string" ? r.result.network : d.network();
    return maskStatus(r.result, d.siteView(origin, network));
  };

  const stage = (run: FrameRun, status: "pending" | "locked" | "review_open") =>
    d
      .call("site_frame_update", { wire: run.wire, update: { kind: "stage", status } })
      .catch(() => {});

  const signing = (run: FrameRun) =>
    d.call("site_frame_update", { wire: run.wire, update: { kind: "signing" } }).catch(() => {});

  const runNew = async (req: SdkRequest, origin: string, run: FrameRun): Promise<SdkResponse> => {
    const address = d.siteView(origin, d.network()).signer;
    const res = endedAnswer(await d.handle(req, origin, run), run);
    const out = await d
      .call<{ status?: Status | null; watch?: SiteWatch | null }>("site_frame_update", {
        wire: run.wire,
        update: { kind: "finish", reply: replyOf(res), committed: run.approved, address },
      })
      .catch(() => ({}) as { status?: Status | null; watch?: SiteWatch | null });
    if (out.watch) d.follow(out.watch, origin);
    return withRid(res, run.rid, out.status ?? undefined);
  };

  const serve = async (req: SdkRequest, origin: string, frame: string): Promise<SdkResponse> => {
    const params = (req.params ?? {}) as Record<string, unknown>;
    if (req.method === "wallet_hello") return ok(req.id, await d.call("site_wallet_hello"));
    if (req.method === "request_status") {
      const s = await status(origin, params.rid);
      return s ? ok(req.id, s) : fail(req.id, "INVALID_PARAMS", "Malformed request id.");
    }
    if (req.method === "cancel_request") {
      const rid = params.rid;
      const run = typeof rid === "string" ? runs.get(key(origin, rid)) : undefined;
      if (run && !run.approved) {
        d.closeReview(run, "cancelled");
        await inflight.get(run.wire)?.catch(() => {});
      }
      const s = await status(origin, rid);
      return s ? ok(req.id, s) : fail(req.id, "INVALID_PARAMS", "Malformed request id.");
    }
    if (req.rid === undefined) return d.handle(req, origin, null);
    const admit = await d.call<Admit>("site_frame_open", {
      origin,
      frame,
      network: d.network(),
      address: d.siteView(origin, d.network()).signer,
      method: req.method,
      params: req.params ?? {},
      rid: req.rid,
    });
    switch (admit.kind) {
      case "none":
        return d.handle(req, origin, null);
      case "invalid":
        return fail(req.id, "INVALID_PARAMS", "Malformed request id.");
      case "reused":
        return withRid(
          fail(req.id, "REQUEST_ID_REUSED", "This request id belongs to another request."),
          req.rid,
        );
      case "busy":
        return withRid(
          fail(req.id, "RATE_LIMIT_EXCEEDED", "Too many requests from this site are running."),
          req.rid,
        );
      case "stored":
        return responseOf(req.id, admit.reply);
      case "join": {
        const running = inflight.get(admit.wire);
        if (!running)
          return withRid(fail(req.id, "STATUS_UNKNOWN", "Ask for its status."), req.rid);
        return { ...(await running), id: req.id };
      }
      case "new": {
        const run: FrameRun = {
          wire: admit.wire,
          rid: req.rid,
          frame,
          origin,
          approved: false,
          ended: null,
        };
        runs.set(key(origin, run.rid), run);
        const p = runNew(req, origin, run);
        inflight.set(run.wire, p);
        try {
          return { ...(await p), id: req.id };
        } finally {
          inflight.delete(run.wire);
          runs.delete(key(origin, run.rid));
        }
      }
    }
  };

  const pageGone = (frame: string) => {
    for (const run of runs.values()) {
      if (run.frame === frame && !run.approved) d.closeReview(run, "closed");
    }
  };

  return { serve, stage, signing, pageGone };
}
