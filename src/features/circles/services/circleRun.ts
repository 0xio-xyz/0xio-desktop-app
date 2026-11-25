import { useSyncExternalStore } from "react";
import i18n from "src/i18n/core";
import { buildHfheTx, broadcastSignedTx } from "src/services/network/transactionBuilder";
import type { TxScope } from "src/services/network/networkService";
import { TxSubmitError, UnclearSubmitError } from "src/services/network/submitErrors";
import { toast } from "src/services/notices/activity";
import { logger } from "src/lib/logger";
import { confirmCircleTx, deployCircle } from "src/features/circles/services/circleDeploy";
import {
  checkCircleUpload,
  circleContentType,
  prepareCircleUpload,
} from "src/features/circles/services/circleUpload";
import {
  addCircle,
  INDEX_PATH,
  pageTitle,
  putFile,
  readLibrary,
  removeCircle,
  settleFile,
  updateCircle,
  type CircleRecord,
} from "src/features/circles/services/circleLibrary";

export const CIRCLE_BATCH_MAX = 32;
export const CIRCLE_STAGED_MAX = 200;

export type StagedFile = { key: string; file: File; path: string };

type Refusal =
  | "over32"
  | "over2"
  | "empty"
  | "path"
  | "reserved"
  | "long"
  | "details"
  | "duplicate"
  | "full";

export type StagedRow = {
  key: string;
  file: File;
  rawPath: string;
  path: string | null;
  size: number;
  type: string;
  replace: boolean;
  refusal: Refusal | null;
};

type RunState = "waiting" | "sending" | "confirmed" | "rejected" | "refused" | "pending" | "unsent";

export type RunFile = {
  key: string;
  path: string;
  size: number;
  type: string;
  replace: boolean;
  ou: string;
  len: number;
  state: RunState;
  reason?: string;
  hash?: string;
  since?: number;
};

export type BatchRun = {
  scope: TxScope;
  circleId: string;
  files: RunFile[];
  status: "running" | "stopped";
  shown: boolean;
};

export type DeployRun = {
  scope: TxScope;
  sealed: boolean;
  marks: number[];
  status: "running" | "rejected" | "failed";
  reason?: string;
  shown: boolean;
};

interface RunStore {
  staged: Record<string, StagedFile[]>;
  batch: BatchRun | null;
  deploy: DeployRun | null;
  checking: string[];
}

let state: RunStore = { staged: {}, batch: null, deploy: null, checking: [] };
const listeners = new Set<() => void>();
let seq = 0;

function emit(next: Partial<RunStore>): void {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const getCircleRun = () => state;
export const useCircleRun = () => useSyncExternalStore(subscribe, getCircleRun);

type Scope = { networkId: string; address: string };
export const circleKey = (scope: Scope, circleId: string) =>
  `${scope.networkId}:${scope.address}:${circleId}`;

const say = (key: string, values?: Record<string, unknown>) =>
  i18n.isInitialized ? i18n.t(key, values) : key;
const reasonOf = (e: unknown) => (e instanceof Error && e.message ? e.message : String(e));

const REFUSALS: [string, Refusal][] = [
  ["File exceeds the 32 MiB circle limit", "over32"],
  ["Public files over 2 MiB cannot be uploaded yet", "over2"],
  ["File is empty", "empty"],
  ["Paths under /.octra/ are reserved", "reserved"],
  ["Path exceeds max length", "long"],
  ["Upload details are too long", "details"],
];

const refusalOf = (e: unknown): Refusal =>
  REFUSALS.find(([message]) => reasonOf(e) === message)?.[1] ?? "path";

export function stageFiles(
  scope: Scope,
  circleId: string,
  entries: { file: File; path: string }[],
): void {
  const key = circleKey(scope, circleId);
  const have = state.staged[key] ?? [];
  const added = entries.map((e) => ({ key: `f${++seq}`, file: e.file, path: e.path }));
  emit({ staged: { ...state.staged, [key]: [...have, ...added].slice(0, CIRCLE_STAGED_MAX) } });
}

function setStaged(key: string, fn: (list: StagedFile[]) => StagedFile[]): void {
  const next = fn(state.staged[key] ?? []);
  const staged = { ...state.staged };
  if (next.length) staged[key] = next;
  else delete staged[key];
  emit({ staged });
}

export function setStagedPath(scope: Scope, circleId: string, key: string, path: string): void {
  setStaged(circleKey(scope, circleId), (list) =>
    list.map((f) => (f.key === key ? { ...f, path } : f)),
  );
}

export function unstage(scope: Scope, circleId: string, key: string): void {
  setStaged(circleKey(scope, circleId), (list) => list.filter((f) => f.key !== key));
}

export function stagedRows(
  staged: StagedFile[],
  circle: Pick<CircleRecord, "files">,
  sealed: boolean,
): StagedRow[] {
  const published = new Set(circle.files.map((f) => f.path));
  const taken = new Set<string>();
  let valid = 0;
  return staged.map((s) => {
    const type = circleContentType(s.file.name, s.file.type);
    const row: StagedRow = {
      key: s.key,
      file: s.file,
      rawPath: s.path,
      path: null,
      size: s.file.size,
      type,
      replace: false,
      refusal: null,
    };
    try {
      const path = checkCircleUpload({
        path: s.path,
        size: s.file.size,
        contentType: type,
        sealed,
      });
      if (taken.has(path)) return { ...row, refusal: "duplicate" };
      taken.add(path);
      if (valid >= CIRCLE_BATCH_MAX) return { ...row, refusal: "full" };
      valid++;
      return { ...row, path, replace: published.has(path) };
    } catch (e) {
      return { ...row, refusal: refusalOf(e) };
    }
  });
}

function patchFile(key: string, patch: Partial<RunFile>): void {
  if (!state.batch) return;
  emit({
    batch: {
      ...state.batch,
      files: state.batch.files.map((f) => (f.key === key ? { ...f, ...patch } : f)),
    },
  });
}

export function showBatch(shown: boolean): void {
  if (state.batch && state.batch.shown !== shown) emit({ batch: { ...state.batch, shown } });
}

export function closeBatch(): void {
  if (state.batch?.status === "stopped") emit({ batch: null });
}

export function leavePage(): void {
  if (state.batch?.status === "stopped") emit({ batch: null });
  else showBatch(false);
  if (state.deploy && state.deploy.status !== "running") emit({ deploy: null });
  else showDeploy(false);
}

interface BatchInput {
  scope: TxScope;
  walletId: string;
  circleId: string;
  sealed: boolean;
  passphrase: string;
  files: { row: StagedRow; ou: string; len: number }[];
}

export async function runBatch(input: BatchInput): Promise<void> {
  if (state.batch?.status === "running" || !input.files.length) return;
  const { scope, circleId } = input;
  const key = circleKey(scope, circleId);
  emit({
    batch: {
      scope,
      circleId,
      status: "running",
      shown: true,
      files: input.files.map(({ row, ou, len }) => ({
        key: row.key,
        path: row.path!,
        size: row.size,
        type: row.type,
        replace: row.replace,
        ou,
        len,
        state: "waiting",
      })),
    },
  });

  const gone = new Set<string>();
  let stop: { state: RunState; reason: string } | null = null;
  let lastHash = "";
  let done = 0;

  for (const { row, ou, len } of input.files) {
    const path = row.path!;
    if (stop) {
      patchFile(row.key, { state: "unsent" });
      continue;
    }
    patchFile(row.key, { state: "sending", since: Date.now() });
    let hash = "";
    let title = "";
    try {
      const bytes = new Uint8Array(await row.file.arrayBuffer());
      if (bytes.length !== row.size) throw new Error("A file changed since the review");
      const upload = await prepareCircleUpload({
        circleId,
        path,
        bytes,
        contentType: row.type,
        sealed: input.sealed,
        passphrase: input.passphrase,
      });
      if (upload.path !== path || upload.encData.length !== len)
        throw new Error("A file changed since the review");
      if (path === INDEX_PATH) title = pageTitle(bytes, row.type);
      const tx = await buildHfheTx({
        from: scope.address,
        to: circleId,
        amount: "0",
        opType: upload.opType,
        encryptedData: upload.encData,
        walletId: input.walletId,
        ou,
        message: upload.message,
        scope,
      });
      try {
        hash = await broadcastSignedTx(tx, scope);
      } catch (e) {
        if (e instanceof UnclearSubmitError) hash = e.hash;
        else if (!(e instanceof TxSubmitError) && /timed out/i.test(reasonOf(e))) {
          gone.add(row.key);
          stop = { state: "pending", reason: "" };
          patchFile(row.key, { state: "pending" });
          logger.warn("circles", `Upload ${path} -> ${circleId} unclear: ${reasonOf(e)}`);
          continue;
        } else throw e;
      }
    } catch (e) {
      stop = { state: "refused", reason: reasonOf(e) };
      patchFile(row.key, { state: "refused", reason: stop.reason });
      logger.warn("circles", `Upload ${path} -> ${circleId} not sent: ${stop.reason}`);
      continue;
    }

    gone.add(row.key);
    lastHash = hash;
    patchFile(row.key, { hash });
    putFile(scope, circleId, {
      path,
      size: row.size,
      type: row.type,
      at: Date.now(),
      tx: hash,
      status: "pending",
      ...(title ? { title } : {}),
    });
    const outcome = await confirmCircleTx(hash, scope.networkId);
    logger.info("circles", `Upload ${path} -> ${circleId} tx=${hash} status=${outcome.status}`);
    if (outcome.status === "confirmed") {
      settleFile(scope, circleId, path, hash, "confirmed");
      patchFile(row.key, { state: "confirmed" });
      done++;
    } else if (outcome.status === "rejected") {
      settleFile(scope, circleId, path, hash, "rejected");
      gone.delete(row.key);
      stop = { state: "rejected", reason: outcome.reason || "rejected" };
      patchFile(row.key, { state: "rejected", reason: stop.reason });
    } else {
      stop = { state: "pending", reason: "" };
      patchFile(row.key, { state: "pending" });
    }
  }

  setStaged(key, (list) => list.filter((f) => !gone.has(f.key)));
  const view = lastHash ? { hash: lastHash, network: scope.networkId } : undefined;
  if (!stop) {
    emit({ batch: null });
    toast({ title: "activity.circleUploaded", values: { count: done }, view, scope });
    return;
  }
  const shown = !!state.batch?.shown;
  if (state.batch) emit({ batch: { ...state.batch, status: "stopped" } });
  if (shown) return;
  if (stop.state === "pending")
    toast({ title: "activity.circleUploadPending", tone: "info", view, scope });
  else
    toast({
      title: "activity.circleUploadStopped",
      text: say(
        stop.state === "rejected"
          ? "activity.circleUploadRejected"
          : "activity.circleUploadStopped",
        { reason: stop.reason },
      ),
      tone: "error",
    });
}

export function showDeploy(shown: boolean): void {
  if (state.deploy && state.deploy.shown !== shown) emit({ deploy: { ...state.deploy, shown } });
}

export function closeDeploy(): void {
  if (state.deploy && state.deploy.status !== "running") emit({ deploy: null });
}

function endDeploy(status: "rejected" | "failed", reason: string): void {
  const shown = !!state.deploy?.shown;
  if (state.deploy) emit({ deploy: { ...state.deploy, status, reason } });
  if (shown) return;
  emit({ deploy: null });
  toast({
    title: "activity.circleDeployRejected",
    text: say(
      status === "rejected" ? "activity.circleDeployRejected" : "activity.circleDeployFailed",
      { reason },
    ),
    tone: "error",
  });
}

export async function runDeploy(input: {
  scope: TxScope;
  walletId: string;
  sealed: boolean;
  ou: string;
}): Promise<string | null> {
  if (state.deploy?.status === "running") return null;
  const { scope, sealed } = input;
  emit({ deploy: { scope, sealed, marks: [Date.now()], status: "running", shown: true } });
  let circleId: string;
  let hash: string;
  try {
    ({ circleId, hash } = await deployCircle(input));
  } catch (e) {
    if (!(e instanceof UnclearSubmitError) || !e.contractAddress) {
      logger.warn("circles", `Deploy not sent: ${reasonOf(e)}`);
      endDeploy("failed", reasonOf(e));
      return null;
    }
    circleId = e.contractAddress;
    hash = e.hash;
  }
  addCircle(scope, { id: circleId, sealed, deployTx: hash, status: "pending" });
  if (state.deploy)
    emit({ deploy: { ...state.deploy, marks: [state.deploy.marks[0], Date.now()] } });
  const outcome = await confirmCircleTx(hash, scope.networkId);
  logger.info("circles", `Deploy ${circleId} tx=${hash} status=${outcome.status}`);
  if (outcome.status === "rejected") {
    removeCircle(scope, circleId);
    endDeploy("rejected", outcome.reason || "rejected");
    return null;
  }
  const view = { hash, network: scope.networkId };
  emit({ deploy: null });
  if (outcome.status === "confirmed") {
    updateCircle(scope, circleId, { status: "confirmed" });
    toast({ title: "activity.circleDeployed", view, scope });
  } else toast({ title: "activity.circleDeployPending", tone: "info", view, scope });
  return circleId;
}

export async function checkAgain(scope: Scope, circleId: string): Promise<void> {
  const key = circleKey(scope, circleId);
  if (state.checking.includes(key)) return;
  emit({ checking: [...state.checking, key] });
  const ask = (hash: string) => confirmCircleTx(hash, scope.networkId, 4000, 1000);
  try {
    const circle = readLibrary(scope).find((c) => c.id === circleId);
    if (!circle) return;
    if (circle.status === "pending" && circle.deployTx) {
      const view = { hash: circle.deployTx, network: scope.networkId };
      const outcome = await ask(circle.deployTx);
      if (outcome.status === "confirmed") {
        updateCircle(scope, circleId, { status: "confirmed" });
        toast({ title: "activity.circleDeployed", view, scope });
      } else if (outcome.status === "rejected") {
        removeCircle(scope, circleId);
        toast({
          title: "activity.circleDeployRejected",
          text: say("activity.circleDeployRejected", { reason: outcome.reason || "rejected" }),
          tone: "error",
        });
        return;
      }
    }
    let confirmed = 0;
    let last = "";
    for (const file of circle.files.filter((f) => f.status === "pending" && f.tx)) {
      const outcome = await ask(file.tx);
      if (outcome.status === "pending") continue;
      settleFile(scope, circleId, file.path, file.tx, outcome.status);
      if (outcome.status === "confirmed") {
        confirmed++;
        last = file.tx;
      } else
        toast({
          title: "activity.circleUploadRejected",
          text: say("activity.circleUploadRejected", { reason: outcome.reason || "rejected" }),
          tone: "error",
        });
    }
    if (confirmed)
      toast({
        title: "activity.circleUploaded",
        values: { count: confirmed },
        view: { hash: last, network: scope.networkId },
        scope,
      });
  } finally {
    emit({ checking: state.checking.filter((k) => k !== key) });
  }
}

export function resetCircleRun(): void {
  state = { staged: {}, batch: null, deploy: null, checking: [] };
  for (const l of listeners) l();
}
