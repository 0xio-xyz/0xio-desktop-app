import { describe, expect, it } from "vitest";
import {
  dockLayout,
  resizeDock,
  sidebarFloats,
} from "src/features/contracts/components/editor/dockLayout";

// The workspace row at the board's window sizes: window minus the 76 px rail and 32 px padding.
const row = (windowW: number) => windowW - 76 - 32;

describe("dockLayout", () => {
  it("docks at 1440 with the file list inline", () => {
    const l = dockLayout(row(1440), 440);
    expect(l).toMatchObject({
      docked: true,
      dockW: 440,
      cardW: 1332 - 12 - 440,
      filesInline: true,
    });
  });

  it("docks at 1280 and keeps the editor minimum", () => {
    const l = dockLayout(row(1280), 680);
    expect(l.docked).toBe(true);
    expect(l.dockMax).toBe(1172 - 12 - 520);
    expect(l.cardW).toBeGreaterThanOrEqual(520);
  });

  it("folds to the rail under about 1020", () => {
    expect(dockLayout(row(1020), 440).docked).toBe(true);
    expect(dockLayout(row(1019), 440).docked).toBe(false);
  });

  it("at 960 the panel is a rail and opens over the editor", () => {
    const l = dockLayout(row(960), 440);
    expect(l.docked).toBe(false);
    expect(l.cardW).toBe(852 - 12 - 64);
    expect(l.overlayW).toBe(440);
    expect(l.filesInline).toBe(true);
  });

  it("at 800 the file list floats and the overlay leaves part of the editor showing", () => {
    const l = dockLayout(row(800), 680);
    expect(l.docked).toBe(false);
    expect(l.filesInline).toBe(false);
    expect(l.overlayMax).toBe(692 - 64 - 12 - 96);
    expect(l.overlayW).toBe(l.overlayMax);
  });

  it("never lets the dock go under its minimum or over its maximum", () => {
    expect(dockLayout(row(1440), 100).dockW).toBe(380);
    expect(dockLayout(2400, 2000).dockW).toBe(680);
  });
});

describe("resizeDock", () => {
  it("drags left to widen and stays inside the limits", () => {
    const l = dockLayout(row(1440), 440);
    expect(resizeDock(l, 440, -60)).toBe(500);
    expect(resizeDock(l, 440, 400)).toBe(380);
    expect(resizeDock(l, 440, -1000)).toBe(l.dockMax);
  });
});

describe("sidebarFloats", () => {
  it("floats the expanded sidebar only when pushing would break the editor", () => {
    expect(sidebarFloats(800, 32)).toBe(true);
    expect(sidebarFloats(883, 32)).toBe(true);
    expect(sidebarFloats(884, 32)).toBe(false);
    expect(sidebarFloats(1280, 32)).toBe(false);
  });
});
