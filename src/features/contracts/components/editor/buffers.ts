// The store outlives the screen, so leaving the Build tab, locking or a remount keeps unsaved
// work in memory. Nothing is written until a save.
// buffer. Nothing is written until a save; the store outlives the screen so leaving the Build tab,
// locking or a remount keeps unsaved work in memory.

interface FileBuffer {
  saved: string;
  buf: string;
  disk: string | null;
}

interface Buffers {
  project: string;
  files: Record<string, FileBuffer>;
  tabs: string[];
  active: string;
}

export type LeaveChoice = "save" | "discard" | "cancel";

export const emptyBuffers = (project: string): Buffers => ({
  project,
  files: {},
  tabs: [],
  active: "",
});

const put = (s: Buffers, name: string, patch: Partial<FileBuffer>): Buffers => {
  const cur = s.files[name];
  if (!cur) return s;
  return { ...s, files: { ...s.files, [name]: { ...cur, ...patch } } };
};

export function isDirty(s: Buffers, name: string): boolean {
  const f = s.files[name];
  return !!f && f.buf !== f.saved;
}

export function dirtyNames(s: Buffers): string[] {
  return s.tabs
    .concat(Object.keys(s.files).filter((n) => !s.tabs.includes(n)))
    .filter((n) => isDirty(s, n));
}

export function openBuffer(s: Buffers, name: string, saved: string): Buffers {
  const files =
    name in s.files ? s.files : { ...s.files, [name]: { saved, buf: saved, disk: null } };
  const tabs = s.tabs.includes(name) ? s.tabs : [...s.tabs, name];
  return { ...s, files, tabs, active: name };
}

export function editBuffer(s: Buffers, name: string, text: string): Buffers {
  const cur = s.files[name];
  if (!cur || cur.buf === text) return s;
  return put(s, name, { buf: text });
}

export function markSaved(s: Buffers, name: string, text?: string): Buffers {
  const cur = s.files[name];
  if (!cur) return s;
  const saved = text ?? cur.buf;
  return put(s, name, { saved, disk: null });
}

export function revertBuffer(s: Buffers, name: string): Buffers {
  const cur = s.files[name];
  return cur ? put(s, name, { buf: cur.saved }) : s;
}

export function discardAll(s: Buffers): Buffers {
  const files: Record<string, FileBuffer> = {};
  for (const [n, f] of Object.entries(s.files)) files[n] = { ...f, buf: f.saved, disk: null };
  return { ...s, files };
}

export function diskRead(s: Buffers, name: string, onDisk: string): Buffers {
  const cur = s.files[name];
  if (!cur) return s;
  if (onDisk === cur.saved) return cur.disk == null ? s : put(s, name, { disk: null });
  if (cur.buf === cur.saved) return put(s, name, { saved: onDisk, buf: onDisk, disk: null });
  return cur.disk === onDisk ? s : put(s, name, { disk: onDisk });
}

export function reloadFromDisk(s: Buffers, name: string): Buffers {
  const cur = s.files[name];
  if (!cur || cur.disk == null) return s;
  return put(s, name, { saved: cur.disk, buf: cur.disk, disk: null });
}

export function keepMine(s: Buffers, name: string): Buffers {
  const cur = s.files[name];
  if (!cur || cur.disk == null) return s;
  return put(s, name, { saved: cur.disk, disk: null });
}

export function renameBuffer(s: Buffers, from: string, to: string): Buffers {
  const move = (n: string) =>
    n === from ? to : n.startsWith(`${from}/`) ? to + n.slice(from.length) : n;
  const files: Record<string, FileBuffer> = {};
  for (const [n, f] of Object.entries(s.files)) files[move(n)] = f;
  return { ...s, files, tabs: s.tabs.map(move), active: move(s.active) };
}

export function dropBuffer(s: Buffers, name: string): Buffers {
  const gone = (n: string) => n === name || n.startsWith(`${name}/`);
  const files: Record<string, FileBuffer> = {};
  for (const [n, f] of Object.entries(s.files)) if (!gone(n)) files[n] = f;
  const tabs = s.tabs.filter((n) => !gone(n));
  return { ...s, files, tabs, active: gone(s.active) ? "" : s.active };
}

export function leavePlan(
  s: Buffers,
  choice: LeaveChoice,
): { write: string[]; discard: boolean; proceed: boolean } {
  if (choice === "cancel") return { write: [], discard: false, proceed: false };
  if (choice === "save") return { write: dirtyNames(s), discard: false, proceed: true };
  return { write: [], discard: true, proceed: true };
}

type Listener = () => void;

let current: Buffers = emptyBuffers("");
const listeners = new Set<Listener>();

export const bufferStore = {
  get: (): Buffers => current,
  set(next: Buffers | ((s: Buffers) => Buffers)) {
    const value = typeof next === "function" ? next(current) : next;
    if (value === current) return;
    current = value;
    for (const l of listeners) l();
  },
  subscribe(l: Listener) {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  },
};
