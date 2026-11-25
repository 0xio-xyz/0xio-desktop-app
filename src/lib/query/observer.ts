import {
  focusManager,
  notifyLater,
  replaceEqualDeep,
  skipToken,
  type FetchStatus,
  type Query,
  type QueryClient,
  type QueryObserverLike,
  type QueryOptions,
  type QueryStatus,
} from "./core";

export interface QueryResult<S = unknown> {
  data: S | undefined;
  error: unknown;
  status: QueryStatus;
  fetchStatus: FetchStatus;
  isPending: boolean;
  isLoading: boolean;
  isFetching: boolean;
  isRefetching: boolean;
  isSuccess: boolean;
  isError: boolean;
  isPlaceholderData: boolean;
  isFetched: boolean;
  isStale: boolean;
  dataUpdatedAt: number;
  errorUpdatedAt: number;
  failureCount: number;
  refetch: () => Promise<QueryResult<S>>;
}

function shallowSame(a: object, b: object): boolean {
  const ka = Object.keys(a) as (keyof typeof a)[];
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
}

export class QueryObserver<T = unknown, S = T> implements QueryObserverLike {
  private options!: QueryOptions<T, S>;
  query!: Query<T>;
  private listeners = new Set<() => void>();
  private result: QueryResult<S> | null = null;
  private lastDefined: Query<T> | undefined;
  private selected: { input: unknown; fn: unknown; output: S } | null = null;
  private interval: { ms: number; timer: ReturnType<typeof setInterval> } | null = null;
  private seen: { query: Query<T>; enabled: boolean } | null = null;

  constructor(
    private client: QueryClient,
    options: QueryOptions<T, S>,
  ) {
    this.subscribe = this.subscribe.bind(this);
    this.getResult = this.getResult.bind(this);
    this.refetch = this.refetch.bind(this);
    this.setOptions(options);
  }

  setOptions(options: QueryOptions<T, S>) {
    this.options = this.client.defaultQueryOptions(options);
    const next = this.client.getQueryCache().build<T>(this.options as QueryOptions<T, unknown>);
    if (next === this.query) return;
    if (this.query?.state.data !== undefined) this.lastDefined = this.query;
    if (this.listeners.size) {
      this.query?.removeObserver(this);
      next.addObserver(this);
    }
    this.query = next;
  }

  enabled(): boolean {
    return this.options.enabled !== false && this.options.queryFn !== skipToken;
  }

  gcTime(): number {
    return this.options.gcTime ?? 5 * 60_000;
  }

  stale(): boolean {
    return this.enabled() && this.query.isStale(this.options.staleTime ?? 0);
  }

  private willFetchOnMount(): boolean {
    if (!this.enabled()) return false;
    if (this.query.state.data === undefined) return true;
    const on = this.options.refetchOnMount ?? true;
    return on === "always" || (on && this.stale());
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    if (this.listeners.size === 1) {
      this.query.addObserver(this);
      this.seen = { query: this.query, enabled: this.enabled() };
      if (this.willFetchOnMount()) this.fetch();
      this.updateInterval();
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        this.query.removeObserver(this);
        this.clearInterval();
        this.seen = null;
      }
    };
  }

  sync() {
    if (!this.listeners.size || !this.seen) return;
    const changed = this.seen.query !== this.query || (!this.seen.enabled && this.enabled());
    this.seen = { query: this.query, enabled: this.enabled() };
    if (changed && this.enabled() && this.stale()) this.fetch();
    this.updateInterval();
  }

  private fetch(restart = false) {
    return this.query
      .fetch(this.options as QueryOptions<T, unknown>, restart)
      .catch(() => undefined);
  }

  refetch(): Promise<QueryResult<S>> {
    return this.fetch(true).then(() => this.getResult());
  }

  onFocus() {
    if (!this.enabled()) return;
    const on = this.options.refetchOnWindowFocus ?? true;
    if (on === "always" || (on && this.stale())) this.fetch();
  }

  onQueryUpdate() {
    this.updateInterval(true);
    const before = this.result;
    if (this.getResult() === before) return;
    notifyLater(() => this.listeners.forEach((fn) => fn()));
  }

  private intervalMs(): number | false {
    const v = this.options.refetchInterval;
    const ms = typeof v === "function" ? v(this.query) : v;
    return this.enabled() && typeof ms === "number" && ms > 0 && Number.isFinite(ms) ? ms : false;
  }

  /** Restarted on every change of the query, so readers of one query tick after its last read. */
  private updateInterval(restart = false) {
    if (!this.listeners.size) return;
    const ms = this.intervalMs();
    if (!restart && this.interval && this.interval.ms === ms) return;
    this.clearInterval();
    if (ms === false) return;
    this.interval = {
      ms,
      timer: setInterval(() => {
        if (this.options.refetchIntervalInBackground || focusManager.isFocused()) this.fetch();
      }, ms),
    };
  }

  private clearInterval() {
    if (this.interval) clearInterval(this.interval.timer);
    this.interval = null;
  }

  private select(data: T): S {
    const fn = this.options.select;
    if (!fn) return data as unknown as S;
    if (this.selected && this.selected.input === data && this.selected.fn === fn)
      return this.selected.output;
    const output = replaceEqualDeep(this.selected?.output, fn(data));
    this.selected = { input: data, fn, output };
    return output;
  }

  getResult(): QueryResult<S> {
    const query = this.query;
    const state = query.state;
    const o = this.options;
    let status = state.status;
    let fetchStatus = state.fetchStatus;
    if (!this.listeners.size && this.willFetchOnMount()) {
      fetchStatus = "fetching";
      if (state.data === undefined) status = "pending";
    }
    let data: S | undefined = state.data === undefined ? undefined : this.select(state.data);
    let isPlaceholderData = false;
    if (state.data === undefined && status === "pending" && o.placeholderData !== undefined) {
      const prev = this.lastDefined;
      const ph =
        typeof o.placeholderData === "function"
          ? (o.placeholderData as (d: T | undefined, q: Query<T> | undefined) => T | undefined)(
              prev?.state.data,
              prev,
            )
          : o.placeholderData;
      if (ph !== undefined) {
        status = "success";
        data = o.select ? o.select(ph) : (ph as unknown as S);
        isPlaceholderData = true;
      }
    }
    const isFetching = fetchStatus === "fetching";
    const isPending = status === "pending";
    const next: QueryResult<S> = {
      data,
      error: state.error,
      status,
      fetchStatus,
      isPending,
      isLoading: isPending && isFetching,
      isFetching,
      isRefetching: isFetching && !isPending,
      isSuccess: status === "success",
      isError: status === "error",
      isPlaceholderData,
      isFetched: state.dataUpdateCount + state.errorUpdateCount > 0,
      isStale: this.stale(),
      dataUpdatedAt: state.dataUpdatedAt,
      errorUpdatedAt: state.errorUpdatedAt,
      failureCount: state.fetchFailureCount,
      refetch: this.refetch as () => Promise<QueryResult<S>>,
    };
    if (this.result && shallowSame(this.result, next)) return this.result;
    this.result = next;
    return next;
  }
}
