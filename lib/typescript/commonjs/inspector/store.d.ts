/**
 * One store as a development tool sees it: its schema, where it runs, its partitions, and read-only SQL over its
 * database. Built by {@linkcode defineSqliteStore} for every store it declares, and registered for
 * {@linkcode inspectedStores} to list.
 */
import type { defineSqliteStore } from '../define_sqlite_store';
import type { SqliteConnection } from '../table/connection';
import type { RowShape, RowTableSchema } from '../table/types';
import type { InspectedBinding } from './events';
import type { InspectedCache, InspectedCacheEntries, InspectedCachesOptions } from './caches';
import type { EntityChanges } from '../reactivity/version_atom';
/** A column of a store's table. */
export interface InspectedColumn {
    name: string;
    /** Its SQLite type, such as `TEXT`. */
    type: string;
    /** Whether it may not hold `NULL`. */
    notNull: boolean;
}
/** A store's table as it was declared. */
export interface InspectedSchema {
    /** The table's name. */
    table: string;
    /** The table holding each partition's ETag and description. */
    metaTable: string;
    /** Every column, `partition_key` first. */
    columns: InspectedColumn[];
    /** The primary key's columns, `partition_key` first; empty for a table whose rows have no identity. */
    primaryKey: string[];
    /** The column holding each row's entity id. */
    entityColumn: string;
    /** The table's secondary indexes. */
    indexes: Array<{
        name: string;
        columns: string[];
    }>;
    /** The names of the store's reads. */
    reads: string[];
    /** Whether the store's fetches write through the native shredder. */
    nativeShred: boolean;
}
/** One partition of a store. */
export interface InspectedPartition {
    /** The partition's key. */
    key: string;
    /** What the partition is, as the store describes it, such as `{ season: '2026', week: 4 }`; absent if not known. */
    partition?: unknown;
    /** How many rows it holds. */
    rows: number;
    /** How many distinct entities its rows belong to. */
    entities: number;
    /** Its version: 0 before its first write, and one higher after every write that changed it. */
    version: number;
    /** The ETag its next fetch sends, or `null` if it has none. */
    etag: string | null;
    /** When its rows last landed from a fetch this session, as a `Date.now()` timestamp, or `null`. */
    fetchedAt: number | null;
}
/** A store at a glance. */
export interface InspectedSummary {
    /** Where the store runs. */
    binding: InspectedBinding;
    /** How many rows its table holds. */
    rows: number;
    /** How many partitions hold rows or an ETag. */
    partitions: number;
    /** The size of the store's own database, in bytes; absent on the in-memory fallback and unbound. */
    databaseBytes?: number;
    /** The store's caches: how many, their entries, and roughly what they hold on the JS heap. Dev builds only. */
    caches: {
        count: number;
        entries: number;
        heapBytes: number;
    };
}
/** A value from a query result that JSON can't carry as it is. */
export interface InspectedBlob {
    $blob: true;
    /** Its length in bytes. */
    bytes: number;
    /** Its first 64 bytes, as hex. */
    hex: string;
}
/** What a query returned. */
export interface InspectedQueryResult {
    /** The result's column names, in order; empty when it returned no rows. */
    columns: string[];
    /** Each row's values, in column order. Blobs come back as {@linkcode InspectedBlob}s. */
    rows: unknown[][];
    /** Whether there were more rows than `limit`, and the rest were left out: another page follows. */
    truncated: boolean;
    /** How many rows were skipped before these. */
    offset: number;
    /** How long the query took, in ms. */
    durationMs: number;
}
/** Options for {@linkcode InspectedStore.query}. */
export interface InspectedQueryOptions {
    /** The most rows to return; 500 by default, at most 10000. Only a `SELECT`, `WITH` or `VALUES` is limited. */
    limit?: number;
    /** How many rows to skip first, for the next page of a `SELECT`, `WITH` or `VALUES`; 0 by default. */
    offset?: number;
}
/** The entities that changed lately in one partition. */
export interface InspectedEntityChanges {
    /** The partition's version. */
    version: number;
    /**
     * The version at which every entity last counted as changed: the partition's first write, or a write that couldn't
     * say which entities it changed. Entities changed after it are listed.
     */
    epoch: number;
    /** How many entities changed after the epoch. */
    count: number;
    /** The most recently changed of them, newest first, each with the version it changed at. */
    changed: Array<{
        id: string;
        version: number;
    }>;
}
/** A store, for a development tool: what it holds and how it's doing. */
export interface InspectedStore {
    /** The store's name, such as `player_stats_store`. */
    readonly name: string;
    /** Its table as declared. */
    schema(): InspectedSchema;
    /** Where it runs now. */
    binding(): InspectedBinding;
    /** Its row and partition totals, and the size of its database file. */
    summary(): Promise<InspectedSummary>;
    /** Every partition that holds rows, has an ETag, or is remembered, by key. */
    partitions(): Promise<InspectedPartition[]>;
    /** The entities that changed lately in one partition, at most `limit` of them (50 by default). */
    entityChanges(partitionKey: string, limit?: number): InspectedEntityChanges;
    /** The store's caches and what each has done, with what each holds on the heap when asked; empty in a release build. */
    caches(options?: InspectedCachesOptions): InspectedCache[];
    /** A page of one of the store's caches' entries, by the cache's own name, such as `statRows`. */
    cacheEntries(cache: string, page?: {
        offset?: number;
        limit?: number;
    }): InspectedCacheEntries;
    /**
     * Runs one read-only statement on the store's database and returns its rows. Throws for a statement that writes, for
     * a pragma that sets something, for more than one statement, and for SQL that SQLite rejects. Reads go to the
     * store's dedicated reader when it has one, so a long query doesn't hold up the store's writes.
     */
    query(sql: string, params?: ReadonlyArray<string | number | null>, options?: InspectedQueryOptions): Promise<InspectedQueryResult>;
    /** Fetches the partition again, sending its ETag. Returns false for a store that doesn't fetch. */
    refetch(partitionKey: string): boolean;
    /** Deletes the partition's ETag, so its next fetch downloads the whole body instead of possibly getting a 304. */
    clearEtag(partitionKey: string): void;
}
/** What {@linkcode createInspectedStore} reads a store's current state through; each looked up at the call. */
export interface InspectedStoreSource<Row extends RowShape> {
    name: string;
    schema: RowTableSchema<Row>;
    nativeShred: boolean;
    binding: () => InspectedBinding;
    /** The database the store runs on now, and what it built over it; `undefined` while it is unbound. */
    running: () => RunningStore | undefined;
}
/** What the running store is built over, for the inspector to look into. */
export interface RunningStore {
    /** The connection the store runs on, before Cellar's guard wraps it, so a bad query can't trip the store's recovery. */
    conn: SqliteConnection;
    /** The names of the store's reads. */
    reads: string[];
    /** The partitions the store remembers describing, by key. */
    internedKeys: () => Iterable<string>;
    /** A remembered partition's description. */
    describe: (key: string) => unknown;
    versionOf: (key: string) => number;
    entityChanges: (key: string) => EntityChanges;
    fetchedAt: (key: string) => number | undefined;
    refetch?: (key: string) => void;
    clearEtag: (key: string) => void;
}
/** Builds the inspector's view of one store. */
export declare function createInspectedStore<Row extends RowShape>(source: InspectedStoreSource<Row>): InspectedStore;
export type { defineSqliteStore };
//# sourceMappingURL=store.d.ts.map