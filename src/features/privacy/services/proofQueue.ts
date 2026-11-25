import type { TxScope } from "src/services/network/networkService";
import { logger } from "src/lib/logger";

// One job at a time, in confirm order, keeps nonces and the balance's layers in order. A failed
// job or a key update on hold pauses the jobs of its wallet behind it.

export type ProofKind =
  | "encrypt"
  | "decrypt"
  | "claim"
  | "send"
  | "bulk"
  | "refresh"
  | "migrate"
  | "setup";

export type DoneKind = ProofKind | "keyUpdate";

type JobStatus = "queued" | "running" | "failed" | "done";

interface JobResult {
  txHash?: string;
}

export interface JobSpec {
  kind: ProofKind;
  scope: TxScope;
  amount: number;
  to?: string;
  ref?: string | number;
  steps: string[];
  run: (step: (n: number) => void) => Promise<JobResult>;
  onFail?: (err: unknown) => boolean | void;
  onDone?: (result: JobResult) => void;
}

export interface ProofJob extends JobSpec {
  id: string;
  status: JobStatus;
  /** The step running now; steps.length once all are done. -1 before it starts. */
  step: number;
  marks: number[];
  endedAt: number | null;
  error: string | null;
  result: JobResult | null;
}

export interface DoneEntry {
  kind: DoneKind;
  amount: number;
  at: number;
}

interface QueueState {
  jobs: ProofJob[];
  holds: string[];
  done: Record<string, DoneEntry[]>;
}

const DONE_KEY = "0xio_proofs_done_v1";

export const keyOf = (scope: Pick<TxScope, "networkId" | "address">) =>
  `${scope.networkId}:${scope.address}`;

function startOfToday(now = Date.now()): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function loadDone(): Record<string, DoneEntry[]> {
  try {
    const raw = JSON.parse(localStorage.getItem(DONE_KEY) || "{}") as Record<string, DoneEntry[]>;
    const since = startOfToday();
    const out: Record<string, DoneEntry[]> = {};
    for (const [k, list] of Object.entries(raw)) {
      const today = Array.isArray(list) ? list.filter((e) => e && e.at >= since) : [];
      if (today.length) out[k] = today;
    }
    return out;
  } catch {
    return {};
  }
}

function saveDone(done: Record<string, DoneEntry[]>): void {
  try {
    localStorage.setItem(DONE_KEY, JSON.stringify(done));
  } catch {}
}

let state: QueueState = { jobs: [], holds: [], done: loadDone() };
const listeners = new Set<() => void>();
let seq = 0;

function emit(next: Partial<QueueState>): void {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

function patch(id: string, change: Partial<ProofJob>): void {
  emit({ jobs: state.jobs.map((j) => (j.id === id ? { ...j, ...change } : j)) });
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getQueue(): QueueState {
  return state;
}

function getJob(id: string | null): ProofJob | null {
  return id ? (state.jobs.find((j) => j.id === id) ?? null) : null;
}

export function recordDone(
  scope: Pick<TxScope, "networkId" | "address">,
  kind: DoneKind,
  amount: number,
): void {
  const key = keyOf(scope);
  const since = startOfToday();
  const list = [{ kind, amount, at: Date.now() }, ...(state.done[key] ?? [])].filter(
    (e) => e.at >= since,
  );
  const done = { ...state.done, [key]: list.slice(0, 20) };
  saveDone(done);
  emit({ done });
}

function messageOf(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return typeof err === "string" && err ? err : "The operation failed. Nothing was sent.";
}

function blocked(job: ProofJob, jobs: ProofJob[]): boolean {
  const key = keyOf(job.scope);
  if (state.holds.includes(key)) return true;
  for (const j of jobs) {
    if (j.id === job.id) return false;
    if (j.status === "failed" && keyOf(j.scope) === key) return true;
  }
  return false;
}

export function hasRunnableWork(): boolean {
  return state.jobs.some(
    (j) => j.status === "running" || (j.status === "queued" && !blocked(j, state.jobs)),
  );
}

function pump(): void {
  if (state.jobs.some((j) => j.status === "running")) return;
  const next = state.jobs.find((j) => j.status === "queued" && !blocked(j, state.jobs));
  if (next) void runJob(next.id);
}

async function runJob(id: string): Promise<void> {
  const job = getJob(id);
  if (!job) return;
  const startedAt = Date.now();
  patch(id, { status: "running", step: 0, marks: [startedAt], endedAt: null, error: null });
  const step = (n: number) => {
    const cur = getJob(id);
    if (!cur || cur.status !== "running" || n <= cur.step) return;
    const now = Date.now();
    const marks = [...cur.marks];
    for (let i = marks.length; i <= Math.min(n, cur.steps.length - 1); i++) marks[i] = now;
    patch(id, { step: Math.min(n, cur.steps.length - 1), marks });
  };
  try {
    const result = await job.run(step);
    const cur = getJob(id);
    patch(id, {
      status: "done",
      step: job.steps.length,
      endedAt: Date.now(),
      result,
      marks: cur?.marks ?? [],
    });
    recordDone(job.scope, job.kind, job.amount);
    logger.info("proofs", `${job.kind} done${result.txHash ? ` - ${result.txHash}` : ""}`);
    job.onDone?.(result);
  } catch (err) {
    logger.warn("proofs", `${job.kind} failed: ${messageOf(err)}`);
    const drop = job.onFail?.(err) === true;
    if (drop) emit({ jobs: state.jobs.filter((j) => j.id !== id) });
    else patch(id, { status: "failed", endedAt: Date.now(), error: messageOf(err) });
  } finally {
    pump();
  }
}

export function enqueue(spec: JobSpec): string {
  const id = `job-${++seq}-${Date.now()}`;
  const job: ProofJob = {
    ...spec,
    id,
    status: "queued",
    step: -1,
    marks: [],
    endedAt: null,
    error: null,
    result: null,
  };
  emit({ jobs: [...state.jobs.filter((j) => j.status !== "done"), job] });
  pump();
  return id;
}

export function retry(id: string): void {
  const job = getJob(id);
  if (!job || job.status !== "failed") return;
  patch(id, { status: "queued", step: -1, marks: [], endedAt: null, error: null });
  pump();
}

export function remove(id: string): void {
  const job = getJob(id);
  if (!job || job.status === "running") return;
  emit({ jobs: state.jobs.filter((j) => j.id !== id) });
  pump();
}

export function setHold(scope: Pick<TxScope, "networkId" | "address">, held: boolean): void {
  const key = keyOf(scope);
  const has = state.holds.includes(key);
  if (held === has) return;
  emit({ holds: held ? [...state.holds, key] : state.holds.filter((k) => k !== key) });
  if (!held) pump();
}

export function resetQueue(): void {
  state = { jobs: [], holds: [], done: {} };
  for (const l of listeners) l();
}
