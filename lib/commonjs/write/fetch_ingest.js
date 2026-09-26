"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.RAW_TEXT_RESPONSE_TRANSFORM = void 0;
exports.createFetchIngest = createFetchIngest;
var _react = require("react");
var _args_key = require("../args_key.js");
var _version_atom = require("../reactivity/version_atom.js");
var _ingest_timing = require("../diagnostics/ingest_timing.js");
var _once_guard = require("../diagnostics/once_guard.js");
var _telemetry = require("../diagnostics/telemetry.js");
var _runtime = require("../runtime.js");
var _change_set = require("../table/change_set.js");
/**
 * The fetch ingest: how a store fetches a partition (the set of rows one fetch returns and replaces) and writes the
 * response. There is one React Query query per partition. Its query function sends the partition's stored ETag, writes
 * the response body as the partition's rows (with the native shredder or the store's
 * {@linkcode PartitionFetchSpec.parse | parse}), stores the new ETag, and bumps the partition's version with the
 * write's change set, which re-renders the readers of the changed entities.
 */

/**
 * What a change in the fetch's state is allowed to repaint a reader for. Deliberately short of every field
 * {@linkcode PrimeState} carries: {@linkcode PrimeState.isFetching | isFetching} is left out.
 *
 * {@linkcode PrimeState.isFetching | isFetching} toggles twice on every fetch, and each toggle wakes every reader
 * primed on that partition — hundreds of them across the app, for a flag that says only that a refresh is in flight.
 * What it does not say is that anything changed; the rows arriving is a version bump, and that is what repaints a read.
 * So this leaves it unobserved rather than unavailable: {@linkcode DataResult.isFetching | result.isFetching} is still
 * read fresh at render, it just no longer causes a render of its own. The first load stays reactive, since
 * {@linkcode PrimeState.isInitialLoading | isInitialLoading} covers exactly the case of a fetch in flight with nothing
 * yet to show.
 */
const NOTIFY_ON_PRIME_STATE = ['isInitialLoading', 'isError'];

/** What a partition's request resolves to: the response body, its ETag, and whether the server answered 304. */

/**
 * A partition's request, described but not run, as a partition's {@linkcode PartitionFetchSpec.query | fetch.query}
 * returns it. Cellar runs it as the query function of the partition's React Query query, with these timings.
 */

/**
 * How {@linkcode createFetchIngest} fetches and writes a store's partitions (a partition is the set of rows one fetch
 * returns and replaces). {@linkcode definePartitions} builds this from a store's
 * {@linkcode PartitionsConfig.fetch | fetch} spec.
 */

/**
 * An axios `transformResponse` that returns the response body unchanged, so it stays the unparsed JSON text. Pass it
 * in a partition's request: our axios (0.15.3) otherwise parses every string body as JSON, whatever `responseType`
 * says, and the native shredder needs the text.
 */
const RAW_TEXT_RESPONSE_TRANSFORM = exports.RAW_TEXT_RESPONSE_TRANSFORM = [data => data];
function coerceRawJson(data) {
  if (typeof data === 'string') return data;
  return data != null ? JSON.stringify(data) : undefined;
}

/**
 * {@linkcode IngestTiming.rows | rows} on a recorded ingest that shredded nothing because the body matched the one
 * already shredded.
 */
const ROWS_UNCHANGED = -2;

/**
 * How many partitions' body fingerprints to keep. Far above the number a session addresses, so the bound only exists
 * so a long session cannot grow this without limit.
 */
const FINGERPRINT_CAPACITY = 512;

/** A body, as two independent 32-bit hashes and its length — 96 bits, so a false match is not a practical concern. */

/**
 * Fingerprints a body without allocating, in one pass, as djb2 and sdbm — two polynomial hashes whose bases (33 and
 * 65599) are far enough apart to fail independently.
 *
 * Both are shift-and-add rather than `Math.imul`, which is what keeps this affordable: the multiplies, not the walk,
 * were most of the cost. Measured on Hermes over a 1.5M-character body, hashing adds 8.8ms to a 31.5ms traversal that
 * no JS fingerprint can avoid, against 34.9ms for a pair using `imul`.
 */
function fingerprintOf(body) {
  const length = body.length;
  let djb = 5381;
  let sdbm = 0;
  for (let index = 0; index < length; index += 1) {
    const code = body.charCodeAt(index);
    djb = (djb << 5) + djb + code | 0;
    sdbm = code + (sdbm << 6) + (sdbm << 16) - sdbm | 0;
  }
  return {
    length,
    djb: djb >>> 0,
    sdbm: sdbm >>> 0
  };
}
function sameBody(left, right) {
  return !!left && left.length === right.length && left.djb === right.djb && left.sdbm === right.sdbm;
}

/**
 * A store's fetching, as {@linkcode createFetchIngest} creates it: the hooks reads use to fetch their partitions, and
 * the imperative fetches {@linkcode definePartitions} publishes as the store's
 * {@linkcode Partitions.lifecycle | lifecycle}. A partition is the set of rows one fetch returns and replaces; each has
 * one React Query query.
 */

/**
 * The timings for a hook holding its position while addressing nothing: no keys at all, rather than keys carrying
 * `undefined`.
 *
 * React Query reads `staleTime` off the observer with a `= 0` default, and `defaultQueryOptions` merges by spread, so
 * a key that is *present* and `undefined` overrides the client's configured default and lands on 0 — data is stale the
 * moment it arrives. Omitting the key lets the default stand. A store's partition has real timings whether or not a
 * given caller is enabled, so `timingsFor` is asked for them either way and this is only for an absent key.
 */
const NO_TIMINGS = {};

/**
 * Above this, one partition landing is worth knowing about. Priming is by partition and a read of a slice pays for
 * the whole of it, so these are sized to catch a partition big enough that serving a handful of rows out of it is a
 * bad trade — not to accuse it of being one, which only the call site knows. Tune them here rather than at a site.
 */
/** What a caller fetching a partition intends to do with it, which decides whether a very large fetch is reported. */

const OVERSIZED_PRIME_ROWS = 5_000;
const OVERSIZED_PRIME_CHARS = 2_000_000;
const oversizedPrimeReported = (0, _once_guard.createOnceGuard)();

/**
 * Files an oversized partition ingest, once per partition per session.
 *
 * This is the only thing that notices, deliberately. Priming stays automatic and unremarked, because that is the whole
 * point of the layer and because a declaration cannot answer this anyway: whether fetching a partition to serve a slice
 * is worth it depends on who is calling and what else they hold, and a read has no view of either. Nor could a static
 * answer stay true — a partition small enough to ignore when the read was written may not be next season.
 *
 * So nobody declares anything and the ingest reports what it actually cost. `info`, not `error`: a large partition is
 * not a fault, and the store may well mean it.
 *
 * It reports only where the advice applies: a read that selects a slice. A partition somebody asked for outright — a
 * prime hook, or a read whose args only name the partition — cost what it was asked for, and reporting it
 * taught the reader to ignore the channel. An app priming its own sports at startup is the case that made this
 * necessary.
 */
function reportOversizedPrime(store, partition, rows, chars, wantedWhole) {
  // Somebody asked for this partition outright — a prime hook, or a read that selects all of it. The rows are what
  // they asked for, and `prime: false` is not advice that applies, so there is nothing to say.
  if (wantedWhole) return;
  if (rows < OVERSIZED_PRIME_ROWS && (chars ?? 0) < OVERSIZED_PRIME_CHARS) return;
  if (oversizedPrimeReported.seen(store, partition)) return;
  (0, _telemetry.reportStoreDegradation)({
    scope: `${store}.oversized_prime.${partition}`,
    context: `priming the '${partition}' partition landed ${rows} rows / ${chars ?? 0} chars. Priming is by partition, so ` + 'every read of this partition pays this whether it selects one row or all of them. If the reads here want a ' + 'slice, check whether the payload that named those rows already carries what they render, and declare ' + '`prime: false` on the read if so.',
    severity: 'info',
    extra: {
      store,
      partition,
      rows,
      chars
    }
  });
}

/**
 * Creates a store's fetching: one React Query query per partition (the set of rows one fetch returns and replaces). Its
 * query function sends the partition's stored ETag; on a 304, keeps the rows; otherwise writes the body with
 * {@linkcode FetchIngestConfig.ingestRaw | ingestRaw}, stores the new ETag, and bumps the partition's version with the
 * write's change set, so the readers of the changed entities re-render. {@linkcode definePartitions} creates it from a
 * store's {@linkcode PartitionsConfig.fetch | fetch} spec, so a store declares that spec rather than calling this.
 */
function createFetchIngest(cfg) {
  /** The body each partition last shredded, so a refetch that brings the same one back can stop before it does. */
  const ingestedBodies = new Map();
  /**
   * Partitions some caller has asked for whole, which is what decides whether an oversized ingest is worth reporting.
   * Set during the priming hook rather than counted across mounts: the report fires once per partition per session,
   * so the question is only ever whether such a caller has existed, and a refcount would cost an effect per read.
   */
  const wantedWhole = new Set();
  /**
   * Whether an identical body has to be *detected* rather than simply shredded again, which is what decides if every
   * body is worth hashing. Only a store taking concurrent socket writes can be harmed by re-shredding one: the body
   * is older than any delta that landed since, so replacing the rows with it undoes them. Without that write path the
   * cost of missing the case is a repaint, which does not pay for a pass over every character of every body.
   */
  const detectsUnchangedBodies = !!cfg.holdWrites;
  const queryKey = parts => [cfg.ingestKeyRoot, ...parts];
  const bump = (key, parts, changes) => cfg.bump ? cfg.bump(key, changes) : cfg.version.bump(parts, changes);
  const runIngest = async key => {
    const release = cfg.holdWrites?.(key);
    try {
      return await fetchAndIngest(key);
    } finally {
      release?.();
    }
  };
  const fetchAndIngest = async key => {
    const parts = cfg.toParts(key);
    const etag = cfg.getEtag(key);
    const startedAt = Date.now();
    const res = await cfg.rawQuery(key, etag).queryFn();
    const fetchedAt = Date.now();
    const recordTiming = (rows, chars) => {
      const at = Date.now();
      const partition = (0, _args_key.partitionLabel)(parts);
      (0, _ingest_timing.recordIngestTiming)({
        store: cfg.ingestKeyRoot,
        partition,
        fetchMs: fetchedAt - startedAt,
        ingestMs: at - fetchedAt,
        chars,
        rows,
        at
      });
      // A 304 and an unchanged body report negative rows and shredded nothing, so neither is a prime worth flagging.
      if (rows > 0) reportOversizedPrime(cfg.ingestKeyRoot, partition, rows, chars, wantedWhole.has(partition));
    };
    if (res?.__etagMatch) {
      // `-1` distinguishes a 304 from an ingest that landed zero rows.
      recordTiming(-1, null);
      return {
        version: cfg.version.get(parts),
        count: -1
      };
    }
    const rawJson = coerceRawJson(res?.data);
    if (!rawJson) {
      // A 200 carrying nothing to shred. `ingestRaw` never runs, so no rows changed and there is nothing for a bump
      // to tell anyone about — bumping here would invalidate every read on the partition to republish what it holds.
      recordTiming(0, null);
      return {
        version: cfg.version.get(parts),
        count: 0
      };
    }
    const fingerprint = detectsUnchangedBodies ? fingerprintOf(rawJson) : undefined;
    const partitionId = (0, _args_key.partitionsKey)([parts]);
    if (fingerprint && sameBody(ingestedBodies.get(partitionId), fingerprint)) {
      // The same body we already shredded, on a partition that also takes socket writes — so this is the wrong body
      // to write, not merely a redundant one: it is older than any delta that landed since it was shredded, and
      // replacing the rows with it would undo them. Stopping here also spares the repaint, since a bump is what every
      // read watches and none of them has anything new to show.
      recordTiming(ROWS_UNCHANGED, rawJson.length);
      if (res?.etag) cfg.setEtag(key, res.etag);
      return {
        version: cfg.version.get(parts),
        count: ROWS_UNCHANGED
      };
    }
    const {
      changes,
      rows
    } = await cfg.ingestRaw(key, rawJson);
    recordTiming(rows, rawJson.length);
    if (fingerprint) {
      if (ingestedBodies.size >= FINGERPRINT_CAPACITY) ingestedBodies.clear();
      ingestedBodies.set(partitionId, fingerprint);
    }
    // Only for a body that was ingested: an etag saved from a bodyless 200 would 304 every later launch.
    if (res?.etag) cfg.setEtag(key, res.etag);
    // A body that matched the table entity for entity changed nothing, so there is nobody to wake.
    if ((0, _change_set.isUnchanged)(changes)) return {
      version: cfg.version.get(parts),
      count: rows
    };
    return {
      version: bump(key, parts, changes),
      count: rows
    };
  };

  /**
   * A key's stale and cache times and nothing else, safe to spread into a query spec:
   * {@linkcode FetchIngestConfig.rawQuery | rawQuery} hands back the whole request,
   * {@linkcode RawQuery.queryFn | queryFn} included, and spreading that would replace the ingest with the bare request.
   * A time the store left undefined is left out rather than copied over, so it cannot override a configured default
   * with `undefined`.
   *
   * {@linkcode FetchIngestConfig.rawQuery | rawQuery} may throw during render — a locator short of a value — and the
   * request itself surfaces that.
   */
  const timingsFor = key => {
    let raw;
    try {
      raw = cfg.rawQuery(key);
    } catch {
      return NO_TIMINGS;
    }
    const timings = {};
    if (raw.staleTime !== undefined) timings.staleTime = raw.staleTime;
    if (raw.cacheTime !== undefined) timings.cacheTime = raw.cacheTime;
    return timings;
  };
  function usePrime(key, enabled, opts) {
    const parts = key === undefined ? _version_atom.NO_PARTS : cfg.toParts(key);
    const addressable = (0, _version_atom.addressesPartition)(parts);
    const isEnabled = (enabled ?? true) && addressable;
    if (!opts?.slice && addressable) wantedWhole.add((0, _args_key.partitionLabel)(parts));
    // Asked for whenever the key names a partition, not only when this caller is enabled. A disabled caller still
    // constructs the observer, and an observer constructed without a staleTime treats its data as stale on arrival —
    // it then fetches when it is enabled, however fresh the cache is.
    const timings = addressable ? timingsFor(key) : NO_TIMINGS;
    // The runtime is installed once during startup, so which hook this resolves to is fixed for the app's lifetime.
    const result = (0, _runtime.queryRuntime)().useQuery({
      queryKey: queryKey(parts),
      queryFn: () => runIngest(key),
      enabled: isEnabled,
      ...timings,
      notifyOnChangeProps: NOTIFY_ON_PRIME_STATE
    });
    return {
      isInitialLoading: result.isInitialLoading,
      isFetching: result.isFetching,
      isError: result.isError
    };
  }
  function usePrimeMany(keys, enabled = true, opts) {
    // `useFocusGatedQueries` keys on this array's identity, and callers rebuild it each render, so memo on contents.
    const addressable = (0, _version_atom.partitionEntries)(keys, cfg.toParts).filter(entry => (0, _version_atom.addressesPartition)(entry.parts));
    if (!opts?.slice) for (const entry of addressable) wantedWhole.add((0, _args_key.partitionLabel)(entry.parts));
    const identity = (0, _args_key.partitionsKey)(addressable.map(entry => entry.parts));
    const queries = (0, _react.useMemo)(() => addressable.map(({
      key,
      parts
    }) => {
      return {
        queryKey: queryKey(parts),
        queryFn: () => runIngest(key),
        enabled,
        ...timingsFor(key),
        notifyOnChangeProps: NOTIFY_ON_PRIME_STATE
      };
    }), [identity, enabled] // eslint-disable-line react-hooks/exhaustive-deps -- `identity` covers `addressable`
    );
    const results = (0, _runtime.queryRuntime)().useQueries({
      queries
    });
    // Failed only if *every* partition failed, so one bad partition degrades to a gap in the list.
    return {
      isInitialLoading: results.some(result => result.isInitialLoading),
      isFetching: results.some(result => result.isFetching),
      isError: results.length > 0 && results.every(result => result.isError)
    };
  }
  function prefetch(key, opts) {
    const parts = cfg.toParts(key);
    if (!(0, _version_atom.addressesPartition)(parts)) return Promise.resolve({
      version: cfg.version.get(parts),
      count: 0
    });
    // Shares `usePrime`'s query key, so a partition a hook already primed resolves from the query cache — and that is
    // `staleTime`'s decision, so the timings are spread rather than named, to keep an absent one absent.
    return (0, _runtime.queryRuntime)().client().fetchQuery({
      queryKey: queryKey(parts),
      queryFn: () => runIngest(key),
      ...timingsFor(key),
      ...(opts?.staleTime === undefined ? {} : {
        staleTime: opts.staleTime
      })
    });
  }
  function ensure(key) {
    prefetch(key).catch(() => {
      // Best-effort: a mounted hook or the next ingest still repaints.
    });
  }
  function invalidate(key) {
    const parts = cfg.toParts(key);
    if (!(0, _version_atom.addressesPartition)(parts)) return;
    // The etag survives, so an unchanged partition costs a 304 and stops there.
    (0, _runtime.queryRuntime)().client().invalidateQueries({
      queryKey: queryKey(parts),
      exact: true
    });
  }
  function refetch(key) {
    invalidate(key);
    ensure(key);
  }
  function forget() {
    // Removed so the data goes with the record: an invalidated query keeps its data, and a mounted reader shows it.
    (0, _runtime.queryRuntime)().client().removeQueries({
      queryKey: [cfg.ingestKeyRoot]
    });
  }
  return {
    usePrime,
    usePrimeMany,
    ensure,
    prefetch,
    refetch,
    invalidate,
    forget
  };
}

// Exported so the built declaration files keep these names in scope for the doc links above; an import that only a
// doc comment uses is dropped from them.
//# sourceMappingURL=fetch_ingest.js.map