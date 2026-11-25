import { invoke } from "@tauri-apps/api/core";

type Entry = {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  fullPath: string;
  file: (ok: (file: File) => void, fail: (e: unknown) => void) => void;
  createReader: () => {
    readEntries: (ok: (entries: Entry[]) => void, fail: (e: unknown) => void) => void;
  };
};

type PickedFile = { file: File; path: string };

const pickedFiles = (files: ArrayLike<File> | null | undefined): PickedFile[] =>
  Array.from(files ?? []).map((file) => ({ file, path: `/${file.name}` }));

type Chosen = { token: string; path: string; name: string; size: number };
export type ChooseKind = "any" | "files" | "folder";

export const CHOOSES_BOTH = /mac/i.test(typeof navigator === "undefined" ? "" : navigator.platform);

class ChosenFile extends File {
  private readonly token: string;

  constructor(chosen: Chosen) {
    super([], chosen.name);
    this.token = chosen.token;
    Object.defineProperty(this, "size", { value: chosen.size });
  }

  override arrayBuffer(): Promise<ArrayBuffer> {
    return invoke<ArrayBuffer>("circle_read_picked", { token: this.token });
  }
}

export async function chosenFiles(kind: ChooseKind): Promise<PickedFile[]> {
  const chosen = await invoke<Chosen[]>("circle_pick", { kind });
  return chosen.map((c) => ({ file: new ChosenFile(c), path: c.path }));
}

export function droppedFiles(data: DataTransfer, max: number): Promise<PickedFile[]> {
  const entries = Array.from(data.items ?? [])
    .map((item) => (item as { webkitGetAsEntry?: () => Entry | null }).webkitGetAsEntry?.())
    .filter((e): e is Entry => !!e);
  if (!entries.length) return Promise.resolve(pickedFiles(data.files).slice(0, max));
  const strip = entries.length === 1 && entries[0].isDirectory ? entries[0].fullPath.length : 0;
  const out: PickedFile[] = [];
  const walk = async (entry: Entry, top: boolean): Promise<void> => {
    if (out.length >= max || (!top && entry.name.startsWith("."))) return;
    if (entry.isFile) {
      const file = await new Promise<File>((ok, fail) => entry.file(ok, fail));
      out.push({ file, path: entry.fullPath.slice(strip) || `/${file.name}` });
      return;
    }
    if (!entry.isDirectory) return;
    const reader = entry.createReader();
    for (;;) {
      const batch = await new Promise<Entry[]>((ok, fail) => reader.readEntries(ok, fail));
      if (!batch.length) return;
      for (const child of batch) await walk(child, false);
    }
  };
  return (async () => {
    for (const entry of entries) await walk(entry, true).catch(() => {});
    return out;
  })();
}
