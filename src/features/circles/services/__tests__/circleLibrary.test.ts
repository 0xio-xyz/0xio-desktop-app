// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  addCircle,
  circleTitle,
  libraryKey,
  MAX_CIRCLE_FILES,
  MAX_CIRCLES,
  pageTitle,
  putFile,
  readLibrary,
  removeCircle,
  resetLibraryCache,
  settleFile,
  updateCircle,
} from "src/features/circles/services/circleLibrary";

const WALLET = `oct${"A".repeat(44)}`;
const OTHER = `oct${"B".repeat(44)}`;
const id = (n: number) => `oct${String(n).padStart(44, "C")}`;
const scope = { networkId: "devnet", address: WALLET };
const file = (path: string, tx: string, status: "confirmed" | "pending" = "confirmed") => ({
  path,
  size: 10,
  type: "text/html",
  at: 1000,
  tx,
  status,
});

beforeEach(() => {
  localStorage.clear();
  resetLibraryCache();
});

describe("the circle library", () => {
  it("persists a circle and its files under the network and address", () => {
    addCircle(scope, { id: id(1), sealed: true, deployTx: "aa", status: "confirmed" });
    putFile(scope, id(1), { ...file("/index.html", "t1"), title: "0xio notes" });
    resetLibraryCache();
    const [circle] = readLibrary(scope);
    expect(circle).toMatchObject({ id: id(1), sealed: true, deployTx: "aa", status: "confirmed" });
    expect(circle.files).toEqual([{ ...file("/index.html", "t1"), title: "0xio notes" }]);
    expect(circleTitle(circle)).toBe("0xio notes");
    expect(localStorage.getItem(`0xio_circles:devnet:${WALLET}`)).toBeTruthy();
  });

  it("shows nothing to another network or another address", () => {
    addCircle(scope, { id: id(1), sealed: false, deployTx: "aa", status: "confirmed" });
    expect(readLibrary({ networkId: "mainnet", address: WALLET })).toEqual([]);
    expect(readLibrary({ networkId: "devnet", address: OTHER })).toEqual([]);
    expect(readLibrary(null)).toEqual([]);
    expect(readLibrary(scope)).toHaveLength(1);
  });

  it("carries the scoped recent list over once and drops the unscoped one", () => {
    localStorage.setItem("0xio_recent_circles", JSON.stringify([id(9)]));
    localStorage.setItem(
      `0xio_recent_circles:devnet:${WALLET}`,
      JSON.stringify([id(1), id(2), id(1), "nonsense", 5]),
    );
    const list = readLibrary(scope);
    expect(list.map((c) => c.id)).toEqual([id(1), id(2)]);
    expect(list[0]).toMatchObject({ sealed: null, status: "confirmed", createdAt: 0, files: [] });
    expect(localStorage.getItem(`0xio_recent_circles:devnet:${WALLET}`)).toBeNull();
    expect(localStorage.getItem("0xio_recent_circles")).toBeNull();
    resetLibraryCache();
    expect(readLibrary(scope).map((c) => c.id)).toEqual([id(1), id(2)]);
    expect(readLibrary({ networkId: "mainnet", address: WALLET })).toEqual([]);
  });

  it("keeps one entry per path, so a replace does not grow the record", () => {
    addCircle(scope, { id: id(1), sealed: false, deployTx: "aa", status: "confirmed" });
    for (let i = 0; i < 50; i++) putFile(scope, id(1), file("/index.html", `t${i}`));
    expect(readLibrary(scope)[0].files).toEqual([file("/index.html", "t49")]);
  });

  it("caps the files of a circle and the circles of a scope", () => {
    addCircle(scope, { id: id(0), sealed: false, deployTx: "aa", status: "confirmed" });
    for (let i = 0; i < MAX_CIRCLE_FILES + 20; i++) putFile(scope, id(0), file(`/f${i}`, "t"));
    expect(readLibrary(scope)[0].files).toHaveLength(MAX_CIRCLE_FILES);
    expect(readLibrary(scope)[0].files[0].path).toBe(`/f${MAX_CIRCLE_FILES + 19}`);
    const many = Array.from({ length: MAX_CIRCLES + 30 }, (_, i) => ({
      id: id(i + 1),
      sealed: false,
      files: [],
    }));
    localStorage.setItem(libraryKey(scope), JSON.stringify({ v: 1, circles: many }));
    resetLibraryCache();
    expect(readLibrary(scope)).toHaveLength(MAX_CIRCLES);
    addCircle(scope, { id: id(999), sealed: false, deployTx: "aa", status: "confirmed" });
    expect(readLibrary(scope)).toHaveLength(MAX_CIRCLES);
    expect(readLibrary(scope)[0].id).toBe(id(999));
  });

  it("a rejected replace brings back the file it would have replaced", () => {
    addCircle(scope, { id: id(1), sealed: false, deployTx: "aa", status: "confirmed" });
    putFile(scope, id(1), { ...file("/index.html", "t1"), title: "Old" });
    putFile(scope, id(1), { ...file("/index.html", "t2", "pending"), title: "New" });
    expect(circleTitle(readLibrary(scope)[0])).toBe("Old");
    settleFile(scope, id(1), "/index.html", "t2", "rejected");
    expect(readLibrary(scope)[0].files).toEqual([{ ...file("/index.html", "t1"), title: "Old" }]);
    putFile(scope, id(1), { ...file("/index.html", "t3", "pending"), title: "New" });
    settleFile(scope, id(1), "/index.html", "t3", "confirmed");
    expect(readLibrary(scope)[0].files).toEqual([{ ...file("/index.html", "t3"), title: "New" }]);
    putFile(scope, id(1), file("/a.css", "t4", "pending"));
    settleFile(scope, id(1), "/a.css", "t4", "rejected");
    expect(readLibrary(scope)[0].files.map((f) => f.path)).toEqual(["/index.html"]);
  });

  it("updates and removes a circle, and ignores a broken record", () => {
    addCircle(scope, { id: id(1), sealed: null, deployTx: "aa", status: "pending" });
    updateCircle(scope, id(1), { status: "confirmed", sealed: true });
    expect(readLibrary(scope)[0]).toMatchObject({ status: "confirmed", sealed: true });
    removeCircle(scope, id(1));
    expect(readLibrary(scope)).toEqual([]);
    localStorage.setItem(libraryKey(scope), "{not json");
    resetLibraryCache();
    expect(readLibrary(scope)).toEqual([]);
  });

  it("reads the title of an index page as plain text", () => {
    const html = new TextEncoder().encode("<html><head><title> 0xio &amp;\n notes </title></head>");
    expect(pageTitle(html, "text/html; charset=utf-8")).toBe("0xio & notes");
    expect(pageTitle(html, "text/plain")).toBe("");
    expect(pageTitle(new TextEncoder().encode("<p>hi</p>"), "text/html")).toBe("");
    const long = new TextEncoder().encode(`<title>${"x".repeat(500)}</title>`);
    expect(pageTitle(long, "text/html")).toHaveLength(80);
  });
});
