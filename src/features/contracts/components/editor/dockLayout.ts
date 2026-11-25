// minimum: with room the panel docks beside it, otherwise it folds to a rail and opens over it.

const EDITOR_MIN = 520;
export const DOCK_MIN = 380;
const DOCK_MAX = 680;
const RAIL_W = 64;
const GAP = 12;
const FILES_W = 168;
const OVERLAY_SLACK = 96;
const SIDEBAR_W = 256;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

interface DockLayout {
  docked: boolean;
  dockMax: number;
  dockW: number;
  overlayMax: number;
  overlayW: number;
  cardW: number;
  filesInline: boolean;
}

export function dockLayout(width: number, wanted: number): DockLayout {
  const docked = width >= EDITOR_MIN + GAP + DOCK_MIN;
  const dockMax = Math.max(DOCK_MIN, Math.min(DOCK_MAX, width - GAP - EDITOR_MIN));
  const dockW = clamp(wanted, DOCK_MIN, dockMax);
  const overlayMax = Math.max(DOCK_MIN, Math.min(DOCK_MAX, width - RAIL_W - GAP - OVERLAY_SLACK));
  const overlayW = clamp(wanted, DOCK_MIN, overlayMax);
  const cardW = docked ? width - GAP - dockW : width - GAP - RAIL_W;
  return {
    docked,
    dockMax,
    dockW,
    overlayMax,
    overlayW,
    cardW,
    filesInline: cardW >= EDITOR_MIN + FILES_W,
  };
}

export function resizeDock(layout: DockLayout, from: number, delta: number): number {
  const max = layout.docked ? layout.dockMax : layout.overlayMax;
  return clamp(Math.min(from, max) - delta, DOCK_MIN, max);
}

// An expanded sidebar pushes the page unless the editor and the rail would no longer fit; then
// it floats over the page instead.
export function sidebarFloats(windowW: number, pagePadding: number): boolean {
  return windowW - SIDEBAR_W - pagePadding < EDITOR_MIN + GAP + RAIL_W;
}
