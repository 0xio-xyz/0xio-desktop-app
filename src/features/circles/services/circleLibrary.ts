import { useSyncExternalStore } from "react";

export type LibraryScope = { readonly networkId: string; readonly address: string };

type FileStamp = { size: number; type: string; at: number; tx: string; title?: string };

type CircleFile = FileStamp & {
  path: string;
  status: "confirmed" | "pending";
  prev?: FileStamp;
};

export type CircleRecord = {
  id: string;
  sealed: boolean | null;
  createdAt: number;
  deployTx: string;
  status: "confirmed" | "pending";
  files: CircleFile[];
};

export const MAX_CIRCLES = 200;
export const MAX_CIRCLE_FILES = 500;
const MAX_TITLE = 80;
export const INDEX_PATH = "/index.html";

const PREFIX = "0xio_circles";
const LEGACY_RECENT = "0xio_recent_circles";
const CIRCLE_ID = /^oct[A-Za-z0-9]{44}$/;
const EMPTY: CircleRecord[] = [];

export const libraryKey = (scope: LibraryScope) => `${PREFIX}:${scope.networkId}:${scope.address}`;
const recentKey = (scope: LibraryScope) => `${LEGACY_RECENT}:${scope.networkId}:${scope.address}`;

const listeners = new Set<() => void>();
const cache = new Map<string, { raw: string | null; list: CircleRecord[] }>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
const text = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");

function stampOf(v: any): FileStamp {
  const title = text(v?.title, MAX_TITLE);
  return {
    size: num(v?.size),
    type: text(v?.type, 200),
    at: num(v?.at),
    tx: text(v?.tx, 128),
    ...(title ? { title } : {}),
  };
}

function fileOf(v: any): CircleFile | null {
  if (typeof v?.path !== "string" || !v.path.startsWith("/") || v.path.length > 1024) return null;
  const pending = v.status === "pending";
  return {
    path: v.path,
    ...stampOf(v),
    status: pending ? "pending" : "confirmed",
    ...(pending && v.prev && typeof v.prev === "object" ? { prev: stampOf(v.prev) } : {}),
  };
}

function circleOf(v: any): CircleRecord | null {
  if (typeof v?.id !== "string" || !CIRCLE_ID.test(v.id)) return null;
  const seen = new Set<string>();
  const files: CircleFile[] = [];
  for (const raw of Array.isArray(v.files) ? v.files : []) {
    const file = fileOf(raw);
    if (!file || seen.has(file.path) || files.length >= MAX_CIRCLE_FILES) continue;
    seen.add(file.path);
    files.push(file);
  }
  return {
    id: v.id,
    sealed: typeof v.sealed === "boolean" ? v.sealed : null,
    createdAt: num(v.createdAt),
    deployTx: text(v.deployTx, 128),
    status: v.status === "pending" ? "pending" : "confirmed",
    files,
  };
}

function parse(raw: string): CircleRecord[] {
  try {
    const data = JSON.parse(raw);
    const seen = new Set<string>();
    const list: CircleRecord[] = [];
    for (const item of Array.isArray(data?.circles) ? data.circles : []) {
      const circle = circleOf(item);
      if (!circle || seen.has(circle.id) || list.length >= MAX_CIRCLES) continue;
      seen.add(circle.id);
      list.push(circle);
    }
    return list;
  } catch {
    return [];
  }
}

function store(key: string, list: CircleRecord[]): CircleRecord[] {
  const kept = list.slice(0, MAX_CIRCLES);
  const raw = JSON.stringify({ v: 1, circles: kept });
  try {
    localStorage.setItem(key, raw);
  } catch {}
  cache.set(key, { raw, list: kept });
  return kept;
}

function migrate(scope: LibraryScope): CircleRecord[] | null {
  try {
    localStorage.removeItem(LEGACY_RECENT);
    const raw = localStorage.getItem(recentKey(scope));
    if (raw === null) return null;
    localStorage.removeItem(recentKey(scope));
    const ids = JSON.parse(raw);
    const seen = new Set<string>();
    return (Array.isArray(ids) ? ids : [])
      .filter((id): id is string => typeof id === "string" && CIRCLE_ID.test(id))
      .filter((id) => !seen.has(id) && !!seen.add(id))
      .map((id) => ({
        id,
        sealed: null,
        createdAt: 0,
        deployTx: "",
        status: "confirmed" as const,
        files: [],
      }));
  } catch {
    return null;
  }
}

export function readLibrary(scope: LibraryScope | null): CircleRecord[] {
  if (!scope) return EMPTY;
  const key = libraryKey(scope);
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(key);
  } catch {}
  const hit = cache.get(key);
  if (hit && hit.raw === raw) return hit.list;
  if (raw === null) {
    const carried = migrate(scope);
    if (carried?.length) return store(key, carried);
    cache.set(key, { raw: null, list: EMPTY });
    return EMPTY;
  }
  const list = parse(raw);
  cache.set(key, { raw, list });
  return list;
}

export function useLibrary(scope: LibraryScope | null): CircleRecord[] {
  return useSyncExternalStore(subscribe, () => readLibrary(scope));
}

function write(scope: LibraryScope, list: CircleRecord[]): void {
  store(libraryKey(scope), list);
  for (const l of listeners) l();
}

function change(
  scope: LibraryScope,
  id: string,
  fn: (circle: CircleRecord) => CircleRecord | null,
): void {
  const list = readLibrary(scope);
  if (!list.some((c) => c.id === id)) return;
  write(
    scope,
    list.flatMap((c) => {
      if (c.id !== id) return [c];
      const next = fn(c);
      return next ? [next] : [];
    }),
  );
}

export function addCircle(
  scope: LibraryScope,
  circle: Pick<CircleRecord, "id" | "sealed" | "deployTx" | "status"> & { createdAt?: number },
): void {
  if (!CIRCLE_ID.test(circle.id)) return;
  const list = readLibrary(scope);
  const old = list.find((c) => c.id === circle.id);
  write(scope, [
    {
      id: circle.id,
      sealed: circle.sealed,
      deployTx: circle.deployTx,
      status: circle.status,
      createdAt: circle.createdAt ?? Date.now(),
      files: old?.files ?? [],
    },
    ...list.filter((c) => c.id !== circle.id),
  ]);
}

export function updateCircle(
  scope: LibraryScope,
  id: string,
  patch: Partial<Pick<CircleRecord, "sealed" | "status">>,
): void {
  change(scope, id, (c) => ({ ...c, ...patch }));
}

export function removeCircle(scope: LibraryScope, id: string): void {
  change(scope, id, () => null);
}

const stamp = (f: FileStamp): FileStamp => ({
  size: f.size,
  type: f.type,
  at: f.at,
  tx: f.tx,
  ...(f.title ? { title: f.title } : {}),
});

export function putFile(
  scope: LibraryScope,
  id: string,
  file: FileStamp & { path: string; status: "confirmed" | "pending" },
): void {
  change(scope, id, (c) => {
    const old = c.files.find((f) => f.path === file.path);
    const prev = old?.status === "confirmed" ? stamp(old) : old?.prev;
    const title = file.title?.slice(0, MAX_TITLE);
    const next: CircleFile = {
      path: file.path,
      size: file.size,
      type: file.type,
      at: file.at,
      tx: file.tx,
      ...(title ? { title } : {}),
      status: file.status,
      ...(file.status === "pending" && prev ? { prev } : {}),
    };
    return {
      ...c,
      files: [next, ...c.files.filter((f) => f.path !== file.path)].slice(0, MAX_CIRCLE_FILES),
    };
  });
}

export function settleFile(
  scope: LibraryScope,
  id: string,
  path: string,
  tx: string,
  outcome: "confirmed" | "rejected",
): void {
  change(scope, id, (c) => ({
    ...c,
    files: c.files.flatMap((f): CircleFile[] => {
      if (f.path !== path || f.tx !== tx || f.status !== "pending") return [f];
      if (outcome === "confirmed") return [{ ...stamp(f), path, status: "confirmed" }];
      return f.prev ? [{ ...f.prev, path, status: "confirmed" }] : [];
    }),
  }));
}

export function circleTitle(circle: CircleRecord): string {
  const index = circle.files.find((f) => f.path === INDEX_PATH);
  if (!index) return "";
  return (index.status === "confirmed" ? index.title : index.prev?.title) ?? "";
}

export const circleBytes = (circle: CircleRecord) => circle.files.reduce((n, f) => n + f.size, 0);

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
};

export function pageTitle(bytes: Uint8Array, contentType: string): string {
  if (!/html/i.test(contentType)) return "";
  const head = new TextDecoder().decode(bytes.subarray(0, 65536));
  const hit = /<title[^>]*>([^<]*)<\/title>/i.exec(head);
  return (hit?.[1] ?? "")
    .replace(/&(?:amp|lt|gt|quot|#39);/g, (e) => ENTITIES[e])
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TITLE);
}

export function resetLibraryCache(): void {
  cache.clear();
}
