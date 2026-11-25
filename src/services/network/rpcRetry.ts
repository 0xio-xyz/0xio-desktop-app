export type RpcLink = "unopened" | "untrusted" | "broken" | "expired" | "answered";
export type RpcFault = "none" | "capacity" | "network" | "busy" | "deadline" | "state";
export type RpcLane = "user" | "poll";

export interface RpcStep {
  fault: RpcFault;
  unsent: boolean;
  status: string;
}

export const RETRY_WINDOW_S = 25;
export const RETRY_AFTER_CAP_S = 5;
export const PAUSE_SPREAD = 0.2;
export const PAUSES_S = [0.25, 0.5, 1, 2, 4];
export const STATE_CHANGED_CODE = -32012;
export const SLOTS = 4;
export const POLL_SLOTS = 2;
export const GATE_MAX_REQUEST_S = 60;

const WRITES = new Set([
  "octra_submit",
  "octra_submitBatch",
  "staging_remove",
  "octra_registerPublicKey",
  "octra_registerPvacPubkey",
  "octra_privateTransfer",
  "octra_circleComputeSubmit",
  "contract_verify",
  "octra_programVerify",
  "contract_saveAbi",
  "octra_programSaveAbi",
]);

export function isWrite(method: string): boolean {
  return WRITES.has(method);
}

function replyError(data: unknown): { id: unknown; error: Record<string, unknown> } | null {
  if (!data || typeof data !== "object" || Array.isArray(data) || !("id" in data)) return null;
  const { id, error } = data as { id: unknown; error?: unknown };
  if (!error || typeof error !== "object" || Array.isArray(error)) return null;
  return { id, error: error as Record<string, unknown> };
}

function capacity(data: unknown): boolean {
  const reply = replyError(data);
  if (!reply || reply.id !== null) return false;
  const message = reply.error.message;
  return typeof message === "string" && message.toLowerCase().includes("capacity");
}

function stateChanged(data: unknown): boolean {
  const reply = replyError(data);
  if (!reply || reply.id === null || reply.id === undefined) return false;
  return Number.isInteger(reply.error.code) && reply.error.code === STATE_CHANGED_CODE;
}

const gateway = (status: number) =>
  status === 408 ||
  status === 425 ||
  status === 502 ||
  status === 504 ||
  (status >= 520 && status <= 524);

/** One HTTP exchange; `data` is the parsed body, undefined when it was not JSON. */
export function classify(link: RpcLink, status = 0, data?: unknown): RpcStep {
  switch (link) {
    case "untrusted":
      return { fault: "none", unsent: true, status: "" };
    case "unopened":
      return { fault: "network", unsent: true, status: "connect" };
    case "broken":
      return { fault: "network", unsent: false, status: "reset" };
    case "expired":
      return { fault: "network", unsent: false, status: "timeout" };
  }
  const full = capacity(data);
  if (status === 429 || status === 503)
    return { fault: "capacity", unsent: full && status === 429, status: String(status) };
  if (gateway(status)) return { fault: "network", unsent: false, status: String(status) };
  if (full) return { fault: "capacity", unsent: false, status: "capacity" };
  if (status === 200 && stateChanged(data))
    return { fault: "state", unsent: false, status: "state_changed" };
  return { fault: "none", unsent: false, status: "" };
}

export function shouldRepeat(step: Pick<RpcStep, "fault" | "unsent">, write: boolean): boolean {
  return step.fault !== "none" && (!write || step.unsent);
}

/** Seconds to wait before the next attempt; `draw` is a random number in [0, 1]. */
export function pauseSeconds(attempt: number, retryAfter: number | null, draw: number): number {
  const step = Math.min(Math.max(attempt, 1), PAUSES_S.length) - 1;
  const base = retryAfter != null ? Math.min(retryAfter, RETRY_AFTER_CAP_S) : PAUSES_S[step];
  return base * (1 + PAUSE_SPREAD * Math.min(Math.max(draw, 0), 1));
}

/** Whole seconds 1 to 86400 only; an HTTP date is ignored. */
export function retryAfterHeader(text: string | null | undefined): number | null {
  if (!text || !/^[0-9]+$/.test(text)) return null;
  const seconds = Number(text);
  return seconds >= 1 && seconds <= 86400 ? seconds : null;
}

export function retryWindowSeconds(requestSeconds: number): number {
  return Math.min(RETRY_WINDOW_S, requestSeconds);
}

export function gateRoom(
  busy: number,
  polls: number,
  usersWaiting: number,
  lane: RpcLane,
): boolean {
  return busy < SLOTS && (lane === "user" || (polls < POLL_SLOTS && usersWaiting === 0));
}

export function faultMessage(fault: RpcFault): string {
  switch (fault) {
    case "capacity":
      return "rpc capacity reached";
    case "busy":
      return "wallet rpc slots busy";
    case "deadline":
      return "request deadline reached";
    case "state":
      return "committed state changed during read; retry";
    default:
      return "network unreachable";
  }
}

/** At most SLOTS calls in flight; polls hold at most POLL_SLOTS and only while no user call waits. */
export class RpcGate {
  private busy = 0;
  private polls = 0;
  private users = 0;
  private waiters = new Set<() => void>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  private wake(): void {
    for (const w of [...this.waiters]) w();
  }

  async enter(lane: RpcLane, deadline: number): Promise<boolean> {
    const user = lane === "user";
    if (user) this.users++;
    try {
      while (!gateRoom(this.busy, this.polls, this.users, lane)) {
        const left = deadline - this.now();
        if (left <= 0) return false;
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            this.waiters.delete(done);
            resolve();
          };
          const timer = setTimeout(done, left);
          this.waiters.add(done);
        });
      }
      this.busy++;
      if (!user) this.polls++;
      return true;
    } finally {
      if (user) this.users--;
      this.wake();
    }
  }

  leave(lane: RpcLane): void {
    this.busy--;
    if (lane === "poll") this.polls--;
    this.wake();
  }
}
