"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.INERT_QUERY = exports.INERT_GATE = exports.INERT_ERRORS = void 0;
exports.configureCellar = configureCellar;
exports.errorSink = errorSink;
exports.queryRuntime = queryRuntime;
exports.reactQueryRuntime = reactQueryRuntime;
exports.readGateRuntime = readGateRuntime;
exports.useReadGateFor = useReadGateFor;
var _once_guard = require("./diagnostics/once_guard.js");
/**
 * The three services the app provides to Cellar: where error reports go, the React Query runtime fetches run on,
 * and when a read is live. The app calls {@linkcode configureCellar} once at startup, before binding any store.
 * Until then each does nothing, so stores still read their rows and tests still render.
 */

/** The extra context sent with a Cellar error report, in Sentry's shape. */

/**
 * Where Cellar sends error reports. Shaped like Sentry's two capture calls, so the app can pass Sentry's directly.
 */

/** A React Query key built by Cellar: the store's query root, then the partition's key parts. */

/**
 * One partition's fetch, as Cellar passes it to the app's {@linkcode QueryRuntime.useQuery | useQuery}. The fields
 * are React Query's.
 */

/** The fields of a {@linkcode QueryRuntime.useQuery | useQuery} result Cellar reads. */

/**
 * The parts of React Query's {@linkcode QueryClient} Cellar uses for {@linkcode FetchIngest.prefetch | prefetch},
 * {@linkcode PartitionLifecycle.invalidate | invalidate}, {@linkcode PartitionLifecycle.refetch | refetch} and
 * {@linkcode PartitionLifecycle.forget | forget}.
 */

/**
 * The React Query runtime store fetches run on. The app passes its own hooks, which can add policy such as pausing on
 * blur.
 */

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

/**
 * The app's policy for when reads are live: a hook that gives each component the read gate it belongs to. A live read
 * is subscribed to its data and re-renders when it changes; a read that isn't live keeps its last value.
 */

/** The services the app provides to Cellar. */

const unconfigured = (0, _once_guard.createOnceGuard)();
function warnUnconfigured(what) {
  if (!__DEV__ || unconfigured.seen(what)) return;
  // eslint-disable-next-line no-console
  console.warn(`data_kernel.unconfigured: ${what} was used before \`configureCellar\` ran. Reads still answer from the rows ` + 'already stored, but nothing fetches. Call `configureCellar` during startup, before binding a store.');
}

/** An error sink that drops every report; the default until the app configures one. */
const INERT_ERRORS = exports.INERT_ERRORS = {
  captureException: () => {},
  captureMessage: () => {}
};
const IDLE = Object.freeze({
  isInitialLoading: false,
  isFetching: false,
  isError: false
});
const NO_STATUSES = Object.freeze([]);
const INERT_CLIENT = {
  fetchQuery: () => {
    warnUnconfigured('a partition prefetch');
    return Promise.reject(new Error('cellar: no query runtime is configured, so nothing can fetch'));
  },
  invalidateQueries: () => warnUnconfigured('a partition invalidation'),
  removeQueries: () => warnUnconfigured('a store forget')
};

/**
 * A query runtime that fetches nothing; the default until the app configures one. Its hooks still run, so stores
 * render and read their rows without breaking the rules of hooks.
 */
const INERT_QUERY = exports.INERT_QUERY = {
  client: () => INERT_CLIENT,
  useQuery: () => {
    warnUnconfigured('a partition prime');
    return IDLE;
  },
  useQueries: () => {
    warnUnconfigured('a multi-partition prime');
    return NO_STATUSES;
  }
};
const NO_UNSUBSCRIBE = () => {};

/**
 * A gate that is always live, the default when the app configures none, so every read stays subscribed. Frozen and
 * shared, since a gate must be the same object across renders.
 */
const ALWAYS_LIVE = Object.freeze({
  isLive: () => true,
  onChange: () => NO_UNSUBSCRIBE
});

/** A gate runtime whose reads are always live; the default until the app configures one. */
const INERT_GATE = exports.INERT_GATE = {
  useReadGate: () => ALWAYS_LIVE
};
let runtime = {
  errors: INERT_ERRORS,
  query: INERT_QUERY,
  gate: INERT_GATE
};

/**
 * The React Query hooks and client an app already has, as Cellar's {@linkcode QueryRuntime}. The hooks can be React
 * Query's own or the app's wrappers around them (focus-gated ones, say), with whatever generics they declare: Cellar
 * only ever calls them with a {@linkcode QuerySpec} and reads the {@linkcode QueryStatus} fields of what they return.
 */
function reactQueryRuntime(hooks) {
  return {
    // React Query's generics are wider than a `QuerySpec` in every position, so the shapes agree where Cellar uses them.
    client: hooks.client,
    useQuery: hooks.useQuery,
    useQueries: hooks.useQueries,
    bypassesGates: hooks.bypassesGates
  };
}

/**
 * Sets the services Cellar uses. Each part passed replaces the current one and the rest are kept, so the app can
 * configure them from different places, and a test can set one and leave the others as defaults.
 */
function configureCellar(next) {
  runtime = {
    errors: next.errors ?? runtime.errors,
    query: next.query ?? runtime.query,
    gate: next.gate ?? runtime.gate
  };
}

/** The configured error sink. */
function errorSink() {
  return runtime.errors;
}

/** The configured query runtime. */
function queryRuntime() {
  return runtime.query;
}

/** The configured read gate runtime. */
function readGateRuntime() {
  return runtime.gate;
}

/**
 * The read gate a hook follows: the app's, or one that is always live for a call that bypasses it. The app's hook runs
 * either way, so a call switching between the two keeps its hooks in the same order.
 */
function useReadGateFor(bypass) {
  const gate = runtime.gate.useReadGate();
  return bypass ? ALWAYS_LIVE : gate;
}

// Exported so the built declaration files keep these names in scope for the doc links above; an import that only a
// doc comment uses is dropped from them.
//# sourceMappingURL=runtime.js.map