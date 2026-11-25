import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import {
  FRAME_MS,
  OPEN,
  createTumbler,
  type Tumbler,
} from "src/features/security/services/tumblerEngine";
import {
  drawTumbler,
  tumblerPalette,
  type TumblerPalette,
  type TumblerReading,
} from "src/features/security/services/tumblerDraw";

export function useTumbler(): Tumbler {
  return useState(() => createTumbler())[0];
}

function subscribeTheme(onChange: () => void) {
  const watch = new MutationObserver(onChange);
  watch.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme", "style", "class"],
  });
  return () => watch.disconnect();
}

function themeKey() {
  const root = document.documentElement;
  return `${root.getAttribute("data-theme") ?? ""}|${root.getAttribute("style") ?? ""}|${root.className}`;
}

export function useTumblerPalette(): TumblerPalette {
  const key = useSyncExternalStore(subscribeTheme, themeKey, () => "");
  return useMemo(() => {
    const root = document.documentElement;
    const css = getComputedStyle(root);
    return tumblerPalette(key && root.getAttribute("data-theme"), {
      bg: css.getPropertyValue("--bg-main"),
      text: css.getPropertyValue("--text-main"),
      secondary: css.getPropertyValue("--text-secondary"),
      muted: css.getPropertyValue("--text-muted"),
    });
  }, [key]);
}

export function useTumblerCanvas(
  canvasRef: RefObject<HTMLCanvasElement | null>,
  tumbler: Tumbler,
  palette: TumblerPalette,
  reading: TumblerReading | null,
) {
  const view = useRef({ palette, reading });
  view.current = { palette, reading };
  const refresh = useRef(() => {});

  useEffect(() => {
    const canvas = canvasRef.current;
    const g = canvas?.getContext("2d");
    if (!canvas || !g) return;
    const motion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const font = getComputedStyle(canvas).fontFamily || "sans-serif";
    let width = 0;
    let height = 0;
    let raf = 0;
    let timer = 0;
    let last = -Infinity;

    const still = () => motion?.matches ?? false;
    const size = () => {
      const r = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = r.width;
      height = r.height;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    const paint = (t: number) => {
      const { palette: p, reading: info } = view.current;
      const state = still() ? OPEN : tumbler.scene.state(t);
      drawTumbler(g, { width, height, state, palette: p, reading: info, font });
    };
    const stop = () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
      raf = 0;
      timer = 0;
    };
    const frame = (now: number) => {
      raf = 0;
      if (now - last < FRAME_MS - 2) {
        raf = requestAnimationFrame(frame);
        return;
      }
      last = now;
      const t = tumbler.time();
      paint(t);
      schedule(t);
    };
    const schedule = (t = tumbler.time()) => {
      stop();
      if (document.hidden || still()) return;
      const next = tumbler.scene.nextMotion(t);
      if (next <= t) raf = requestAnimationFrame(frame);
      else if (Number.isFinite(next)) {
        timer = window.setTimeout(() => {
          timer = 0;
          raf = requestAnimationFrame(frame);
        }, next - t);
      }
    };
    const redraw = () => {
      const t = tumbler.time();
      paint(t);
      schedule(t);
    };
    const onResize = () => {
      size();
      redraw();
    };
    const onVisibility = () => (document.hidden ? stop() : redraw());

    refresh.current = redraw;
    size();
    redraw();
    const unwake = tumbler.onWake(() => schedule());
    window.addEventListener("resize", onResize);
    document.addEventListener("visibilitychange", onVisibility);
    motion?.addEventListener?.("change", redraw);
    return () => {
      stop();
      unwake();
      refresh.current = () => {};
      window.removeEventListener("resize", onResize);
      document.removeEventListener("visibilitychange", onVisibility);
      motion?.removeEventListener?.("change", redraw);
    };
  }, [canvasRef, tumbler]);

  useEffect(() => {
    refresh.current();
  }, [palette, reading]);
}
