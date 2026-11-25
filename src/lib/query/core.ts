export type QueryKey = readonly unknown[];
export type QueryStatus = "pending" | "error" | "success";
export type FetchStatus = "fetching" | "paused" | "idle";

export const skipToken = Symbol("skipToken");
export type SkipToken = typeof skipToken;

export interface QueryFunctionContext {
  queryKey: QueryKey;
  signal: AbortSignal;
}

export type QueryFunction<T = unknown> = (context: QueryFunctionContext) => T | Promise<T>;
export type RetryValue = boolean | number | ((failureCount: number, error: unknown) => boolean);
export type RetryDelayValue = number | ((failureCount: number, error: unknown) => number);

export interface QueryState<T = unknown> {
  data: T | undefined;
  dataUpdatedAt: number;
  dataUpdateCount: number;
  error: unknown;
  errorUpdatedAt: number;
  errorUpdateCount: number;
  fetchFailureCount: number;
  fetchFailureReason: unknown;
  status: QueryStatus;
  fetchStatus: FetchStatus;
  isInvalidated: boolean;
}

export interface QueryOptions<T = unknown, S = T> {
  queryKey: QueryKey;
  queryFn?: QueryFunction<T> | SkipToken;
  enabled?: boolean;
  staleTime?: number;
  gcTime?: number;
  retry?: RetryValue;
  retryDelay?: RetryDelayValue;
  refetchOnWindowFocus?: boolean | "always";
  refetchOnMount?: boolean | "always";
  refetchInterval?: number | false | ((query: Query<T>) => number | false | undefined);
  refetchIntervalInBackground?: boolean;
  initialData?: T | (() => T | undefined);
  initialDataUpdatedAt?: number | (() => number | undefined);
  placeholderData?:
    | NoInfer<T>
    | ((
        previousData: NoInfer<T> | undefined,
        previousQuery: Query<NoInfer<T>> | undefined,
      ) => NoInfer<T> | undefined);
  select?: (data: T) => S;
  structuralSharing?: boolean;
}

export interface QueryFilters {
  queryKey?: QueryKey;
  exact?: boolean;
  predicate?: (query: Query) => boolean;
  type?: "all" | "active" | "inactive";
  stale?: boolean;
  fetchStatus?: FetchStatus;
}

export interface InvalidateFilters extends QueryFilters {
  refetchType?: "all" | "active" | "inactive" | "none";
}

export interface DefaultOptions {
  queries?: Partial<
    Omit<QueryOptions, "queryKey" | "queryFn" | "select" | "initialData" | "placeholderData">
  >;
  mutations?: { gcTime?: number };
}

const DEFAULT_GC_TIME = 5 * 60_000;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (Object.prototype.toString.call(value) !== "[object Object]") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
}

export function hashKey(queryKey: QueryKey): string {
  return JSON.stringify(queryKey, (_, value) =>
    isPlainObject(value)
      ? Object.keys(value)
          .sort()
          .reduce<Record<string, unknown>>((out, k) => {
            out[k] = value[k];
            return out;
          }, {})
      : value,
  );
}

export function partialMatchKey(key: unknown, part: unknown): boolean {
  if (key === part) return true;
  if (typeof key !== typeof part) return false;
  if (key && part && typeof key === "object" && typeof part === "object") {
    return Object.keys(part).every((k) =>
      partialMatchKey((key as Record<string, unknown>)[k], (part as Record<string, unknown>)[k]),
    );
  }
  return false;
}

/** Returns `prev` (or its unchanged parts) wherever `next` is deeply equal, so renders keep identity. */
export function replaceEqualDeep<T>(prev: unknown, next: T): T {
  if (prev === next) return prev as T;
  const array = Array.isArray(prev) && Array.isArray(next);
  if (!array && !(isPlainObject(prev) && isPlainObject(next))) return next;
  const a = prev as Record<string, unknown>;
  const b = next as Record<string, unknown>;
  const aKeys = array ? (prev as unknown[]).map((_, i) => String(i)) : Object.keys(a);
  const bKeys = array ? (next as unknown[]).map((_, i) => String(i)) : Object.keys(b);
  const copy: Record<string, unknown> | unknown[] = array ? [] : {};
  let same = 0;
  for (const k of bKeys) {
    const value = replaceEqualDeep(a[k], b[k]);
    (copy as Record<string, unknown>)[k] = value;
    if (value === a[k] && (a[k] !== undefined || Object.prototype.hasOwnProperty.call(a, k)))
      same++;
  }
  return (aKeys.length === bKeys.length && same === aKeys.length ? prev : copy) as T;
}

let pending: (() => void)[] = [];
/** Listener calls wait for the end of the current task, so nothing renders mid-render. */
export function notifyLater(fn: () => void) {
  pending.push(fn);
  if (pending.length > 1) return;
  queueMicrotask(() => {
    const run = pending;
    pending = [];
    for (const f of run) f();
  });
}

type FocusSetup = (setFocused: (focused?: boolean) => void) => (() => void) | void;

class FocusManager {
  private focused: boolean | undefined;
  private listeners = new Set<(focused: boolean) => void>();
  private cleanup: (() => void) | void = undefined;
  private setup: FocusSetup = (setFocused) => {
    if (typeof document === "undefined") return;
    const onChange = () => setFocused();
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  };

  subscribe(fn: (focused: boolean) => void): () => void {
    this.listeners.add(fn);
    if (this.listeners.size === 1) this.cleanup = this.setup((f) => this.setFocused(f));
    return () => {
      this.listeners.delete(fn);
      if (this.listeners.size === 0) {
        this.cleanup?.();
        this.cleanup = undefined;
      }
    };
  }

  setEventListener(setup: FocusSetup) {
    this.setup = setup;
    this.cleanup?.();
    this.cleanup = this.listeners.size ? setup((f) => this.setFocused(f)) : undefined;
  }

  setFocused(focused?: boolean) {
    if (this.focused === focused) return;
    this.focused = focused;
    const now = this.isFocused();
    this.listeners.forEach((fn) => fn(now));
  }

  isFocused(): boolean {
    if (typeof this.focused === "boolean") return this.focused;
    return typeof document === "undefined" || document.visibilityState !== "hidden";
  }
}

export const focusManager = new FocusManager();

export interface QueryObserverLike {
  enabled(): boolean;
  gcTime(): number;
  onQueryUpdate(): void;
  onFocus(): void;
  stale(): boolean;
}

function resolve<T, A extends unknown[]>(value: T | ((...args: A) => T), ...args: A): T {
  return typeof value === "function" ? (value as (...a: A) => T)(...args) : value;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Query<T = unknown> {
  readonly queryKey: QueryKey;
  readonly queryHash: string;
  options: QueryOptions<T, unknown>;
  state: QueryState<T>;
  private observers: QueryObserverLike[] = [];
  private gcTimer: ReturnType<typeof setTimeout> | undefined;
  private run: { id: number; promise: Promise<T>; abort: AbortController } | null = null;
  private runs = 0;

  constructor(
    private cache: QueryCache,
    options: QueryOptions<T, unknown>,
    state?: QueryState<T>,
  ) {
    this.queryKey = options.queryKey;
    this.queryHash = hashKey(options.queryKey);
    this.options = options;
    this.state = state ?? Query.initialState(options);
    this.scheduleGc();
  }

  static initialState<T>(options: QueryOptions<T, unknown>): QueryState<T> {
    const data = options.initialData === undefined ? undefined : resolve(options.initialData);
    const has = data !== undefined;
    const at =
      options.initialDataUpdatedAt === undefined
        ? undefined
        : resolve(options.initialDataUpdatedAt);
    return {
      data,
      dataUpdatedAt: has ? (at ?? Date.now()) : 0,
      dataUpdateCount: 0,
      error: null,
      errorUpdatedAt: 0,
      errorUpdateCount: 0,
      fetchFailureCount: 0,
      fetchFailureReason: null,
      status: has ? "success" : "pending",
      fetchStatus: "idle",
      isInvalidated: false,
    };
  }

  setOptions(options: QueryOptions<T, unknown>) {
    this.options = { ...this.options, ...options };
  }

  private dispatch(patch: Partial<QueryState<T>>) {
    this.state = { ...this.state, ...patch };
    this.observers.forEach((o) => o.onQueryUpdate());
    this.cache.notify({ type: "updated", query: this as Query });
  }

  getObserversCount(): number {
    return this.observers.length;
  }

  addObserver(o: QueryObserverLike) {
    if (this.observers.includes(o)) return;
    this.observers.push(o);
    clearTimeout(this.gcTimer);
    this.cache.notify({ type: "observerAdded", query: this as Query });
  }

  removeObserver(o: QueryObserverLike) {
    if (!this.observers.includes(o)) return;
    this.observers = this.observers.filter((x) => x !== o);
    this.scheduleGc();
    this.cache.notify({ type: "observerRemoved", query: this as Query });
  }

  isActive(): boolean {
    return this.observers.some((o) => o.enabled());
  }

  isDisabled(): boolean {
    if (this.observers.length > 0) return !this.isActive();
    return (
      this.options.queryFn === skipToken ||
      this.state.dataUpdateCount + this.state.errorUpdateCount === 0
    );
  }

  isStale(staleTime = 0): boolean {
    if (this.state.data === undefined || this.state.isInvalidated) return true;
    return this.state.dataUpdatedAt + staleTime <= Date.now();
  }

  isStaleByObservers(): boolean {
    if (this.observers.length > 0) return this.observers.some((o) => o.stale());
    return this.state.data === undefined || this.state.isInvalidated;
  }

  onFocus() {
    this.observers.forEach((o) => o.onFocus());
  }

  private gcTime(): number {
    const own = this.options.gcTime ?? DEFAULT_GC_TIME;
    return Math.max(own, ...this.observers.map((o) => o.gcTime()));
  }

  private scheduleGc() {
    clearTimeout(this.gcTimer);
    const time = this.gcTime();
    if (!Number.isFinite(time)) return;
    this.gcTimer = setTimeout(
      () => {
        if (this.observers.length === 0 && this.state.fetchStatus === "idle")
          this.cache.remove(this as Query);
      },
      Math.max(time, 0),
    );
  }

  setData(data: T, updatedAt?: number, manual = true): T {
    const next =
      this.options.structuralSharing === false ? data : replaceEqualDeep(this.state.data, data);
    this.dispatch({
      data: next,
      dataUpdateCount: this.state.dataUpdateCount + 1,
      dataUpdatedAt: updatedAt ?? Date.now(),
      error: null,
      isInvalidated: false,
      status: "success",
      ...(manual ? {} : { fetchStatus: "idle", fetchFailureCount: 0, fetchFailureReason: null }),
    });
    return next;
  }

  invalidate() {
    if (!this.state.isInvalidated) this.dispatch({ isInvalidated: true });
  }

  isFetching(): boolean {
    return this.state.fetchStatus === "fetching";
  }

  cancel() {
    if (!this.run) return;
    this.run.abort.abort();
    this.run = null;
    this.dispatch({ fetchStatus: "idle" });
  }

  destroy() {
    clearTimeout(this.gcTimer);
    this.run?.abort.abort();
    this.run = null;
  }

  /** One fetch at a time: a second call shares it, unless it asks to start over and data exists. */
  fetch(options?: QueryOptions<T, unknown>, restart = false): Promise<T> {
    if (options) this.setOptions(options);
    if (this.run) {
      if (!(restart && this.state.data !== undefined)) return this.run.promise;
      this.run.abort.abort();
    }
    const fn = this.options.queryFn;
    if (!fn || fn === skipToken) {
      return this.state.data !== undefined
        ? Promise.resolve(this.state.data)
        : Promise.reject(new Error(`Missing queryFn: '${this.queryHash}'`));
    }
    const id = ++this.runs;
    const abort = new AbortController();
    const current = () => this.run?.id === id;
    const attempt = async (): Promise<T> => {
      let failures = 0;
      for (;;) {
        try {
          const data = await fn({ queryKey: this.queryKey, signal: abort.signal });
          if (data === undefined) throw new Error(`${this.queryHash} data is undefined`);
          return data;
        } catch (error) {
          if (!current()) throw error;
          const retry = this.options.retry ?? 3;
          const again =
            retry === true ||
            (typeof retry === "number" && failures < retry) ||
            (typeof retry === "function" && retry(failures, error));
          if (!again) throw error;
          const delayOpt = this.options.retryDelay;
          const delay =
            delayOpt === undefined
              ? Math.min(1000 * 2 ** failures, 30_000)
              : typeof delayOpt === "function"
                ? delayOpt(failures, error)
                : delayOpt;
          failures++;
          this.dispatch({ fetchFailureCount: failures, fetchFailureReason: error });
          await sleep(delay);
          if (!current()) throw error;
        }
      }
    };
    const run = { id, abort, promise: undefined as unknown as Promise<T> };
    this.run = run;
    this.dispatch({
      fetchStatus: "fetching",
      fetchFailureCount: 0,
      fetchFailureReason: null,
      ...(this.state.data === undefined ? { error: null, status: "pending" as const } : {}),
    });
    run.promise = attempt().then(
      (data) => {
        if (!current()) return this.state.data as T;
        this.run = null;
        const kept = this.setData(data, undefined, false);
        this.scheduleGc();
        return kept;
      },
      (error) => {
        if (!current()) throw error;
        this.run = null;
        this.dispatch({
          error,
          errorUpdateCount: this.state.errorUpdateCount + 1,
          errorUpdatedAt: Date.now(),
          fetchFailureCount: this.state.fetchFailureCount + 1,
          fetchFailureReason: error,
          fetchStatus: "idle",
          status: "error",
        });
        this.scheduleGc();
        throw error;
      },
    );
    return run.promise;
  }
}

export type QueryCacheEvent = {
  type: "added" | "removed" | "updated" | "observerAdded" | "observerRemoved";
  query: Query;
};

export function matchQuery(filters: QueryFilters, query: Query): boolean {
  const { queryKey, exact, predicate, type = "all", stale, fetchStatus } = filters;
  if (queryKey) {
    if (exact ? query.queryHash !== hashKey(queryKey) : !partialMatchKey(query.queryKey, queryKey))
      return false;
  }
  if (type !== "all") {
    const active = query.isActive();
    if (type === "active" ? !active : active) return false;
  }
  if (typeof stale === "boolean" && query.isStaleByObservers() !== stale) return false;
  if (fetchStatus && fetchStatus !== query.state.fetchStatus) return false;
  if (predicate && !predicate(query)) return false;
  return true;
}

export class QueryCache {
  private queries = new Map<string, Query>();
  private listeners = new Set<(event: QueryCacheEvent) => void>();

  build<T>(options: QueryOptions<T, unknown>, state?: QueryState<T>): Query<T> {
    const hash = hashKey(options.queryKey);
    let query = this.queries.get(hash) as Query<T> | undefined;
    if (!query) {
      query = new Query<T>(this, options, state);
      this.queries.set(hash, query as Query);
      this.notify({ type: "added", query: query as Query });
    }
    return query;
  }

  get<T = unknown>(hash: string): Query<T> | undefined {
    return this.queries.get(hash) as Query<T> | undefined;
  }

  getAll(): Query[] {
    return [...this.queries.values()];
  }

  find<T = unknown>(filters: QueryFilters): Query<T> | undefined {
    return this.getAll().find((q) => matchQuery({ exact: true, ...filters }, q)) as
      | Query<T>
      | undefined;
  }

  findAll(filters: QueryFilters = {}): Query[] {
    return this.getAll().filter((q) => matchQuery(filters, q));
  }

  remove(query: Query) {
    if (this.queries.get(query.queryHash) !== query) return;
    query.destroy();
    this.queries.delete(query.queryHash);
    this.notify({ type: "removed", query });
  }

  clear() {
    this.getAll().forEach((q) => this.remove(q));
  }

  subscribe(listener: (event: QueryCacheEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  notify(event: QueryCacheEvent) {
    if (this.listeners.size === 0) return;
    notifyLater(() => this.listeners.forEach((fn) => fn(event)));
  }

  onFocus() {
    this.getAll().forEach((q) => q.onFocus());
  }
}

export class QueryClient {
  private cache: QueryCache;
  private defaults: DefaultOptions;
  private mounts = 0;
  private unfocus: (() => void) | undefined;

  constructor(config: { defaultOptions?: DefaultOptions; queryCache?: QueryCache } = {}) {
    this.cache = config.queryCache ?? new QueryCache();
    this.defaults = config.defaultOptions ?? {};
  }

  mount() {
    if (++this.mounts !== 1) return;
    this.unfocus = focusManager.subscribe((focused) => {
      if (focused) this.cache.onFocus();
    });
  }

  unmount() {
    if (--this.mounts !== 0) return;
    this.unfocus?.();
    this.unfocus = undefined;
  }

  getQueryCache(): QueryCache {
    return this.cache;
  }

  getDefaultOptions(): DefaultOptions {
    return this.defaults;
  }

  defaultQueryOptions<T, S>(options: QueryOptions<T, S>): QueryOptions<T, S> {
    return { ...(this.defaults.queries as Partial<QueryOptions<T, S>>), ...options };
  }

  getQueryData<T = unknown>(queryKey: QueryKey): T | undefined {
    return this.cache.get<T>(hashKey(queryKey))?.state.data;
  }

  getQueryState<T = unknown>(queryKey: QueryKey): QueryState<T> | undefined {
    return this.cache.get<T>(hashKey(queryKey))?.state;
  }

  getQueriesData<T = unknown>(filters: QueryFilters): [QueryKey, T | undefined][] {
    return this.cache.findAll(filters).map((q) => [q.queryKey, q.state.data as T | undefined]);
  }

  setQueryData<T = unknown>(
    queryKey: QueryKey,
    updater: T | undefined | ((old: T | undefined) => T | undefined),
    options?: { updatedAt?: number },
  ): T | undefined {
    const existing = this.cache.get<T>(hashKey(queryKey));
    const data =
      typeof updater === "function"
        ? (updater as (old: T | undefined) => T | undefined)(existing?.state.data)
        : updater;
    if (data === undefined) return undefined;
    const query = existing ?? this.cache.build<T>(this.defaultQueryOptions({ queryKey }));
    return query.setData(data, options?.updatedAt);
  }

  isFetching(filters: QueryFilters = {}): number {
    return this.cache.findAll({ ...filters, fetchStatus: "fetching" }).length;
  }

  removeQueries(filters: QueryFilters = {}) {
    this.cache.findAll(filters).forEach((q) => this.cache.remove(q));
  }

  cancelQueries(filters: QueryFilters = {}): Promise<void> {
    this.cache.findAll(filters).forEach((q) => q.cancel());
    return Promise.resolve();
  }

  invalidateQueries(filters: InvalidateFilters = {}): Promise<void> {
    this.cache.findAll(filters).forEach((q) => q.invalidate());
    const type = filters.refetchType ?? filters.type ?? "active";
    if (type === "none") return Promise.resolve();
    return this.refetchQueries({ ...filters, type });
  }

  refetchQueries(filters: QueryFilters = {}): Promise<void> {
    const runs = this.cache
      .findAll(filters)
      .filter((q) => !q.isDisabled())
      .map((q) => q.fetch(undefined, true).catch(() => undefined));
    return Promise.all(runs).then(() => undefined);
  }

  fetchQuery<T>(options: QueryOptions<T, unknown>): Promise<T> {
    const defaulted = this.defaultQueryOptions({ retry: false, ...options });
    const query = this.cache.build<T>(defaulted);
    return query.isStale(defaulted.staleTime ?? 0)
      ? query.fetch(defaulted)
      : Promise.resolve(query.state.data as T);
  }

  clear() {
    this.cache.clear();
  }
}

export interface DehydratedQuery {
  queryKey: QueryKey;
  queryHash: string;
  state: QueryState;
}

export interface DehydratedState {
  mutations: unknown[];
  queries: DehydratedQuery[];
}

export function defaultShouldDehydrateQuery(query: { state: { status: QueryStatus } }): boolean {
  return query.state.status === "success";
}

export function dehydrate(
  client: QueryClient,
  options: { shouldDehydrateQuery?: (query: Query) => boolean } = {},
): DehydratedState {
  const keep = options.shouldDehydrateQuery ?? defaultShouldDehydrateQuery;
  return {
    mutations: [],
    queries: client
      .getQueryCache()
      .getAll()
      .filter((q) => keep(q))
      .map((q) => ({ queryKey: q.queryKey, queryHash: q.queryHash, state: q.state })),
  };
}

export function hydrate(client: QueryClient, state: DehydratedState | undefined) {
  if (!state || !Array.isArray(state.queries)) return;
  const cache = client.getQueryCache();
  for (const d of state.queries) {
    if (!Array.isArray(d.queryKey) || !d.state) continue;
    const restored: QueryState = {
      ...Query.initialState({ queryKey: d.queryKey }),
      ...d.state,
      fetchStatus: "idle",
    };
    const existing = cache.get(hashKey(d.queryKey));
    if (existing) {
      if (existing.state.dataUpdatedAt < restored.dataUpdatedAt && restored.data !== undefined)
        existing.setData(restored.data, restored.dataUpdatedAt);
      continue;
    }
    cache.build(client.defaultQueryOptions({ queryKey: d.queryKey }), restored);
  }
}
