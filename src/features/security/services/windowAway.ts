import { getCurrentWindow } from "@tauri-apps/api/window";
import { logger } from "src/lib/logger";

export function watchWindowAway(onAway: () => void): () => void {
  const onVisibility = () => {
    if (document.visibilityState === "hidden") onAway();
  };
  window.addEventListener("blur", onAway);
  window.addEventListener("pagehide", onAway);
  document.addEventListener("visibilitychange", onVisibility);

  let stopped = false;
  let unlisten: (() => void) | null = null;
  try {
    void getCurrentWindow()
      .onFocusChanged(({ payload: focused }) => {
        if (!focused) onAway();
      })
      .then((off) => {
        if (stopped) off();
        else unlisten = off;
      })
      .catch(() => {});
  } catch {
    unlisten = null;
  }

  return () => {
    stopped = true;
    unlisten?.();
    window.removeEventListener("blur", onAway);
    window.removeEventListener("pagehide", onAway);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}

const SETTLE_MS = 1000;
const documentShown = () =>
  typeof document === "undefined" || document.visibilityState !== "hidden";

let shown = documentShown();
let watching = false;
let probe = 0;
const shownListeners = new Set<(shown: boolean) => void>();

function setShown(next: boolean): void {
  if (next === shown) return;
  shown = next;
  logger.info("app", next ? "window shown - polling resumed" : "window hidden - polling paused");
  shownListeners.forEach((fn) => fn(next));
}

async function nativeShown(): Promise<boolean> {
  try {
    const win = getCurrentWindow();
    const [visible, minimized] = await Promise.all([win.isVisible(), win.isMinimized()]);
    return visible && !minimized;
  } catch {
    return true;
  }
}

function readShown(): void {
  const id = ++probe;
  if (!documentShown()) return setShown(false);
  void nativeShown().then((native) => {
    if (id === probe) setShown(native && documentShown());
  });
}

function onWindowChange(): void {
  readShown();
  setTimeout(readShown, SETTLE_MS);
}

function watchShown(): void {
  if (watching || typeof window === "undefined") return;
  watching = true;
  window.addEventListener("blur", onWindowChange);
  window.addEventListener("focus", onWindowChange);
  window.addEventListener("pageshow", onWindowChange);
  document.addEventListener("visibilitychange", onWindowChange);
  readShown();
  try {
    void getCurrentWindow()
      .onFocusChanged(onWindowChange)
      .catch(() => {});
  } catch {
    return;
  }
}

export function isWindowShown(): boolean {
  return shown;
}

export function subscribeWindowShown(fn: (shown: boolean) => void): () => void {
  watchShown();
  shownListeners.add(fn);
  return () => {
    shownListeners.delete(fn);
  };
}
