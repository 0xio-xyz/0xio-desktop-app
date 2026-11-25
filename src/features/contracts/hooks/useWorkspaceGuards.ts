import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { setLeaveGuard } from "src/lib/appHistory";
import {
  bufferStore,
  diskRead,
  dirtyNames,
} from "src/features/contracts/components/editor/buffers";
import { readWorkspaceFile } from "src/features/contracts/components/editor/workspaceFs";
import { logger } from "src/lib/logger";

export type LeaveTarget = "page" | "project" | "close";

const STAYS = ["/contracts", "/lock", "/onboarding"];

const hasUnsaved = (project: string) => {
  const s = bufferStore.get();
  return s.project === project && dirtyNames(s).length > 0;
};

export function useUnsavedGuards(
  project: string,
  ask: (target: LeaveTarget, proceed: () => void) => void,
) {
  const askRef = useRef(ask);
  askRef.current = ask;
  const projectRef = useRef(project);
  projectRef.current = project;

  // effect:audited - the app router's guard lives as long as the workspace is on screen.
  useEffect(
    () =>
      setLeaveGuard((path, proceed) => {
        if (path === "" || (path && STAYS.some((p) => path === p || path.startsWith(`${p}/`))))
          return true;
        if (!hasUnsaved(projectRef.current)) return true;
        askRef.current("page", proceed);
        return false;
      }),
    [],
  );

  // effect:audited - the window's close request. Rust closes to the menu bar unless held; the
  // handler always prevents the default so the main window is never destroyed from here.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let gone = false;
    let win: ReturnType<typeof getCurrentWindow>;
    try {
      win = getCurrentWindow();
    } catch {
      return;
    }
    win
      .onCloseRequested((e) => {
        e.preventDefault();
        if (!hasUnsaved(projectRef.current)) return;
        askRef.current("close", () => {
          void invoke("main_close_hold", { held: false })
            .catch(() => {})
            .finally(() => void win.close().catch(() => {}));
        });
      })
      .then((u) => (gone ? u() : (unlisten = u)))
      .catch(() => {});
    return () => {
      gone = true;
      unlisten?.();
    };
  }, []);

  const held = useUnsavedCount(project) > 0;
  // effect:audited - tells Rust to keep the window open on close while anything is unsaved.
  useEffect(() => {
    void invoke("main_close_hold", { held }).catch(() => {});
    return () => void invoke("main_close_hold", { held: false }).catch(() => {});
  }, [held]);
}

function useUnsavedCount(project: string): number {
  const [count, setCount] = useState(() => (hasUnsaved(project) ? 1 : 0));
  // effect:audited - mirrors the buffer store's dirty state for the close hold.
  useEffect(() => {
    const read = () => setCount(hasUnsaved(project) ? 1 : 0);
    read();
    return bufferStore.subscribe(read);
  }, [project]);
  return count;
}

let ioGeneration = 0;

/** Every write bumps this, so a disk read that started before it is thrown away. */
export function bumpIoGeneration() {
  ioGeneration++;
}

export function useDiskWatch(dir: string | null, onListing: () => void) {
  const listingRef = useRef(onListing);
  listingRef.current = onListing;

  // effect:audited - polling the real folder while the workspace shows it.
  useEffect(() => {
    if (!dir) return;
    const project = `disk:${dir}`;
    let busy = false;
    const check = async () => {
      if (busy || document.visibilityState !== "visible") return;
      const s = bufferStore.get();
      if (s.project !== project) return;
      busy = true;
      const gen = ioGeneration;
      try {
        const reads = await Promise.all(
          Object.keys(s.files).map(async (name) => {
            try {
              return [name, await readWorkspaceFile(dir, name)] as const;
            } catch {
              return null;
            }
          }),
        );
        if (gen !== ioGeneration) return;
        bufferStore.set((cur) =>
          cur.project !== project
            ? cur
            : reads.reduce((acc, r) => (r ? diskRead(acc, r[0], r[1]) : acc), cur),
        );
        listingRef.current();
      } catch (e) {
        logger.warn("contract", `disk check failed: ${e}`);
      } finally {
        busy = false;
      }
    };
    const id = setInterval(() => void check(), 4000);
    const onFocus = () => void check();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      clearInterval(id);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [dir]);
}

export function useWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  // effect:audited - ResizeObserver is the only way to follow the element's own width.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(Math.round(el.getBoundingClientRect().width));
    const ro = new ResizeObserver((entries) => {
      const w = Math.round(entries[0].contentRect.width);
      if (w > 0) setWidth((prev) => (prev === w ? prev : w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}
