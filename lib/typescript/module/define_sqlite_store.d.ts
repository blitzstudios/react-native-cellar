/**
 * Declares a store: a SQLite table of rows plus the reads, pushes and lifecycle functions built over it. A store runs
 * on SQLite everywhere (the device's SQLite on mobile, and sql.js, SQLite compiled to WebAssembly, on web and in
 * tests), and can move between databases during a session without its callers noticing.
 */
import { VersionAtom } from './reactivity/version_atom';
import { FindOpts, RowShape, RowTable } from './table/types';
import { NativeShredSpec } from './write/shred_spec';
import { SqliteConnection } from './table/connection';
import { PartitionKeyColumn, StoreTableSchema } from './table/partitioned';
import type { PartitionFetchSpec, PartitionLifecycle, Partitions } from './define_partitions';
import type { CommonDef, Read } from './read/surface';
import type { Loose, pairRead } from './read/facade';
import { RowSet } from './read/row_shaping';
import type { ChangeSet } from './table/change_set';
import type { PushIngestConfig } from './write/push_ingest';
import type { bindSqliteStore } from './nitro/nitro_connection';
/**
 * Objects a store builds from its database connection besides its row table, such as a ranker that runs its own SQL
 * queries. They are rebuilt with the rest of the store whenever it moves to another connection, and passed to
 * {@linkcode SqliteStoreConfig.build | build} as {@linkcode CellarContext.caps | caps}.
 */
export type StoreCapabilities = object;
/**
 * What a store's {@linkcode SqliteStoreConfig.build | build} returns: its reads, and optionally its pushes and any
 * lifecycle functions of its own. Callers reach them through the store (`store.reads.x`), which always points at the
 * ones built over the database the store currently runs on.
 */
export interface StoreSurface {
    /**
     * The store's reads, by name: each a declared read (from {@linkcode CellarContext.defineRead | defineRead} or
     * {@linkcode CellarContext.defineReadAcross | defineReadAcross}) with a {@linkcode Read.useValue | useValue} hook and a
     * {@linkcode Read.getValue | getValue} getter. A service publishes each one as a `use*` hook and a `get*` getter with
     * {@linkcode pairRead}.
     */
    reads: object;
    /** Functions that write rows that arrive outside a fetch, such as socket pushes, and tell their readers. */
    push?: object;
    /**
     * Functions of the store's own that act on its partitions as a whole, added to the
     * {@linkcode PartitionLifecycle | lifecycle} Cellar gives every store.
     */
    lifecycle?: object;
}
/**
 * How a read's args name a partition, and the partition's key. A partition is the set of rows one fetch returns and
 * replaces, and its description (the `Partition`) is what the fetch is made from, such as `{ sport: 'nfl' }`. Its key
 * is the string Cellar identifies it by everywhere: in the `partition_key` column of its rows, its ETag, its version,
 * and its request.
 *
 * Most stores name {@linkcode PartitionSpec.fields | fields}: the args fields that are the description, such as
 * `['sport', 'season', 'seasonType']`, and the key is their values joined with `:`, such as `nfl:2025:regular`. A store
 * whose args need translating into a description names {@linkcode PartitionSpec.fromArgs | fromArgs}, and one
 * whose descriptions don't fit in a few small fields names {@linkcode PartitionSpec.toKey | toKey}.
 */
export type PartitionSpec<Args, Partition> = {
    /**
     * The description's fields, in key order. A read's args carry them unless
     * {@linkcode PartitionSpec.fromArgs | fromArgs} builds the description instead, and a read whose args are
     * missing one of them (undefined, null or `''`) reads nothing and fetches nothing until it has a value.
     */
    fields: readonly (keyof Partition & string)[];
    /**
     * Turns a read's args into the description of the partition to read, where the args are not the description
     * itself, such as a sport that shares another sport's partition. It gets the args as loosely as a screen holds
     * them: return `null` or `undefined` until they are complete, and the read reads nothing and fetches nothing
     * until then. Returning the same object for the same args lets Cellar derive its key once.
     */
    fromArgs?: (args: Loose<Args>) => Partition | null | undefined;
    /**
     * Turns a description into its key, where {@linkcode PartitionSpec.fields | fields} joined with `:` would not do.
     * It must give equal keys for equal descriptions and different keys for different ones. Nothing turns a key back
     * into a description: Cellar keeps each description under its key itself.
     */
    toKey?: (partition: Partition) => string;
} | {
    fields?: undefined;
    fromArgs: (args: Loose<Args>) => Partition | null | undefined;
    toKey: (partition: Partition) => string;
};
/**
 * How a store fetches one partition: the request to make, and how the response becomes the partition's rows. A fetch
 * replaces the partition: afterwards its rows are exactly the response's rows, each with its `partition_key` filled in
 * by Cellar. While it is in flight, the partition's pushes wait. Omit it for a store fed only by pushes.
 */
export type StoreFetchSpec<Row extends RowShape, Partition> = Omit<PartitionFetchSpec<Row, string, Partition>, 'holdWrites'>;
/**
 * How a store's pushed items become rows: {@linkcode PushIngestConfig}, less what Cellar supplies (the table, the
 * partition's rows, and the version bumps). Each row must carry its partition's `partition_key`.
 */
export type StorePushSpec<Item, Row extends RowShape> = Pick<PushIngestConfig<Item, Row, string>, 'idOf' | 'toRows' | 'chunk' | 'retryDelayMs'> & {
    /** {@linkcode PushIngestConfig.onWrite}: called for each partition a write changed, for anything the store does after one. */
    onWrite?: (key: string) => void;
    /**
     * How often a partition's pushes retire its ETag, in ms; two minutes by default. A push changes rows the ETag vouched
     * for, so it has to go, or the next fetch is answered 304 and whatever the socket missed is never corrected; retiring
     * it on every push would make every refetch during a live stream a full body.
     */
    etagRetireIntervalMs?: number;
};
/** A store's buffer for pushed items, as {@linkcode CellarContext.createPushIngest} creates it. */
export interface StorePushIngest<Item, Partition> {
    /**
     * Queues one pushed item for the partition the description names. Queued items are written together, soon after and
     * outside the current render; an item replaces any queued item with the same id.
     */
    queue: (partition: Partition, item: Item) => void;
}
/**
 * What a store's {@linkcode SqliteStoreConfig.build | build} gets, by convention named `cellar`: the functions to declare
 * its reads, caches and pushes with, and what they read, over the connection the store is being built on. Every
 * partition is named by its key, a string (see {@linkcode PartitionSpec}).
 */
export interface CellarContext<Row extends RowShape, Args, Partition, Caps> {
    /** Declares a read of one partition: {@linkcode Partitions.defineRead}. */
    defineRead: Partitions<Row, string, Args, Partition>['defineRead'];
    /** Declares a read across several partitions: {@linkcode Partitions.defineReadAcross}. */
    defineReadAcross: Partitions<Row, string, Args, Partition>['defineReadAcross'];
    /** Declares the store's caches: {@linkcode Partitions.defineCaches}. */
    defineCaches: Partitions<Row, string, Args, Partition>['defineCaches'];
    /**
     * The rows of the partition `key`, optionally only those whose columns equal the values in `filter`, such as a
     * team's.
     */
    rows: (key: string, filter?: Partial<Row>, opts?: FindOpts<Row>) => RowSet<Row>;
    /** The key of the partition a description names. */
    keyOf: (partition: Partition) => string;
    /** The description of the partition `key` names. */
    partitionOf: (key: string) => Partition;
    /** The keys of the partitions this session has named, most recently used last. */
    keys: () => IterableIterator<string>;
    /** Whether the partition a description names holds rows, such as to route a push to the partitions already loaded. */
    has: (partition: Partition) => boolean;
    /** The partition's version, which a write that changes it bumps. */
    versionOf: (key: string) => number;
    /**
     * Bumps the partition's version after a write outside a fetch, such as a push, with the entities it changed, so
     * their readers re-render. Returns the new version.
     */
    bump: (key: string, changes?: ChangeSet) => number;
    /** Discards the partition's ETag, so its next fetch brings a whole body. */
    clearEtag: (key: string) => void;
    /**
     * Creates the store's buffer for rows that arrive by socket push rather than by fetch: its `queue` takes an item and
     * the key of the partition it belongs to. A partition's pushes wait while it is being fetched, since the fetch
     * replaces the partition and would overwrite them with the older response.
     */
    createPushIngest: <Item>(spec: StorePushSpec<Item, Row>) => StorePushIngest<Item, Partition>;
    /** The column values that pick out the partition's rows: `{ partition_key: key }`. */
    where: (key: string) => Partial<Row>;
    /** The store's row table, for a read that runs its own query. */
    table: RowTable<Row>;
    /** What {@linkcode SqliteStoreConfig.capabilities | capabilities} built over the current connection. */
    caps: Caps;
}
/**
 * Everything {@linkcode defineSqliteStore} needs to declare a store: its name, its table, its partitions, how a
 * partition is fetched, and how to build its reads.
 */
export interface SqliteStoreConfig<Row extends RowShape, Args, Partition extends object, Surface extends StoreSurface, Caps extends StoreCapabilities> {
    /** The store's name, such as `player`. It names the store's version atom and appears in logs and error reports. */
    name: string;
    /**
     * The declaration of the store's SQLite table: its columns, primary key, `entityId` column and indexes. Cellar adds
     * a `partition_key` column (see {@linkcode PartitionSpec}), leads the primary key with it, indexes it with the
     * entity id, and keeps each partition's ETag in a side table named after the table (`players_meta`). The table is
     * created, or brought up to date, whenever the store is bound to a database.
     */
    schema: StoreTableSchema<Row>;
    /** How a read's args name a partition, and its key. */
    partition: PartitionSpec<Args, Partition>;
    /** How a partition is fetched. Omit it for a store fed only by pushes. */
    fetch?: StoreFetchSpec<Row, Partition>;
    /**
     * The store's native shred programs, which let the C++ shredder write a fetched response's rows without building JS
     * objects for them. Omit it to always build rows in JS with the fetch's {@linkcode PartitionFetchSpec.toRows | toRows}.
     */
    nativeShredSpec?: NativeShredSpec<Partition>;
    /**
     * Builds the store's {@linkcode StoreCapabilities} (objects that need the database connection, such as a ranker that
     * runs its own SQL) each time the store is built over a connection.
     */
    capabilities?: (conn: SqliteConnection) => Caps;
    /**
     * How many partitions to remember the description and last fetch time of; 512 by default. A partition past it is
     * described again from its side table row, and reads as never fetched.
     */
    internMax?: number;
    /**
     * Declares the store's reads, and its pushes and lifecycle functions if it has any, with what `cellar` hands it:
     * `build: (cellar) => ({ reads: { X: cellar.defineRead(…) } })`.
     *
     * It runs again every time the store moves to another database: at startup, after a failure reopens the database, and
     * when the store moves to an in-memory database. So it must keep all its state in what it returns, never in variables
     * outside it, or that state would outlive the database it describes.
     */
    build: (cellar: CellarContext<Row & PartitionKeyColumn, Args, Partition, Caps>) => Surface;
}
/** A store's functions: what its {@linkcode SqliteStoreConfig.build | build} returned, with Cellar's lifecycle. */
export type StoreFunctions<Args, Surface extends StoreSurface> = Omit<Surface, 'lifecycle'> & {
    lifecycle: PartitionLifecycle<Args> & (Surface['lifecycle'] extends object ? Surface['lifecycle'] : unknown);
};
/**
 * How a store gets a working database back when a SQLite statement fails during the session. The store first reopens
 * the database (up to twice per session), then moves to an in-memory database, and only if that fails too runs on
 * nothing, returning each read's {@linkcode CommonDef.empty | empty}. Every move rebuilds the store and fetches its
 * partitions again.
 */
export interface SqliteRecovery {
    /** Opens a new connection to the same database file, replacing the one that failed. */
    reopen: (options: {
        /**
         * Whether to delete the database file first. True when the error says the file is corrupt, so the reopened
         * database starts empty.
         */
        discard: boolean;
    }) => SqliteConnection;
    /** Opens an in-memory database for the store to run on when reopening its file hasn't fixed the failures. */
    fallback?: () => SqliteConnection;
    /**
     * Called when the store stops using its database file, for the in-memory database or for nothing, so the app can
     * later try to move it back onto the file.
     */
    onLeftFile?: () => void;
}
/** Options for {@linkcode SqliteStore.bindSqlite}. */
export interface BindOptions {
    /**
     * How to get a working database back if a SQLite statement fails later in the session: reopen the file, then move to
     * an in-memory database. Without it, a failure leaves the store running on nothing, with every read returning its
     * {@linkcode CommonDef.empty | empty}.
     */
    recovery?: SqliteRecovery;
    /**
     * Creates the store's tables as `TEMP` tables, which live in memory and start empty, instead of in the database file.
     * Used for the in-memory database a store falls back to.
     */
    temporary?: boolean;
    /**
     * Marks this as the app's startup bind. Startup binds should happen before anything reads the store, since a read
     * before the bind returns {@linkcode CommonDef.empty | empty} and paints an empty screen first; a startup bind that
     * comes after a read is reported.
     */
    startup?: boolean;
}
/**
 * A store declared with {@linkcode defineSqliteStore}. Until it is bound to a database, it runs on nothing, and every
 * read returns its {@linkcode CommonDef.empty | empty}.
 *
 * The store can move to a different database during a session (bound at startup, reopened after a failure, moved to an
 * in-memory database), and each move rebuilds its functions over the new one. {@linkcode SqliteStore.reads | reads},
 * {@linkcode SqliteStore.push | push} and {@linkcode SqliteStore.lifecycle | lifecycle} always point at the current
 * ones, looked up on each access, so code that keeps the store (or {@linkcode SqliteStore.reads | store.reads}) keeps
 * working across moves.
 */
export interface SqliteStore<Row extends RowShape, Args, Surface extends StoreSurface> {
    /**
     * The store's reads, by name, from the database the store currently runs on: each a declared read with
     * {@linkcode Read.useValue | useValue} and {@linkcode Read.getValue | getValue}.
     */
    readonly reads: Surface['reads'];
    /**
     * The store's functions that write rows arriving outside a fetch, such as socket pushes, from the current database.
     */
    readonly push: NonNullable<Surface['push']>;
    /**
     * The store's functions that act on its partitions as a whole (priming, fetching, refetching, discarding), from the
     * current database: the {@linkcode PartitionLifecycle | lifecycle} every store has, and any of its own.
     */
    readonly lifecycle: StoreFunctions<Args, Surface>['lifecycle'];
    /**
     * Moves the store onto the database behind `conn`: creates or updates its table there, builds its functions over it,
     * discards the fetch state of the database it ran on before, and re-renders every reader so each reads from the new
     * one (fetching its partitions again). If building over `conn` throws, the store keeps running where it was and the
     * error is rethrown.
     */
    bindSqlite: (conn: SqliteConnection, options?: BindOptions) => void;
    /** Functions for tests to run the store over rows they write themselves. Nothing outside a test calls these. */
    readonly testing: {
        /**
         * Builds the store's functions over `conn` without switching the store to them, and returns them with the row table
         * to write test rows into. The functions use the store's own version atom unless `options.version` gives another.
         */
        over: (conn: SqliteConnection, options?: {
            /**
             * A version atom for the built functions to use instead of the store's own, such as a test one that records
             * bumps.
             */
            version?: VersionAtom;
        }) => {
            /** The store's reads, push and lifecycle functions, built over `conn`. */
            surface: StoreFunctions<Args, Surface>;
            /** The row table built over `conn`, to write test rows into. */
            table: RowTable<Row & PartitionKeyColumn>;
        };
        /**
         * Makes the store's {@linkcode SqliteStore.reads | reads}, {@linkcode SqliteStore.push | push} and
         * {@linkcode SqliteStore.lifecycle | lifecycle} point at `surface` (from `over`) until the next `swap` or `reset`,
         * so code under test that reads through the store sees the test's rows.
         */
        swap: (surface: StoreFunctions<Args, Surface>) => void;
        /**
         * Returns the store to its initial state, bound to nothing, so one test's rows and fetches don't leak into the
         * next.
         */
        reset: () => void;
    };
}
/**
 * Declares a store: a SQLite table of rows ({@linkcode SqliteStoreConfig.schema | schema}) plus the reads, pushes and
 * lifecycle functions {@linkcode SqliteStoreConfig.build | build} creates over it. The store starts bound to nothing,
 * where every read returns its {@linkcode CommonDef.empty | empty}, until the app binds it to a database with
 * {@linkcode SqliteStore.bindSqlite | bindSqlite} (on a device, through {@linkcode bindSqliteStore}).
 *
 * If a SQLite statement fails later in the session, the store recovers by itself when the bind supplied a
 * {@linkcode BindOptions.recovery | recovery}: it reopens the database (deleting the file first if it's corrupt), then
 * moves to an in-memory database, and only then runs on nothing. Each move rebuilds the store and re-renders its
 * readers, which fetch again.
 */
export declare function defineSqliteStore<Row extends RowShape, Partition extends object, Surface extends StoreSurface, Args = Partition, Caps extends StoreCapabilities = Record<string, never>>(config: SqliteStoreConfig<Row, Args, Partition, Surface, Caps>): SqliteStore<Row, Args, Surface>;
export type { CommonDef, PartitionFetchSpec, Partitions, Read, bindSqliteStore, pairRead };
//# sourceMappingURL=define_sqlite_store.d.ts.map