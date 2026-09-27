/**
 * The fetch ingest: how a store fetches a partition (the set of rows one fetch returns and replaces) and writes the
 * response. There is one React Query query per partition. Its query function sends the partition's stored ETag, writes
 * the response body as the partition's rows (with the native shredder or the store's
 * {@linkcode PartitionFetchSpec.parse | parse}), stores the new ETag, and bumps the partition's version with the
 * write's change set, which re-renders the readers of the changed entities.
 */

import { useMemo } from 'react';

import { partitionLabel, partitionsKey } from '../args_key';
import { addressesPartition, NO_PARTS, partitionEntries, VersionAtom } from '../reactivity/version_atom';
import { PrimeState } from '../prime_state';
import { recordIngestTiming } from '../diagnostics/ingest_timing';
import { createOnceGuard } from '../diagnostics/once_guard';
import { reportStoreDegradation } from '../diagnostics/telemetry';
import { queryRuntime } from '../runtime';
import { ChangeSet, isUnchanged, WriteResult } from '../table/change_set';
import type { PartitionFetchSpec, Partitions, PartitionsConfig, definePartitions } from '../define_partitions';
import type { DataResult } from '../store_result';
import type { IngestTiming } from '../diagnostics/ingest_timing';
import type { CommonDef } from '../read/surface';

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
const NOTIFY_ON_PRIME_STATE = ['isInitialLoading', 'isError'] as const;

/** What a partition's request resolves to: the response body, its ETag, and whether the server answered 304. */
export interface RawFetchResponse {
  /**
   * The response body. Best as the unparsed JSON text (see {@linkcode RAW_TEXT_RESPONSE_TRANSFORM}), which the native
   * shredder can write without building JS objects; a parsed body is turned back into text with `JSON.stringify` first.
   */
  data?: unknown;
  /** The response's ETag header. It is stored for the partition and sent as `If-None-Match` on the next request. */
  etag?: string;
  /**
   * Set when the server answered 304 Not Modified to the `If-None-Match` ETag: the partition hasn't changed, so its
   * rows are kept as they are and nothing is parsed or written.
   */
  __etagMatch?: boolean;
}

/**
 * A partition's request, described but not run, as a partition's {@linkcode PartitionFetchSpec.query | fetch.query}
 * returns it. Cellar runs it as the query function of the partition's React Query query, with these timings.
 */
export interface RawQuery {
  /** Makes the request, and resolves to the response body, its ETag, and whether the server answered 304. */
  queryFn: () => Promise<RawFetchResponse | undefined>;
  /**
   * How long after a fetch the partition counts as fresh, in ms: a component mounting within that time uses the
   * stored rows without fetching again. Defaults to the app's React Query default.
   */
  staleTime?: number;
  /**
   * How long React Query keeps the partition's query after no component uses it, in ms. The rows stay in the table
   * either way; this only decides when the partition's fetch state is discarded.
   */
  cacheTime?: number;
}

/**
 * How {@linkcode createFetchIngest} fetches and writes a store's partitions (a partition is the set of rows one fetch
 * returns and replaces). {@linkcode definePartitions} builds this from a store's
 * {@linkcode PartitionsConfig.fetch | fetch} spec.
 */
export interface FetchIngestConfig<Key> {
  /**
   * The first element of every partition's React Query query key, such as `player_store_ingest`; the key parts follow
   * it.
   */
  ingestKeyRoot: string;
  /** The store's version atom: the per-partition and per-entity version numbers that a fetch's write bumps. */
  version: VersionAtom;
  /** A partition key's parts: its values as a list of strings, which make up the rest of its query key. */
  toParts: (key: Key) => readonly string[];
  /** Describes the partition's request, sending `etag` as `If-None-Match` when the partition has one stored. */
  rawQuery: (key: Key, etag?: string) => RawQuery;
  /** The ETag stored for the partition, or `undefined`. */
  getEtag: (key: Key) => string | undefined;
  /** Stores the ETag of the partition's latest response, to send with its next request. */
  setEtag: (key: Key, etag: string) => void;
  /**
   * Writes the response body as the partition's rows, replacing what it held, and returns the write's change set (the
   * entity id of each row added, changed or removed) and how many rows the body held.
   */
  ingestRaw: (key: Key, rawJson: string) => Promise<WriteResult>;
  /**
   * Bumps the partition's version with the write's change set and returns the new version. Defaults to
   * {@linkcode VersionAtom.bump | version.bump}; {@linkcode definePartitions} passes its own, which also calls
   * {@linkcode PartitionsConfig.onChanged | onChanged}.
   */
  bump?: (key: Key, changes: ChangeSet) => number;
  /**
   * Called when the partition's request starts, returning a function called when its write has finished: holds the
   * partition's socket pushes in between, since the write replaces the whole partition and would overwrite a push
   * written mid-request with the older response. Returns nothing for a partition with no writes to hold.
   */
  holdWrites?: (key: Key) => (() => void) | undefined;
}

/**
 * An axios `transformResponse` that returns the response body unchanged, so it stays the unparsed JSON text. Pass it
 * in a partition's request: our axios (0.15.3) otherwise parses every string body as JSON, whatever `responseType`
 * says, and the native shredder needs the text.
 */
export const RAW_TEXT_RESPONSE_TRANSFORM = [(data: unknown): unknown => data];

function coerceRawJson(data: unknown): string | undefined {
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
interface BodyFingerprint {
  length: number;
  djb: number;
  sdbm: number;
}

/**
 * Fingerprints a body without allocating, in one pass, as djb2 and sdbm — two polynomial hashes whose bases (33 and
 * 65599) are far enough apart to fail independently.
 *
 * Both are shift-and-add rather than `Math.imul`, which is what keeps this affordable: the multiplies, not the walk,
 * were most of the cost. Measured on Hermes over a 1.5M-character body, hashing adds 8.8ms to a 31.5ms traversal that
 * no JS fingerprint can avoid, against 34.9ms for a pair using `imul`.
 */
function fingerprintOf(body: string): BodyFingerprint {
  const length = body.length;
  let djb = 5381;
  let sdbm = 0;
  for (let index = 0; index < length; index += 1) {
    const code = body.charCodeAt(index);
    djb = ((djb << 5) + djb + code) | 0;
    sdbm = (code + (sdbm << 6) + (sdbm << 16) - sdbm) | 0;
  }
  return { length, djb: djb >>> 0, sdbm: sdbm >>> 0 };
}

function sameBody(left: BodyFingerprint | undefined, right: BodyFingerprint): boolean {
  return !!left && left.length === right.length && left.djb === right.djb && left.sdbm === right.sdbm;
}

/**
 * A store's fetching, as {@linkcode createFetchIngest} creates it: the hooks reads use to fetch their partitions, and
 * the imperative fetches {@linkcode definePartitions} publishes as the store's
 * {@linkcode Partitions.lifecycle | lifecycle}. A partition is the set of rows one fetch returns and replaces; each has
 * one React Query query.
 */
export interface FetchIngest<Key> {
  /**
   * A hook that fetches the partition if it hasn't been fetched or is older than its
   * {@linkcode RawQuery.staleTime | staleTime}, and returns the fetch's state. `undefined` or a key that names no
   * partition keeps the hook's place and fetches nothing.
   */
  usePrime: (key: Key | undefined, enabled?: boolean, opts?: PrimeIntent) => PrimeState;
  /**
   * A hook that fetches each of the partitions that hasn't been fetched or is older than its
   * {@linkcode RawQuery.staleTime | staleTime}, and returns their combined state: loading or fetching if any is, failed
   * only if every one failed.
   */
  usePrimeMany: (keys: readonly Key[], enabled?: boolean, opts?: PrimeIntent) => PrimeState;
  /**
   * Starts {@linkcode FetchIngest.prefetch | prefetch} without waiting for it or reporting its failure, for code that
   * only needs the fetch to happen.
   */
  ensure: (key: Key) => void;
  /**
   * Fetches the partition, outside a component, unless it was fetched within {@linkcode RawQuery.staleTime | staleTime}
   * (then resolves at once) or a fetch is already in flight (then waits for that one). Resolves once the rows are
   * written, with the partition's version and the number of rows written (-1 for a 304, -2 for a body identical to the
   * last one).
   */
  prefetch: (
    key: Key,
    opts?: {
      /** How old the last fetch may be, in ms, for this call to skip fetching. Defaults to the partition query's. */
      staleTime?: number;
    },
  ) => Promise<{ version: number; count: number }>;
  /** Fetches the partition again now, however recently it was fetched. Its stored ETag is still sent. */
  refetch: (key: Key) => void;
  /**
   * Marks the partition's query as stale, keeping its rows: if a mounted component is reading it, it is fetched again
   * now; otherwise the next reader fetches it. Its stored ETag is still sent, so an unchanged partition costs a 304.
   */
  invalidate: (key: Key) => void;
  /**
   * Discards every partition's React Query state, so the next component that reads a partition fetches it again. The
   * rows stay in the table.
   */
  forget: () => void;
}

/**
 * The timings for a hook holding its position while addressing nothing: no keys at all, rather than keys carrying
 * `undefined`.
 *
 * React Query reads `staleTime` off the observer with a `= 0` default, and `defaultQueryOptions` merges by spread, so
 * a key that is *present* and `undefined` overrides the client's configured default and lands on 0 — data is stale the
 * moment it arrives. Omitting the key lets the default stand. A store's partition has real timings whether or not a
 * given caller is enabled, so `timingsFor` is asked for them either way and this is only for an absent key.
 */
const NO_TIMINGS: { staleTime?: number; cacheTime?: number } = {};

/**
 * Above this, one partition landing is worth knowing about. Priming is by partition and a read of a slice pays for
 * the whole of it, so these are sized to catch a partition big enough that serving a handful of rows out of it is a
 * bad trade — not to accuse it of being one, which only the call site knows. Tune them here rather than at a site.
 */
/** What a caller fetching a partition intends to do with it, which decides whether a very large fetch is reported. */
export interface PrimeIntent {
  /**
   * True when the caller will use only part of the partition, such as a read whose args carry more than names the
   * partition (a player id beside its sport). A fetch of more than 5,000 rows or 2M characters is reported once per
   * session only when every caller that fetched the partition wanted a part of it, since then most of what was fetched
   * isn't used.
   */
  slice?: boolean;
}

const OVERSIZED_PRIME_ROWS = 5_000;
const OVERSIZED_PRIME_CHARS = 2_000_000;

const oversizedPrimeReported = createOnceGuard();

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
function reportOversizedPrime(store: string, partition: string, rows: number, chars: number | null, wantedWhole: boolean): void {
  // Somebody asked for this partition outright — a prime hook, or a read that selects all of it. The rows are what
  // they asked for, and `prime: false` is not advice that applies, so there is nothing to say.
  if (wantedWhole) return;
  if (rows < OVERSIZED_PRIME_ROWS && (chars ?? 0) < OVERSIZED_PRIME_CHARS) return;
  if (oversizedPrimeReported.seen(store, partition)) return;

  reportStoreDegradation({
    scope: `${store}.oversized_prime.${partition}`,
    context:
      `priming the '${partition}' partition landed ${rows} rows / ${chars ?? 0} chars. Priming is by partition, so ` +
      'every read of this partition pays this whether it selects one row or all of them. If the reads here want a ' +
      'slice, check whether the payload that named those rows already carries what they render, and declare ' +
      '`prime: false` on the read if so.',
    severity: 'info',
    extra: { store, partition, rows, chars },
  });
}

/**
 * Creates a store's fetching: one React Query query per partition (the set of rows one fetch returns and replaces). Its
 * query function sends the partition's stored ETag; on a 304, keeps the rows; otherwise writes the body with
 * {@linkcode FetchIngestConfig.ingestRaw | ingestRaw}, stores the new ETag, and bumps the partition's version with the
 * write's change set, so the readers of the changed entities re-render. {@linkcode definePartitions} creates it from a
 * store's {@linkcode PartitionsConfig.fetch | fetch} spec, so a store declares that spec rather than calling this.
 */
export function createFetchIngest<Key>(cfg: FetchIngestConfig<Key>): FetchIngest<Key> {
  /** The body each partition last shredded, so a refetch that brings the same one back can stop before it does. */
  const ingestedBodies = new Map<string, BodyFingerprint>();
  /**
   * Partitions some caller has asked for whole, which is what decides whether an oversized ingest is worth reporting.
   * Set during the priming hook rather than counted across mounts: the report fires once per partition per session,
   * so the question is only ever whether such a caller has existed, and a refcount would cost an effect per read.
   */
  const wantedWhole = new Set<string>();
  const queryKey = (parts: readonly string[]): (string | undefined)[] => [cfg.ingestKeyRoot, ...parts];
  const bump = (key: Key, parts: readonly string[], changes: ChangeSet): number =>
    cfg.bump ? cfg.bump(key, changes) : cfg.version.bump(parts, changes);

  const runIngest = async (key: Key): Promise<{ version: number; count: number }> => {
    const release = cfg.holdWrites?.(key);
    try {
      return await fetchAndIngest(key, !!release);
    } finally {
      release?.();
    }
  };

  /**
   * `detectsUnchangedBodies` is whether an identical body has to be *detected* rather than simply shredded again,
   * which is what decides if the body is worth hashing. Only a partition whose socket writes were held can be harmed by
   * re-shredding one: the body is older than any delta that landed since, so replacing the rows with it undoes them.
   * Without that write path the cost of missing the case is a repaint, which does not pay for a pass over every
   * character of every body.
   */
  const fetchAndIngest = async (key: Key, detectsUnchangedBodies: boolean): Promise<{ version: number; count: number }> => {
    const parts = cfg.toParts(key);
    const etag = cfg.getEtag(key);
    const startedAt = Date.now();
    const res = await cfg.rawQuery(key, etag).queryFn();
    const fetchedAt = Date.now();
    const recordTiming = (rows: number, chars: number | null): void => {
      const at = Date.now();
      const partition = partitionLabel(parts);
      recordIngestTiming({
        store: cfg.ingestKeyRoot,
        partition,
        fetchMs: fetchedAt - startedAt,
        ingestMs: at - fetchedAt,
        chars,
        rows,
        at,
      });
      // A 304 and an unchanged body report negative rows and shredded nothing, so neither is a prime worth flagging.
      if (rows > 0) reportOversizedPrime(cfg.ingestKeyRoot, partition, rows, chars, wantedWhole.has(partition));
    };

    if (res?.__etagMatch) {
      // `-1` distinguishes a 304 from an ingest that landed zero rows.
      recordTiming(-1, null);
      return { version: cfg.version.get(parts), count: -1 };
    }

    const rawJson = coerceRawJson(res?.data);
    if (!rawJson) {
      // A 200 carrying nothing to shred. `ingestRaw` never runs, so no rows changed and there is nothing for a bump
      // to tell anyone about — bumping here would invalidate every read on the partition to republish what it holds.
      recordTiming(0, null);
      return { version: cfg.version.get(parts), count: 0 };
    }

    const fingerprint = detectsUnchangedBodies ? fingerprintOf(rawJson) : undefined;
    const partitionId = partitionsKey([parts]);
    if (fingerprint && sameBody(ingestedBodies.get(partitionId), fingerprint)) {
      // The same body we already shredded, on a partition that also takes socket writes — so this is the wrong body
      // to write, not merely a redundant one: it is older than any delta that landed since it was shredded, and
      // replacing the rows with it would undo them. Stopping here also spares the repaint, since a bump is what every
      // read watches and none of them has anything new to show.
      recordTiming(ROWS_UNCHANGED, rawJson.length);
      if (res?.etag) cfg.setEtag(key, res.etag);
      return { version: cfg.version.get(parts), count: ROWS_UNCHANGED };
    }

    const { changes, rows } = await cfg.ingestRaw(key, rawJson);
    recordTiming(rows, rawJson.length);
    if (fingerprint) {
      if (ingestedBodies.size >= FINGERPRINT_CAPACITY) ingestedBodies.clear();
      ingestedBodies.set(partitionId, fingerprint);
    }
    // Only for a body that was ingested: an etag saved from a bodyless 200 would 304 every later launch.
    if (res?.etag) cfg.setEtag(key, res.etag);
    // A body that matched the table entity for entity changed nothing, so there is nobody to wake.
    if (isUnchanged(changes)) return { version: cfg.version.get(parts), count: rows };
    return { version: bump(key, parts, changes), count: rows };
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
  const timingsFor = (key: Key): { staleTime?: number; cacheTime?: number } => {
    let raw: RawQuery;
    try {
      raw = cfg.rawQuery(key);
    } catch {
      return NO_TIMINGS;
    }
    const timings: { staleTime?: number; cacheTime?: number } = {};
    if (raw.staleTime !== undefined) timings.staleTime = raw.staleTime;
    if (raw.cacheTime !== undefined) timings.cacheTime = raw.cacheTime;
    return timings;
  };

  function usePrime(key: Key | undefined, enabled?: boolean, opts?: PrimeIntent): PrimeState {
    const parts = key === undefined ? NO_PARTS : cfg.toParts(key);
    const addressable = addressesPartition(parts);
    const isEnabled = (enabled ?? true) && addressable;
    if (!opts?.slice && addressable) wantedWhole.add(partitionLabel(parts));
    // Asked for whenever the key names a partition, not only when this caller is enabled. A disabled caller still
    // constructs the observer, and an observer constructed without a staleTime treats its data as stale on arrival —
    // it then fetches when it is enabled, however fresh the cache is.
    const timings = addressable ? timingsFor(key as Key) : NO_TIMINGS;
    // The runtime is installed once during startup, so which hook this resolves to is fixed for the app's lifetime.
    const result = queryRuntime().useQuery<{ version: number; count: number }>({
      queryKey: queryKey(parts),
      queryFn: () => runIngest(key as Key),
      enabled: isEnabled,
      ...timings,
      notifyOnChangeProps: NOTIFY_ON_PRIME_STATE,
    });
    return { isInitialLoading: result.isInitialLoading, isFetching: result.isFetching, isError: result.isError };
  }

  function usePrimeMany(keys: readonly Key[], enabled = true, opts?: PrimeIntent): PrimeState {
    // `useFocusGatedQueries` keys on this array's identity, and callers rebuild it each render, so memo on contents.
    const addressable = partitionEntries(keys, cfg.toParts).filter((entry) => addressesPartition(entry.parts));
    if (!opts?.slice) for (const entry of addressable) wantedWhole.add(partitionLabel(entry.parts));
    const identity = partitionsKey(addressable.map((entry) => entry.parts));
    const queries = useMemo(
      () =>
        addressable.map(({ key, parts }) => {
          return {
            queryKey: queryKey(parts),
            queryFn: () => runIngest(key),
            enabled,
            ...timingsFor(key),
            notifyOnChangeProps: NOTIFY_ON_PRIME_STATE,
          };
        }),
      [identity, enabled], // eslint-disable-line react-hooks/exhaustive-deps -- `identity` covers `addressable`
    );
    const results = queryRuntime().useQueries({ queries });
    // Failed only if *every* partition failed, so one bad partition degrades to a gap in the list.
    return {
      isInitialLoading: results.some((result) => result.isInitialLoading),
      isFetching: results.some((result) => result.isFetching),
      isError: results.length > 0 && results.every((result) => result.isError),
    };
  }

  function prefetch(key: Key, opts?: { staleTime?: number }): Promise<{ version: number; count: number }> {
    const parts = cfg.toParts(key);
    if (!addressesPartition(parts)) return Promise.resolve({ version: cfg.version.get(parts), count: 0 });
    // Shares `usePrime`'s query key, so a partition a hook already primed resolves from the query cache — and that is
    // `staleTime`'s decision, so the timings are spread rather than named, to keep an absent one absent.
    return queryRuntime().client().fetchQuery<{ version: number; count: number }>({
      queryKey: queryKey(parts),
      queryFn: () => runIngest(key),
      ...timingsFor(key),
      ...(opts?.staleTime === undefined ? {} : { staleTime: opts.staleTime }),
    });
  }

  function ensure(key: Key): void {
    prefetch(key).catch(() => {
      // Best-effort: a mounted hook or the next ingest still repaints.
    });
  }

  function invalidate(key: Key): void {
    const parts = cfg.toParts(key);
    if (!addressesPartition(parts)) return;
    // The etag survives, so an unchanged partition costs a 304 and stops there.
    queryRuntime().client().invalidateQueries({ queryKey: queryKey(parts), exact: true });
  }

  function refetch(key: Key): void {
    invalidate(key);
    ensure(key);
  }

  function forget(): void {
    // Removed so the data goes with the record: an invalidated query keeps its data, and a mounted reader shows it.
    queryRuntime().client().removeQueries({ queryKey: [cfg.ingestKeyRoot] });
  }

  return { usePrime, usePrimeMany, ensure, prefetch, refetch, invalidate, forget };
}

// Exported so the built declaration files keep these names in scope for the doc links above; an import that only a
// doc comment uses is dropped from them.
export type { CommonDef, DataResult, IngestTiming, PartitionFetchSpec, Partitions, PartitionsConfig, PrimeState, VersionAtom, definePartitions };
