import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

export type Side = "top" | "bottom";
export type Align = "start" | "center" | "end";

interface Place {
  x: number;
  y: number;
  side: Side;
}

export function place(
  anchor: { left: number; top: number; right: number; bottom: number; width: number },
  size: { width: number; height: number },
  view: { width: number; height: number },
  side: Side,
  align: Align,
  offset: number,
): Place {
  const below = view.height - anchor.bottom - offset;
  const above = anchor.top - offset;
  const fits = (s: Side) => (s === "bottom" ? below : above) >= size.height;
  let chosen = side;
  if (!fits(side)) {
    const other: Side = side === "bottom" ? "top" : "bottom";
    if (fits(other) || (other === "bottom" ? below : above) > (side === "bottom" ? below : above))
      chosen = other;
  }
  let x =
    align === "start"
      ? anchor.left
      : align === "end"
        ? anchor.right - size.width
        : anchor.left + (anchor.width - size.width) / 2;
  x = Math.max(0, Math.min(x, view.width - size.width));
  const y = chosen === "bottom" ? anchor.bottom + offset : anchor.top - offset - size.height;
  return { x: Math.round(x), y: Math.round(y), side: chosen };
}

export function useAnchoredPosition(
  open: boolean,
  anchorRef: RefObject<HTMLElement | null>,
  floatingRef: RefObject<HTMLElement | null>,
  side: Side,
  align: Align,
  offset: number,
) {
  const [pos, setPos] = useState<Place | null>(null);
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const update = () => {
      const a = anchorRef.current;
      const f = floatingRef.current;
      if (!a || !f) return;
      const next = place(
        a.getBoundingClientRect(),
        f.getBoundingClientRect(),
        { width: window.innerWidth, height: window.innerHeight },
        side,
        align,
        offset,
      );
      setPos((prev) =>
        prev && prev.x === next.x && prev.y === next.y && prev.side === next.side ? prev : next,
      );
    };
    update();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    if (floatingRef.current) observer?.observe(floatingRef.current);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open, anchorRef, floatingRef, side, align, offset]);
  return pos;
}

const stack: symbol[] = [];

/**
 * Closes the topmost open layer on Escape (the key event is marked handled, so screens behind it
 * do not also react) and on a press outside it. `inside` lists elements that do not count as
 * outside, such as the trigger.
 */
export function useDismiss(
  open: boolean,
  inside: RefObject<HTMLElement | null>[],
  onDismiss: (reason: "escape" | "outside" | "focus") => void,
  closeOnFocusOutside = false,
) {
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  const refs = useRef(inside);
  refs.current = inside;
  useEffect(() => {
    if (!open) return;
    const id = Symbol("layer");
    stack.push(id);
    const top = () => stack[stack.length - 1] === id;
    const within = (target: EventTarget | null) =>
      target instanceof Node && refs.current.some((r) => r.current?.contains(target));
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !top()) return;
      e.preventDefault();
      dismiss.current("escape");
    };
    const onDown = (e: PointerEvent) => {
      if (!top() || within(e.target)) return;
      dismiss.current("outside");
    };
    const onFocus = (e: FocusEvent) => {
      if (top() && !within(e.target)) dismiss.current("focus");
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onDown, true);
    if (closeOnFocusOutside) document.addEventListener("focusin", onFocus);
    return () => {
      stack.splice(stack.indexOf(id), 1);
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("focusin", onFocus);
    };
  }, [open, closeOnFocusOutside]);
}

const TABBABLE =
  'button:not([disabled]),[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function firstTabbable(root: HTMLElement): HTMLElement | null {
  return root.querySelector<HTMLElement>(TABBABLE);
}

let seq = 0;
export function useLayerId(prefix: string): string {
  const [id] = useState(() => `${prefix}-${++seq}`);
  return id;
}
