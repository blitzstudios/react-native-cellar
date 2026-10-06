/**
 * The three services the app provides to Cellar: where error reports go, the React Query runtime fetches run on,
 * and when a read is live. The app calls {@linkcode configureCellar} once at startup, before binding any store.
 * Until then each does nothing, so stores still read their rows and tests still render.
 */

import { createOnceGuard } from './diagnostics/once_guard';
import type { FetchIngest } from './write/fetch_ingest';
import type { PartitionLifecycle } from './define_partitions';
import type { ReadCallOptions } from './read/surface';

/** The extra context sent with a Cellar error report, in Sentry's shape. */
export interface CaptureContext {
  /** Searchable tags, such as the store's name. */
  tags?: Record<string, string>;
  /** Sentry's grouping key: reports with the same fingerprint are collected into one issue. */
  fingerprint?: string[];
  /** Details attached to the report. */
  extra?: Record<string, unknown>;
}

/** A report's severity, lowest last: a lost benefit, an expected event, or advice to a developer. */
export type Severity = 'error' | 'info' | 'verbose';

/**
 * Where Cellar sends error reports. Shaped like Sentry's two capture calls, so the app can pass Sentry's directly.
 */
export interface ErrorSink {
  /** Reports an error. */
  captureException: (error: unknown, context: CaptureContext) => void;
  /** Reports a message that isn't an error, such as a one-time notice. */
  captureMessage: (
    message: string,
    context: CaptureContext & {
      /** `info`, or `debug` for a `verbose` report. */
      level: 'info' | 'debug';
    },
  ) => void;
  /** The lowest severity sent; `verbose` by default. */
  minSeverity?: Severity;
  /**
   * The chance an info-level report reaches {@linkcode ErrorSink.captureMessage | captureMessage}, from 0 to 1; 1 by
   * default. Info reports are expected events sent once per session, so across a large install base the same few arrive
   * from nearly every session, and a sample says as much. Errors are always sent.
   */
  infoSampleRate?: number;
}

/** A React Query key built by Cellar: the store's query root, then the partition's key parts. */
export type QueryKey = readonly (string | undefined)[];

/**
 * One partition's fetch, as Cellar passes it to the app's {@linkcode QueryRuntime.useQuery | useQuery}. The fields
 * are React Query's.
 */
export interface QuerySpec<T> {
  /** The partition's query key. */
  queryKey: QueryKey;
  /** Fetches the partition and writes its rows to the table, resolving with the new version and the rows written. */
  queryFn: () => Promise<T>;
  /** Whether the query may fetch; false while the read is disabled or its args don't name a partition yet. */
  enabled?: boolean;
  /** How long a fetched partition counts as fresh, in ms. */
  staleTime?: number;
  /** How long an unused query stays cached, in ms. */
  cacheTime?: number;
  /**
   * The result fields whose changes re-render the caller. Cellar passes
   * {@linkcode QueryStatus.isInitialLoading | isInitialLoading} and {@linkcode QueryStatus.isError | isError} only, so
   * a refetch starting and finishing doesn't re-render every reader of the partition; new rows re-render them through
   * the partition's version instead.
   */
  notifyOnChangeProps?: readonly string[];
  /** The `meta` the read's caller passed ({@linkcode ReadCallOptions.meta | meta}); absent otherwise. */
  meta?: Readonly<Record<string, unknown>>;
}

/** The fields of a {@linkcode QueryRuntime.useQuery | useQuery} result Cellar reads. */
export interface QueryStatus {
  /** Whether the first fetch is in flight and nothing has loaded yet. */
  isInitialLoading: boolean;
  /** Whether a fetch is in flight. */
  isFetching: boolean;
  /** Whether the last fetch failed. */
  isError: boolean;
}

/**
 * The parts of React Query's {@linkcode QueryClient} Cellar uses for {@linkcode FetchIngest.prefetch | prefetch},
 * {@linkcode PartitionLifecycle.invalidate | invalidate}, {@linkcode PartitionLifecycle.refetch | refetch} and
 * {@linkcode PartitionLifecycle.forget | forget}.
 */
export interface QueryClient {
  /** Fetches a query, or returns its cached result if still fresh. */
  fetchQuery: <T>(spec: Pick<QuerySpec<T>, 'queryKey' | 'queryFn' | 'staleTime' | 'cacheTime'>) => Promise<T>;
  /** Marks matching queries stale, refetching the ones in use. */
  invalidateQueries: (filters: {
    /** The key to match; queries whose key starts with it match, unless `exact`. */
    queryKey: QueryKey;
    /** Matches only a query with exactly this key. */
    exact?: boolean;
  }) => void;
  /** Removes matching queries from the cache. */
  removeQueries: (filters: {
    /** The key to match; queries whose key starts with it match. */
    queryKey: QueryKey;
  }) => void;
}

/**
 * The React Query runtime store fetches run on. The app passes its own hooks, which can add policy such as pausing on
 * blur.
 */
export interface QueryRuntime {
  /** Returns the query client. Called on each use, so the app can create the client after configuring Cellar. */
  client: () => QueryClient;
  /** React Query's {@linkcode QueryRuntime.useQuery | useQuery}, or a drop-in for it. */
  useQuery: <T>(spec: QuerySpec<T>) => QueryStatus;
  /** React Query's {@linkcode QueryRuntime.useQueries | useQueries}, or a drop-in for it. */
  useQueries: <T>(specs: {
    /** The queries to run. */
    queries: readonly QuerySpec<T>[];
  }) => readonly QueryStatus[];
  /**
   * Whether a read call's {@linkcode ReadCallOptions.meta | meta} marks it as one that must stay current while its
   * screen isn't live, for an app whose query hooks let such a query through their own gate (on screen focus, say).
   * A call it accepts ignores the read gate too. Unset, no call does.
   */
  bypassesGates?: (meta: Readonly<Record<string, unknown>>) => boolean;
}

/**
 * A read gate: tells the reads in one part of the app (typically one screen) whether they are live. A live read is
 * subscribed to its data: it recomputes and re-renders when a write changes what it read. A read that isn't live is
 * unsubscribed and keeps returning its last value, so a screen nobody is looking at does no work on writes; when the
 * gate turns live again, each read re-renders once if its data changed meanwhile. The app decides what makes a gate
 * not live, such as its screen being blurred or the app being in the background.
 *
 * It is a getter and a listener rather than a hook's return value, because it controls whether reads subscribe, not
 * whether they render: if a change in it re-rendered reads, every screen in the navigation stack would re-render on
 * each navigation.
 */
export interface ReadGate {
  /** Whether reads under this gate are live now: subscribed to their data, and re-rendering when it changes. */
  isLive: () => boolean;
  /**
   * Calls `listener` whenever {@linkcode ReadGate.isLive | isLive} changes, in either direction, and returns a function
   * that unsubscribes it. It must not re-render the component that subscribed; the reads resubscribe or unsubscribe
   * themselves.
   */
  onChange: (listener: () => void) => () => void;
}

/**
 * The app's policy for when reads are live: a hook that gives each component the read gate it belongs to. A live read
 * is subscribed to its data and re-renders when it changes; a read that isn't live keeps its last value.
 */
export interface ReadGateRuntime {
  /**
   * Returns the gate for the component calling it, typically its screen's, read from context. Must return the same
   * object for as long as that screen stays the same, since a read resubscribes whenever the gate object changes.
   */
  useReadGate: () => ReadGate;
}

/** The services the app provides to Cellar. */
export interface CellarRuntime {
  /** Where Cellar's error reports and notices go, such as Sentry. */
  errors: ErrorSink;
  /** The React Query hooks and client the stores' partition fetches run on. */
  query: QueryRuntime;
  /** The app's policy for when reads are live (subscribed to their data) and when they keep their last value. */
  gate: ReadGateRuntime;
}

const unconfigured = createOnceGuard();

function warnUnconfigured(what: string): void {
  if (!__DEV__ || unconfigured.seen(what)) return;
  // eslint-disable-next-line no-console
  console.warn(
    `data_kernel.unconfigured: ${what} was used before \`configureCellar\` ran. Reads still answer from the rows ` +
      'already stored, but nothing fetches. Call `configureCellar` during startup, before binding a store.',
  );
}

/** An error sink that drops every report; the default until the app configures one. */
export const INERT_ERRORS: ErrorSink = {
  captureException: () => {},
  captureMessage: () => {},
};

const IDLE: QueryStatus = Object.freeze({ isInitialLoading: false, isFetching: false, isError: false });
const NO_STATUSES: readonly QueryStatus[] = Object.freeze([]);

const INERT_CLIENT: QueryClient = {
  fetchQuery: () => {
    warnUnconfigured('a partition prefetch');
    return Promise.reject(new Error('cellar: no query runtime is configured, so nothing can fetch'));
  },
  invalidateQueries: () => warnUnconfigured('a partition invalidation'),
  removeQueries: () => warnUnconfigured('a store forget'),
};

/**
 * A query runtime that fetches nothing; the default until the app configures one. Its hooks still run, so stores
 * render and read their rows without breaking the rules of hooks.
 */
export const INERT_QUERY: QueryRuntime = {
  client: () => INERT_CLIENT,
  useQuery: () => {
    warnUnconfigured('a partition prime');
    return IDLE;
  },
  useQueries: () => {
    warnUnconfigured('a multi-partition prime');
    return NO_STATUSES;
  },
};

const NO_UNSUBSCRIBE = () => {};

/**
 * A gate that is always live, the default when the app configures none, so every read stays subscribed. Frozen and
 * shared, since a gate must be the same object across renders.
 */
const ALWAYS_LIVE: ReadGate = Object.freeze({
  isLive: () => true,
  onChange: () => NO_UNSUBSCRIBE,
});

/** A gate runtime whose reads are always live; the default until the app configures one. */
export const INERT_GATE: ReadGateRuntime = {
  useReadGate: () => ALWAYS_LIVE,
};

let runtime: CellarRuntime = { errors: INERT_ERRORS, query: INERT_QUERY, gate: INERT_GATE };

/**
 * The React Query hooks and client an app already has, as Cellar's {@linkcode QueryRuntime}. The hooks can be React
 * Query's own or the app's wrappers around them (focus-gated ones, say), with whatever generics they declare: Cellar
 * only ever calls them with a {@linkcode QuerySpec} and reads the {@linkcode QueryStatus} fields of what they return.
 */
export function reactQueryRuntime(hooks: {
  client: () => import('@tanstack/query-core').QueryClient;
  useQuery: (options: never) => QueryStatus;
  useQueries: (options: never) => readonly QueryStatus[];
  /** See {@linkcode QueryRuntime.bypassesGates}. */
  bypassesGates?: (meta: Readonly<Record<string, unknown>>) => boolean;
}): QueryRuntime {
  return {
    // React Query's generics are wider than a `QuerySpec` in every position, so the shapes agree where Cellar uses them.
    client: hooks.client as unknown as QueryRuntime['client'],
    useQuery: hooks.useQuery as unknown as QueryRuntime['useQuery'],
    useQueries: hooks.useQueries as unknown as QueryRuntime['useQueries'],
    bypassesGates: hooks.bypassesGates,
  };
}

/**
 * Sets the services Cellar uses. Each part passed replaces the current one and the rest are kept, so the app can
 * configure them from different places, and a test can set one and leave the others as defaults.
 */
export function configureCellar(next: Partial<CellarRuntime>): void {
  runtime = {
    errors: next.errors ?? runtime.errors,
    query: next.query ?? runtime.query,
    gate: next.gate ?? runtime.gate,
  };
}

/** The configured error sink. */
export function errorSink(): ErrorSink {
  return runtime.errors;
}

/** The configured query runtime. */
export function queryRuntime(): QueryRuntime {
  return runtime.query;
}

/** The configured read gate runtime. */
export function readGateRuntime(): ReadGateRuntime {
  return runtime.gate;
}

/**
 * The read gate a hook follows: the app's, or one that is always live for a call that bypasses it. The app's hook runs
 * either way, so a call switching between the two keeps its hooks in the same order.
 */
export function useReadGateFor(bypass: boolean | undefined): ReadGate {
  const gate = runtime.gate.useReadGate();
  return bypass ? ALWAYS_LIVE : gate;
}

// Exported so the built declaration files keep these names in scope for the doc links above; an import that only a
// doc comment uses is dropped from them.
export type { FetchIngest, PartitionLifecycle, ReadCallOptions };
