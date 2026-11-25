import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { QueryClient, QueryFilters, QueryOptions } from "./core";
import { QueryObserver, type QueryResult } from "./observer";

const ClientContext = createContext<QueryClient | null>(null);

export function QueryClientProvider({
  client,
  children,
}: {
  client: QueryClient;
  children?: ReactNode;
}) {
  // effect:audited - the client follows window focus while it is mounted
  useEffect(() => {
    client.mount();
    return () => client.unmount();
  }, [client]);
  return <ClientContext.Provider value={client}>{children}</ClientContext.Provider>;
}

export function useQueryClient(): QueryClient {
  const client = useContext(ClientContext);
  if (!client) throw new Error("No QueryClient set, use QueryClientProvider to set one");
  return client;
}

export type DefinedQueryResult<S> = QueryResult<S> & { data: S };

export function useQuery<T = unknown, S = T>(
  options: QueryOptions<T, S> & { initialData: T | (() => T) },
): DefinedQueryResult<S>;
export function useQuery<T = unknown, S = T>(options: QueryOptions<T, S>): QueryResult<S>;
export function useQuery<T = unknown, S = T>(options: QueryOptions<T, S>): QueryResult<S> {
  const client = useQueryClient();
  const [observer] = useState(() => new QueryObserver<T, S>(client, options));
  observer.setOptions(options);
  const result = useSyncExternalStore(observer.subscribe, observer.getResult, observer.getResult);
  // effect:audited - a changed key or a newly enabled query fetches after the render that asked for it
  useEffect(() => observer.sync());
  return result;
}

type DataOf<O> = O extends { select: (data: any) => infer S }
  ? S
  : O extends { queryFn: (...args: any[]) => infer R }
    ? Awaited<R>
    : unknown;

export function useQueries<const Q extends readonly QueryOptions<any, any>[]>({
  queries,
}: {
  queries: Q;
}): { -readonly [K in keyof Q]: QueryResult<DataOf<Q[K]>> } {
  const client = useQueryClient();
  const observers = useRef<QueryObserver<unknown, any>[]>([]);
  const list = observers.current;
  while (list.length < queries.length) list.push(new QueryObserver(client, queries[list.length]));
  queries.forEach((q, i) => list[i].setOptions(q));
  const shown = list.slice(0, queries.length);
  const last = useRef<QueryResult<any>[]>([]);
  const snapshot = () => {
    const next = shown.map((o) => o.getResult());
    const prev = last.current;
    if (prev.length === next.length && prev.every((r, i) => r === next[i])) return prev;
    last.current = next;
    return next;
  };
  const key = String(shown.length);
  const subscribe = useRef<{ key: string; fn: (cb: () => void) => () => void } | null>(null);
  if (!subscribe.current || subscribe.current.key !== key)
    subscribe.current = {
      key,
      fn: (cb) => {
        const offs = shown.map((o) => o.subscribe(cb));
        return () => offs.forEach((off) => off());
      },
    };
  const results = useSyncExternalStore(subscribe.current.fn, snapshot, snapshot);
  // effect:audited - same as useQuery, for each query in the list
  useEffect(() => shown.forEach((o) => o.sync()));
  return results as { -readonly [K in keyof Q]: QueryResult<DataOf<Q[K]>> };
}

export function useIsFetching(filters: QueryFilters = {}): number {
  const client = useQueryClient();
  const cache = client.getQueryCache();
  return useSyncExternalStore(
    (cb) => cache.subscribe(() => cb()),
    () => client.isFetching(filters),
    () => client.isFetching(filters),
  );
}
