/**
 * The fetch ingest: how a store fetches a partition (the set of rows one fetch returns and replaces) and writes the
 * response. There is one React Query query per partition. Its query function sends the partition's stored ETag, writes
 * the response body as the partition's rows (with the native shredder or the store's
 * {@linkcode FetchPlan.toRows | toRows}), stores the new ETag, and bumps the partition's version with the
 * write's change set, which re-renders the readers of the changed entities.
 */
import { VersionAtom } from '../reactivity/version_atom';
import { PrimeState } from '../prime_state';
import type { QueryRuntime } from '../runtime';
import { ChangeSet, WriteResult } from '../table/change_set';
import type { FetchPlan, Partitions, PartitionsConfig, definePartitions } from '../define_partitions';
import type { DataResult } from '../store_result';
import type { IngestTiming } from '../diagnostics/ingest_timing';
import type { CommonDef, ReadCallOptions } from '../read/surface';
/** What a partition's request resolves to: the response body, its ETag, and whether the server answered 304. */
export interface RawFetchResponse {
    /**
     * The response body. Best as the unparsed JSON text, which the native shredder writes without building JS objects;
     * a parsed body is turned back into text with `JSON.stringify` first.
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
 * A partition's request, described but not run, as a partition's {@linkcode PartitionsConfig.fetch | fetch} plan
 * returns it. Cellar runs it as the query function of the partition's React Query query, with these timings.
 */
export interface RawQuery {
    /**
     * Makes the request, sending `etag`, the partition's stored ETag, as `If-None-Match`. Resolves to the response body,
     * its ETag, and whether the server answered 304.
     */
    queryFn: (request: {
        etag?: string;
    }) => Promise<RawFetchResponse | undefined>;
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
    /** Describes the partition's request. */
    rawQuery: (key: Key) => RawQuery;
    /** The ETag stored for the partition, or `undefined`. */
    getEtag: (key: Key) => string | undefined;
    /** Stores the ETag of the partition's latest response, to send with its next request. */
    setEtag: (key: Key, etag: string) => void;
    /**
     * Writes the response body as the partition's rows, replacing what it held, and returns the write's change set (the
     * entity id of each row added, changed or removed) and how many rows the body held. `query` is the request the body
     * answered, which says how to write it.
     */
    ingestRaw: (key: Key, rawJson: string, query: RawQuery) => Promise<WriteResult>;
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
    prefetch: (key: Key, opts?: {
        /** How old the last fetch may be, in ms, for this call to skip fetching. Defaults to the partition query's. */
        staleTime?: number;
        /** Marks a fetch the inspector asked for, so an oversized one names it rather than the app. */
        via?: 'inspector';
    }) => Promise<{
        version: number;
        count: number;
    }>;
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
    /** The caller's query `meta` ({@linkcode ReadCallOptions.meta | meta}), which the partition's query carries. */
    meta?: Readonly<Record<string, unknown>>;
    /** The read that wants a slice, by its name in the store, for an oversized fetch's report to name. Dev only. */
    read?: string;
}
/**
 * Creates a store's fetching: one React Query query per partition (the set of rows one fetch returns and replaces). Its
 * query function sends the partition's stored ETag; on a 304, keeps the rows; otherwise writes the body with
 * {@linkcode FetchIngestConfig.ingestRaw | ingestRaw}, stores the new ETag, and bumps the partition's version with the
 * write's change set, so the readers of the changed entities re-render. {@linkcode definePartitions} creates it from a
 * store's {@linkcode PartitionsConfig.fetch | fetch} spec, so a store declares that spec rather than calling this.
 */
export declare function createFetchIngest<Key>(cfg: FetchIngestConfig<Key>): FetchIngest<Key>;
export type { CommonDef, DataResult, IngestTiming, FetchPlan, Partitions, PartitionsConfig, PrimeState, QueryRuntime, ReadCallOptions, VersionAtom, definePartitions };
//# sourceMappingURL=fetch_ingest.d.ts.map