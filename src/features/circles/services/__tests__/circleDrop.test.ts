import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { chosenFiles } from "src/features/circles/services/circleDrop";

describe("chosenFiles", () => {
  beforeEach(() => invoke.mockReset());

  it("keeps the paths the app returns and reports the real size", async () => {
    invoke.mockResolvedValueOnce([
      { token: "p1", path: "/index.html", name: "index.html", size: 4584 },
      { token: "p2", path: "/css/style.css", name: "style.css", size: 8585 },
    ]);
    const files = await chosenFiles("any");
    expect(invoke).toHaveBeenCalledWith("circle_pick", { kind: "any" });
    expect(files.map((f) => f.path)).toEqual(["/index.html", "/css/style.css"]);
    expect(files.map((f) => [f.file.name, f.file.size])).toEqual([
      ["index.html", 4584],
      ["style.css", 8585],
    ]);
  });

  it("reads a file's bytes from the app by its token, only when asked", async () => {
    invoke.mockResolvedValueOnce([{ token: "p7", path: "/a.txt", name: "a.txt", size: 3 }]);
    const [{ file }] = await chosenFiles("files");
    expect(invoke).toHaveBeenCalledTimes(1);
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    invoke.mockResolvedValueOnce(bytes);
    expect(await file.arrayBuffer()).toBe(bytes);
    expect(invoke).toHaveBeenLastCalledWith("circle_read_picked", { token: "p7" });
  });

  it("a cancelled window stages nothing", async () => {
    invoke.mockResolvedValueOnce([]);
    expect(await chosenFiles("folder")).toEqual([]);
  });
});
