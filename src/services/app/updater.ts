import { invoke } from "@tauri-apps/api/core";
import { check, type Update } from "@tauri-apps/plugin-updater";

export type UpdateState =
  | { phase: "idle" }
  | { phase: "available"; version: string; notes: string }
  | {
      phase: "downloading";
      version: string;
      notes: string;
      received: number;
      total: number | null;
    }
  | { phase: "installing"; version: string; notes: string }
  | { phase: "ready"; version: string; notes: string }
  | { phase: "failed"; version: string; notes: string; error: string };

interface UpdateSnapshot {
  update: UpdateState;
  hidden: boolean;
}

const CHECK_EVERY_MS = 30 * 60 * 1000;
const PROGRESS_EVERY_MS = 100;

const CHECKED_AT_KEY = "0xio_update_checked_at";

function readCheckedAt(): number | null {
  try {
    const n = Number(localStorage.getItem(CHECKED_AT_KEY));
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

let checkedAt = readCheckedAt();
let pending: Update | null = null;
let snapshot: UpdateSnapshot = { update: { phase: "idle" }, hidden: false };
const listeners = new Set<() => void>();

function publish(update: UpdateState, hidden = snapshot.hidden) {
  snapshot = { update, hidden };
  listeners.forEach((listener) => listener());
}

function log(level: "info" | "error", message: string) {
  invoke("frontend_log", { level, message: `[updater] ${message}` }).catch(() => {});
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function explainUpdateError(error: string): { summary: string; detail: string } {
  const detail = error
    .replace(/\s*\(https?:\/\/[^)]*\)/g, "")
    .replace(/https?:\/\/\S+/g, "")
    .trim();
  if (/signature/i.test(error)) {
    return {
      summary: "The download did not pass its signature check, so nothing was installed.",
      detail,
    };
  }
  if (/timed out|timeout|error sending request|connect|dns|network|offline/i.test(error)) {
    return { summary: "The download did not finish. Check your connection and try again.", detail };
  }
  if (/permission|denied|read-only|not permitted/i.test(error)) {
    return {
      summary:
        "The app files could not be replaced. Move 0xio Desktop to Applications and try again.",
      detail,
    };
  }
  return { summary: "Something went wrong while updating.", detail };
}

function notesOf(update: Update): string {
  const body = (update.body ?? "").trim();
  return body === `0xio Desktop v${update.version}` ? "" : body;
}

function adopt(update: Update) {
  const previous = pending;
  pending = update;
  if (previous && previous !== update) previous.close().catch(() => {});
}

export function formatMb(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

export function subscribeUpdates(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getUpdateSnapshot(): UpdateSnapshot {
  return snapshot;
}

export function getLastUpdateCheck(): number | null {
  return checkedAt;
}

function markChecked() {
  checkedAt = Date.now();
  try {
    localStorage.setItem(CHECKED_AT_KEY, String(checkedAt));
  } catch {}
  listeners.forEach((listener) => listener());
}

export async function checkForUpdate(manual = false): Promise<UpdateState> {
  const current = snapshot.update;
  if (
    current.phase === "downloading" ||
    current.phase === "installing" ||
    current.phase === "ready"
  ) {
    if (manual) publish(current, false);
    return current;
  }

  let found: Update | null;
  try {
    found = await check();
  } catch (e) {
    log("error", `check failed: ${describe(e)}`);
    throw e;
  }
  markChecked();

  if (!found) {
    if (current.phase !== "idle") publish({ phase: "idle" }, false);
    return { phase: "idle" };
  }

  const known = "version" in current && current.version === found.version;
  if (!known) log("info", `v${found.version} available, running v${found.currentVersion}`);
  adopt(found);
  const next: UpdateState = { phase: "available", version: found.version, notes: notesOf(found) };
  publish(next, manual ? false : known && snapshot.hidden);
  return next;
}

export function startUpdateChecks() {
  const run = () => {
    checkForUpdate().catch(() => {});
  };
  run();
  const timer = setInterval(run, CHECK_EVERY_MS);
  return () => clearInterval(timer);
}

export async function installUpdate() {
  const current = snapshot.update;
  if (current.phase === "downloading" || current.phase === "installing") return;

  const version = "version" in current ? current.version : "";
  publish(
    {
      phase: "downloading",
      version,
      notes: "notes" in current ? current.notes : "",
      received: 0,
      total: null,
    },
    false,
  );

  let update: Update | null;
  try {
    update = await check();
  } catch (e) {
    const error = describe(e);
    log("error", `check before download failed: ${error}`);
    publish({ phase: "failed", version, notes: "", error }, false);
    return;
  }
  if (!update) {
    log("info", "no update on the server any more");
    publish({ phase: "idle" }, false);
    return;
  }
  adopt(update);

  const base = { version: update.version, notes: notesOf(update) };
  let received = 0;
  let total: number | null = null;
  let lastPublish = 0;
  const startedAt = Date.now();
  log("info", `downloading v${update.version}`);
  publish({ ...base, phase: "downloading", received, total });

  try {
    await update.downloadAndInstall((event) => {
      if (event.event === "Started") {
        total = event.data.contentLength ?? null;
        log("info", `download started, ${total === null ? "size unknown" : formatMb(total)}`);
      } else if (event.event === "Progress") {
        received += event.data.chunkLength;
        const now = Date.now();
        if (now - lastPublish >= PROGRESS_EVERY_MS) {
          lastPublish = now;
          publish({ ...base, phase: "downloading", received, total });
        }
      } else {
        const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
        log("info", `downloaded ${formatMb(received)} in ${seconds}s, verifying and installing`);
        publish({ ...base, phase: "installing" });
      }
    });
    log("info", `v${update.version} installed, restart to finish`);
    publish({ ...base, phase: "ready" }, false);
  } catch (e) {
    const error = describe(e);
    log("error", `v${update.version} failed after ${formatMb(received)}: ${error}`);
    publish({ ...base, phase: "failed", error }, false);
  }
}

export function hideUpdate() {
  publish(snapshot.update, true);
}

export async function restartToUpdate() {
  log("info", "restarting into the installed update");
  try {
    await invoke("restart_app");
  } catch (e) {
    const current = snapshot.update;
    if (current.phase !== "ready") return;
    const error = `Could not restart: ${describe(e)}. Quit and reopen 0xio Desktop to finish.`;
    log("error", error);
    publish({ ...current, phase: "failed", error }, false);
  }
}
