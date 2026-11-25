/** Like the SDK, a page keeps its origin's site token and shows it in `site_hello`. */
import net from "node:net";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

interface WireRequest {
  id: string;
  method: string;
  params: unknown;
  rid?: string;
  network?: string;
}

export class Control {
  private sock: net.Socket;
  private buf = "";
  private seq = 0;
  private waiting = new Map<number, (v: Json) => void>();

  private constructor(sock: net.Socket) {
    this.sock = sock;
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => {
      this.buf += chunk;
      let at: number;
      while ((at = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, at);
        this.buf = this.buf.slice(at + 1);
        const reply = JSON.parse(line);
        this.waiting.get(reply.seq)?.(reply);
        this.waiting.delete(reply.seq);
      }
    });
  }

  static open(port: number): Promise<Control> {
    return new Promise((resolve, reject) => {
      const sock = net.connect(port, "127.0.0.1", () => resolve(new Control(sock)));
      sock.once("error", reject);
    });
  }

  call(cmd: Json): Promise<Json> {
    const seq = ++this.seq;
    return new Promise((resolve) => {
      this.waiting.set(seq, resolve);
      this.sock.write(`${JSON.stringify({ ...cmd, seq })}\n`);
    });
  }

  close(): void {
    this.sock.destroy();
  }
}

const hex32 = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");

const settle = () => new Promise((r) => setTimeout(r, 15));

class DesktopPage {
  private ws: WebSocket;
  private seq = 0;
  private replies = new Map<number, { resolve: (f: Json) => void; reject: (e: Error) => void }>();
  private listeners = new Set<(e: { type: string; data: unknown }) => void>();
  private waitingRids = new Map<string, string>();
  private network = "mainnet";

  constructor(
    port: number,
    readonly origin: string,
    private readonly tokens: Map<string, string>,
  ) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/`, {
      headers: { Origin: origin },
    } as unknown as string[]);
    this.ws.onmessage = (ev) => this.onMessage(String(ev.data));
    this.ws.onclose = () => {
      for (const p of this.replies.values()) p.reject(new Error("page closed"));
      this.replies.clear();
    };
  }

  async init(): Promise<this> {
    await new Promise<void>((resolve, reject) => {
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error("could not open the page socket"));
    });
    const hello = await this.hello();
    if (typeof hello.network === "string") this.network = hello.network;
    return this;
  }

  private hello(): Promise<Json> {
    const token = this.tokens.get(this.origin);
    return this.frame("site_hello", token ? { site_token: token } : {}).then((h) => {
      if (h.token_status === "invalid") this.tokens.delete(this.origin);
      return h;
    });
  }

  private onMessage(text: string): void {
    const msg = JSON.parse(text);
    if (typeof msg._id === "number") {
      this.replies.get(msg._id)?.resolve(msg);
      this.replies.delete(msg._id);
      return;
    }
    if (msg.event === "site_event" && msg.kind === "request") {
      for (const fn of this.listeners) fn({ type: "requestUpdate", data: msg.data });
    }
  }

  private frame(method: string, args: Json): Promise<Json> {
    const _id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.replies.set(_id, { resolve, reject });
      this.ws.send(JSON.stringify({ v: 1, _id, method, ...args }));
    });
  }

  private answer(req: WireRequest, f: Json, data: unknown = f.result): Json {
    const error = f.error ?? null;
    return {
      id: req.id,
      success: !error,
      ...(error ? { error } : { data }),
      ...(f.rid ? { rid: f.rid } : {}),
      ...(f.status ? { status: f.status } : {}),
    };
  }

  async send(req: WireRequest): Promise<Json> {
    const params = (req.params ?? {}) as Json;
    switch (req.method) {
      case "wallet_hello": {
        const h = await this.hello();
        const data = Object.fromEntries(
          ["protocol", "kind", "version", "capabilities"]
            .filter((k) => k in h)
            .map((k) => [k, h[k]]),
        );
        return this.answer(req, h, data);
      }
      case "ping": {
        const f = await this.frame("ping", {});
        return this.answer(req, f, { pong: f.pong });
      }
      case "request_status":
        return this.answer(req, await this.frame("site_status", { rid: params.rid }));
      case "cancel_request": {
        const id = this.waitingRids.get(params.rid);
        const f = await this.frame("site_cancel", { rid: params.rid, ...(id ? { id } : {}) });
        return this.answer(req, f, f.result);
      }
      default: {
        const id = hex32();
        if (req.rid) this.waitingRids.set(req.rid, id);
        const f = await this.frame("site_request", {
          id,
          network: req.network ?? this.network,
          ...(req.rid !== undefined ? { rid: req.rid } : {}),
          request: { method: req.method, params: req.params ?? {} },
        });
        if (req.rid) this.waitingRids.delete(req.rid);
        if (req.method === "connect" && f.result && typeof f.result === "object") {
          const { siteToken, ...rest } = f.result;
          if (typeof siteToken === "string") this.tokens.set(this.origin, siteToken);
          f.result = rest;
        }
        return this.answer(req, f);
      }
    }
  }

  onEvent(listener: (e: { type: string; data: unknown }) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close(): Promise<void> {
    this.ws.close();
    await settle();
  }
}

export const DESKTOP_FEATURES = {
  clock: true,
  chain: true,
  lock: true,
  frames: false,
  account: true,
  openRequestCap: 3,
};

export async function createDesktopAdapter(control: Control): Promise<Json> {
  const { wallet, port } = await control.call({ cmd: "create" });
  const tokens = new Map<string, string>();
  const pages: DesktopPage[] = [];
  const act = async (cmd: Json) => {
    const r = await control.call({ ...cmd, wallet });
    if (r.error) throw new Error(`desktop: ${r.error}`);
    await settle();
    return r;
  };
  return {
    name: "0xio Desktop (direct)",
    features: DESKTOP_FEATURES,
    async openPage(origin: string) {
      const page = await new DesktopPage(port, origin, tokens).init();
      pages.push(page);
      return page;
    },
    approve: (rid?: string) => act({ cmd: "approve", rid }).then(() => undefined),
    reject: (rid?: string) => act({ cmd: "reject", rid }).then(() => undefined),
    reviewOnScreen: async () => (await control.call({ cmd: "review", wallet })).rid ?? null,
    setAccount: (account: {
      registered: boolean;
      balanceRaw: string;
      foreignKey?: boolean;
      pendingRegistration?: boolean;
    }) => act({ cmd: "account", ...account }).then(() => undefined),
    lock: () => act({ cmd: "lock" }).then(() => undefined),
    unlock: () => act({ cmd: "unlock" }).then(() => undefined),
    confirmOnChain: (hash: string) => act({ cmd: "confirm", hash }).then(() => undefined),
    failOnChain: (hash: string, reason: string) =>
      act({ cmd: "fail", hash, reason }).then(() => undefined),
    dropOnChain: (hash: string) => act({ cmd: "drop", hash }).then(() => undefined),
    advance: (ms: number) => act({ cmd: "advance", ms }).then(() => undefined),
    stats: async () => {
      const s = await control.call({ cmd: "stats", wallet });
      return { signatures: s.signatures, reviewsOpened: s.reviewsOpened };
    },
    async dispose() {
      for (const p of pages) await p.close();
      await control.call({ cmd: "dispose", wallet });
    },
  };
}
