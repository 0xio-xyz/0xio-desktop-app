// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => null),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import { hidePanel, usePanelKeys } from "../useTrayState";

afterEach(cleanup);

describe("hiding the menu bar panel", () => {
  it("goes through Rust, which tells the main window", async () => {
    await hidePanel();
    expect(tauri.invoke).toHaveBeenCalledWith("tray_hide");
  });

  it("is what Escape does", () => {
    tauri.invoke.mockClear();
    renderHook(() => usePanelKeys(async () => null));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(tauri.invoke.mock.calls.map(([cmd]) => cmd)).toEqual(["tray_hide"]);
  });

  it("is never done by the page on its own window", () => {
    const dir = join(process.cwd(), "src/tray");
    const sources = readdirSync(dir).filter((f) => /\.tsx?$/.test(f));
    expect(sources.length).toBeGreaterThan(5);
    for (const file of sources) {
      const text = readFileSync(join(dir, file), "utf8");
      expect(text, file).not.toMatch(/getCurrentWindow|\.hide\(\)/);
    }
  });
});
