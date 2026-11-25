import { describe, expect, it } from "vitest";
import {
  diskRead,
  dirtyNames,
  discardAll,
  dropBuffer,
  editBuffer,
  emptyBuffers,
  isDirty,
  keepMine,
  leavePlan,
  markSaved,
  openBuffer,
  reloadFromDisk,
  renameBuffer,
  revertBuffer,
} from "src/features/contracts/components/editor/buffers";

const opened = () => openBuffer(openBuffer(emptyBuffers("disk:/p"), "a.aml", "A"), "b.aml", "B");

describe("buffers", () => {
  it("opens files clean, as tabs, the last one active", () => {
    const s = opened();
    expect(s.tabs).toEqual(["a.aml", "b.aml"]);
    expect(s.active).toBe("b.aml");
    expect(dirtyNames(s)).toEqual([]);
  });

  it("typing makes a file dirty and typing it back makes it clean", () => {
    let s = editBuffer(opened(), "a.aml", "A2");
    expect(isDirty(s, "a.aml")).toBe(true);
    expect(dirtyNames(s)).toEqual(["a.aml"]);
    s = editBuffer(s, "a.aml", "A");
    expect(isDirty(s, "a.aml")).toBe(false);
  });

  it("reopening keeps the edits", () => {
    const s = openBuffer(editBuffer(opened(), "a.aml", "A2"), "a.aml", "A");
    expect(s.files["a.aml"].buf).toBe("A2");
    expect(s.active).toBe("a.aml");
  });

  it("save makes the buffer the saved text", () => {
    const s = markSaved(editBuffer(opened(), "a.aml", "A2"), "a.aml");
    expect(s.files["a.aml"]).toMatchObject({ saved: "A2", buf: "A2" });
    expect(isDirty(s, "a.aml")).toBe(false);
  });

  it("save records exactly what was written, even if typing went on", () => {
    let s = editBuffer(opened(), "a.aml", "A2");
    s = editBuffer(s, "a.aml", "A3");
    s = markSaved(s, "a.aml", "A2");
    expect(isDirty(s, "a.aml")).toBe(true);
  });

  it("revert goes back to the saved text", () => {
    const s = revertBuffer(editBuffer(opened(), "a.aml", "A2"), "a.aml");
    expect(s.files["a.aml"].buf).toBe("A");
  });

  it("discard all reverts every file", () => {
    let s = editBuffer(editBuffer(opened(), "a.aml", "x"), "b.aml", "y");
    s = discardAll(s);
    expect(dirtyNames(s)).toEqual([]);
  });

  it("rename and delete carry the buffer and its tab", () => {
    let s = renameBuffer(editBuffer(opened(), "a.aml", "x"), "a.aml", "lib/a.aml");
    expect(s.tabs).toEqual(["lib/a.aml", "b.aml"]);
    expect(s.files["lib/a.aml"].buf).toBe("x");
    s = dropBuffer(s, "lib");
    expect(s.tabs).toEqual(["b.aml"]);
  });

  describe("leave decisions", () => {
    const dirty = editBuffer(editBuffer(opened(), "a.aml", "x"), "b.aml", "y");
    it("save all writes every dirty file, then leaves", () => {
      expect(leavePlan(dirty, "save")).toEqual({
        write: ["a.aml", "b.aml"],
        discard: false,
        proceed: true,
      });
    });
    it("don't save discards, then leaves", () => {
      expect(leavePlan(dirty, "discard")).toEqual({ write: [], discard: true, proceed: true });
    });
    it("cancel stays", () => {
      expect(leavePlan(dirty, "cancel").proceed).toBe(false);
    });
  });

  describe("changed on disk", () => {
    it("reloads a clean file silently", () => {
      const s = diskRead(opened(), "a.aml", "A disk");
      expect(s.files["a.aml"]).toMatchObject({ saved: "A disk", buf: "A disk", disk: null });
    });
    it("holds the disk text for a file with edits", () => {
      const s = diskRead(editBuffer(opened(), "a.aml", "mine"), "a.aml", "theirs");
      expect(s.files["a.aml"]).toMatchObject({ saved: "A", buf: "mine", disk: "theirs" });
    });
    it("reload takes the disk text", () => {
      const s = reloadFromDisk(
        diskRead(editBuffer(opened(), "a.aml", "mine"), "a.aml", "theirs"),
        "a.aml",
      );
      expect(s.files["a.aml"]).toMatchObject({ saved: "theirs", buf: "theirs", disk: null });
    });
    it("keep mine keeps the edits against the new disk text", () => {
      const s = keepMine(
        diskRead(editBuffer(opened(), "a.aml", "mine"), "a.aml", "theirs"),
        "a.aml",
      );
      expect(s.files["a.aml"]).toMatchObject({ saved: "theirs", buf: "mine", disk: null });
      expect(isDirty(s, "a.aml")).toBe(true);
    });
    it("a disk read equal to the saved text changes nothing", () => {
      const s = opened();
      expect(diskRead(s, "a.aml", "A")).toBe(s);
    });
  });
});
