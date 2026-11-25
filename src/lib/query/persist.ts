import { dehydrate, hydrate, type DehydratedState, type Query, type QueryClient } from "./core";

export interface PersistedClient {
  buster: string;
  timestamp: number;
  clientState: DehydratedState;
}

export interface PersistOptions {
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  key: string;
  buster: string;
  maxAge: number;
  shouldPersist?: (query: Query) => boolean;
  throttleMs?: number;
}

export function withoutOldestQuery(saved: PersistedClient): PersistedClient | undefined {
  const queries = [...saved.clientState.queries];
  if (!queries.length) return undefined;
  const oldest = queries.reduce((a, b) => (b.state.dataUpdatedAt < a.state.dataUpdatedAt ? b : a));
  queries.splice(queries.indexOf(oldest), 1);
  return { ...saved, clientState: { ...saved.clientState, queries } };
}

export function saveQueryClient(client: QueryClient, options: PersistOptions): void {
  let blob: PersistedClient | undefined = {
    buster: options.buster,
    timestamp: Date.now(),
    clientState: dehydrate(client, { shouldDehydrateQuery: options.shouldPersist }),
  };
  while (blob) {
    try {
      options.storage.setItem(options.key, JSON.stringify(blob));
      return;
    } catch {
      blob = withoutOldestQuery(blob);
    }
  }
}

export function restoreQueryClient(client: QueryClient, options: PersistOptions): void {
  let saved: PersistedClient | null = null;
  try {
    const raw = options.storage.getItem(options.key);
    saved = raw ? (JSON.parse(raw) as PersistedClient) : null;
  } catch {
    saved = null;
  }
  if (!saved) return;
  const expired = !saved.timestamp || Date.now() - saved.timestamp > options.maxAge;
  if (expired || saved.buster !== options.buster) {
    try {
      options.storage.removeItem(options.key);
    } catch {}
    return;
  }
  try {
    hydrate(client, saved.clientState);
  } catch {
    try {
      options.storage.removeItem(options.key);
    } catch {}
  }
}

export function persistQueryClient(client: QueryClient, options: PersistOptions): () => void {
  restoreQueryClient(client, options);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const unsubscribe = client.getQueryCache().subscribe(() => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      saveQueryClient(client, options);
    }, options.throttleMs ?? 1000);
  });
  return () => {
    unsubscribe();
    if (timer) clearTimeout(timer);
  };
}
