/**
 * Declares a store: a SQLite table of rows, how rows arrive by fetch and by push, and the reads and lifecycle functions
 * built over it. A store runs
 * on SQLite everywhere (the device's SQLite on mobile, and sql.js, SQLite compiled to WebAssembly, on web and in
 * tests), and can move between databases during a session without its callers noticing.
 */

import { notifyManager } from '@tanstack/query-core';
import { reportStoreDegradation } from './diagnostics/telemetry';
import { createVersionAtom, entityChangesOf, VersionAtom } from './reactivity/version_atom';
import { FindOpts, RowShape, RowTable } from './table/types';
import { NativeShredSpec } from './write/shred_spec';
import { guardedConnection, SqliteConnection } from './table/connection';
import { createOnceGuard } from './diagnostics/once_guard';
import { createSqliteRowTable } from './table/sqlite';
import { PartitionKeyColumn, partitionedSchema, StoreTableSchema, PARTITION_KEY_COLUMN } from './table/partitioned';
import { definePartitions } from './define_partitions';
import type { PartitionFetchSpec, PartitionLifecycle, Partitions } from './define_partitions';
import { isArgPresent } from './args_key';
import { labelReads } from './read/surface';
import type { CommonDef, Read } from './read/surface';
import type { Loose, pairRead } from './read/facade';
import { rowsOf, RowSet } from './read/row_shaping';
import type { ChangeSet } from './table/change_set';
import { createPushIngest } from './write/push_ingest';
import type { PushIngest, PushIngestConfig } from './write/push_ingest';
import { createEtagRetirement } from './write/etag_retirement';
import type { bindSqliteStore } from './nitro/nitro_connection';
import { MAX_EVENT_ENTITIES, recordInspectorEvent } from './inspector/events';
import type { InspectedBinding } from './inspector/events';
import { registerInspectedStore } from './inspector/registry';
import { createInspectedStore } from './inspector/store';
import type { RunningStore } from './inspector/store';
import { ALL_ENTITIES } from './table/change_set';

/**
 * Objects a store builds from its database connection besides its row table, such as a ranker that runs its own SQL
 * queries. They are rebuilt with the rest of the store whenever it moves to another connection, and passed to
 * {@linkcode SqliteStoreConfig.build | build} as {@linkcode CellarContext.caps | caps}.
 */
export type StoreCapabilities = object;

/**
 * What a store's {@linkcode SqliteStoreConfig.build | build} returns: its reads, and optionally lifecycle functions of
 * its own. Callers reach them through the store (`store.reads.x`), which always points at the ones built over the
 * database the store currently runs on.
 */
export interface StoreSurface {
  /**
   * The store's reads, by name: each a declared read (from {@linkcode CellarContext.defineRead | defineRead} or
   * {@linkcode CellarContext.defineReadAcross | defineReadAcross}) with a {@linkcode Read.useValue | useValue} hook and a
   * {@linkcode Read.getValue | getValue} getter. A service publishes each one as a `use*` hook and a `get*` getter with
   * {@linkcode pairRead}.
   */
  reads: object;
  /** Not built: a store declares its pushes with {@linkcode SqliteStoreConfig.push | push}, and Cellar builds them. */
  push?: never;
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
export type PartitionSpec<Args, Partition> =
  | {
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
    }
  | {
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
 * How items pushed to a store from outside a fetch, such as a socket's, become rows: {@linkcode PushIngestConfig}, less
 * what Cellar supplies (the table, the partition's rows, and the version bumps). Each row must carry its partition's
 * `partition_key`. A push adds and updates rows and never deletes one. Cellar buffers the items, keeping the latest
 * per {@linkcode PushIngestConfig.idOf | idOf}, and writes them soon after and outside the current render.
 */
export type StorePushSpec<Item, Row extends RowShape, Partition> = Pick<PushIngestConfig<Item, Row, string>, 'idOf' | 'chunk' | 'retryDelayMs'> & {
  /**
   * Turns a partition's buffered items into its rows, given the partition's key and description: the description
   * carries what every row in it shares, so an item needn't.
   */
  toRows: (key: string, items: readonly Item[], partition: Partition) => Row[];
  /**
   * The partitions an item may belong to, as descriptions, such as a stat's week and its game. The item is written to
   * those that already hold rows, or to all of them when none does, since a push can be a partition's only source.
   */
  partitionsOf: (item: Item) => readonly Partition[];
  /**
   * How often a partition's pushes retire its ETag, in ms; two minutes by default. A push changes rows the ETag vouched
   * for, so it has to go, or the next fetch is answered 304 and whatever the socket missed is never corrected; retiring
   * it on every push would make every refetch during a live stream a full body.
   */
  etagRetireIntervalMs?: number;
};

/** What Cellar gives a store that declares {@linkcode SqliteStoreConfig.push | push}, as {@linkcode SqliteStore.push | store.push}. */
export interface StorePush<Item> {
  /**
   * Queues each item for the partitions its {@linkcode StorePushSpec.partitionsOf | partitionsOf} names that hold
   * rows, or for all of them when none does. A partition's items wait while it is being fetched, since the fetch
   * replaces the partition and would overwrite them with the older response. Nothing to ingest is a no-op. An item
   * the store's own functions throw on is dropped and reported, and the rest are queued.
   */
  ingest: (items: readonly Item[] | null | undefined) => void;
}

/** A store's {@linkcode StorePush}, or `undefined` for a store that declares no {@linkcode SqliteStoreConfig.push | push}. */
export type StorePushOf<Item> = [Item] extends [never] ? undefined : StorePush<Item>;

/**
 * What a store's {@linkcode SqliteStoreConfig.build | build} gets, by convention named `cellar`: the functions to declare
 * its reads and caches with, and what they read, over the connection the store is being built on. Every
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
  /** Whether the partition a description names holds rows. */
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
  /** The column values that pick out the partition's rows: `{ partition_key: key }`. */
  where: (key: string) => Partial<Row>;
  /** The store's row table, for a read that runs its own query. */
  table: RowTable<Row>;
  /** What {@linkcode SqliteStoreConfig.capabilities | capabilities} built over the current connection. */
  caps: Caps;
}

/**
 * Everything {@linkcode defineSqliteStore} needs to declare a store: its name, its table, its partitions, how rows
 * arrive by fetch and by push, and how to build its reads.
 */
export interface SqliteStoreConfig<
  Row extends RowShape,
  Args,
  Partition extends object,
  Surface extends StoreSurface,
  Caps extends StoreCapabilities,
  Item = never,
> {
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
   * How items pushed from outside a fetch, such as a socket's, become rows. The store then has
   * {@linkcode SqliteStore.push | push}. Omit it for a store that is only fetched.
   */
  push?: StorePushSpec<Item, Row & PartitionKeyColumn, Partition>;
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
   * Declares the store's reads, and lifecycle functions of its own if it has any, with what `cellar` hands it:
   * `build: (cellar) => ({ reads: { X: cellar.defineRead(…) } })`.
   *
   * It runs again every time the store moves to another database: at startup, after a failure reopens the database, and
   * when the store moves to an in-memory database. So it must keep all its state in what it returns, never in variables
   * outside it, or that state would outlive the database it describes.
   */
  build: (cellar: CellarContext<Row & PartitionKeyColumn, Args, Partition, Caps>) => Surface;
}

/** A store's functions: what its {@linkcode SqliteStoreConfig.build | build} returned, with Cellar's lifecycle and push. */
export type StoreFunctions<Args, Surface extends StoreSurface, Item = never> = Omit<Surface, 'lifecycle' | 'push'> & {
  lifecycle: PartitionLifecycle<Args> & (Surface['lifecycle'] extends object ? Surface['lifecycle'] : unknown);
  push: StorePushOf<Item>;
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
  /** The database's name, such as `player_stats.db`, for the inspector to show where the store runs. */
  database?: string;
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
export interface SqliteStore<Row extends RowShape, Args, Surface extends StoreSurface, Item = never> {
  /**
   * The store's reads, by name, from the database the store currently runs on: each a declared read with
   * {@linkcode Read.useValue | useValue} and {@linkcode Read.getValue | getValue}.
   */
  readonly reads: Surface['reads'];
  /**
   * Where items pushed from outside a fetch, such as a socket's, go in, onto the current database: a
   * {@linkcode StorePush} for a store that declares {@linkcode SqliteStoreConfig.push | push}, and `undefined` otherwise.
   */
  readonly push: StorePushOf<Item>;
  /**
   * The store's functions that act on its partitions as a whole (priming, fetching, refetching, discarding), from the
   * current database: the {@linkcode PartitionLifecycle | lifecycle} every store has, and any of its own.
   */
  readonly lifecycle: StoreFunctions<Args, Surface, Item>['lifecycle'];
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
    over: (
      conn: SqliteConnection,
      options?: {
        /**
         * A version atom for the built functions to use instead of the store's own, such as a test one that records
         * bumps.
         */
        version?: VersionAtom;
      },
    ) => {
      /** The store's reads, push and lifecycle functions, built over `conn`. */
      surface: StoreFunctions<Args, Surface, Item>;
      /** The row table built over `conn`, to write test rows into. */
      table: RowTable<Row & PartitionKeyColumn>;
    };
    /**
     * Makes the store's {@linkcode SqliteStore.reads | reads}, {@linkcode SqliteStore.push | push} and
     * {@linkcode SqliteStore.lifecycle | lifecycle} point at `surface` (from `over`) until the next `swap` or `reset`,
     * so code under test that reads through the store sees the test's rows.
     */
    swap: (surface: StoreFunctions<Args, Surface, Item>) => void;
    /**
     * Returns the store to its initial state, bound to nothing, so one test's rows and fetches don't leak into the
     * next.
     */
    reset: () => void;
  };
}

/**
 * Answers every statement with no rows: what an unbound store runs on, so each read gives back its declared
 * {@linkcode CommonDef.empty | empty}.
 */
const NULL_CONNECTION: SqliteConnection = { execute: () => ({ rows: { _array: [] } }) };

/**
 * Reopens a store gets per session before it moves to its fallback. A database that fails again straight after a
 * reopen is failing for a reason a reopen does not fix, and each attempt costs a refetch of every partition.
 */
const MAX_REOPENS = 2;

/**
 * An error that means the file itself is unusable, so reopening it would only fail the same way. SQLite's own wording
 * only: a bare "malformed" is also how `json_extract` reports one bad value, which says nothing about the file.
 */
const CORRUPTION = /SQLITE_CORRUPT|SQLITE_NOTADB|database disk image is malformed|file is not a database/i;
const messageOf = (error: unknown): string => String((error as { message?: unknown })?.message ?? error);

/** A failing read's statement, reported once a session per store and message. */
const statementErrors = createOnceGuard();

/**
 * A view of one group of the running surface, looked up at each access so that a move reaches every caller, including
 * one that took the group before it happened.
 */
function delegate<T extends object>(group: () => T | undefined, label: string): T {
  const resolve = (): T => {
    const target = group();
    if (!target) throw new Error(`${label}: this store has no such group`);
    return target;
  };
  return new Proxy({} as T, {
    get: (_target, key) => Reflect.get(resolve(), key),
    has: (_target, key) => Reflect.has(resolve(), key),
    ownKeys: () => Reflect.ownKeys(resolve()),
    getOwnPropertyDescriptor: (_target, key) => {
      const descriptor = Reflect.getOwnPropertyDescriptor(resolve(), key);
      // The proxy's own target holds nothing, so every property it reports has to be configurable.
      return descriptor && { ...descriptor, configurable: true };
    },
  });
}

/**
 * Declares a store: a SQLite table of rows ({@linkcode SqliteStoreConfig.schema | schema}), how rows arrive by
 * {@linkcode SqliteStoreConfig.fetch | fetch} and by {@linkcode SqliteStoreConfig.push | push}, and the reads and
 * lifecycle functions {@linkcode SqliteStoreConfig.build | build} creates over it. The store starts bound to nothing,
 * where every read returns its {@linkcode CommonDef.empty | empty}, until the app binds it to a database with
 * {@linkcode SqliteStore.bindSqlite | bindSqlite} (on a device, through {@linkcode bindSqliteStore}).
 *
 * If a SQLite statement fails later in the session, the store recovers by itself when the bind supplied a
 * {@linkcode BindOptions.recovery | recovery}: it reopens the database (deleting the file first if it's corrupt), then
 * moves to an in-memory database, and only then runs on nothing. Each move rebuilds the store and re-renders its
 * readers, which fetch again.
 */
export function defineSqliteStore<
  Row extends RowShape,
  Partition extends object,
  Surface extends StoreSurface,
  Args = Partition,
  Caps extends StoreCapabilities = Record<string, never>,
  Item = never,
>(config: SqliteStoreConfig<Row, Args, Partition, Surface, Caps, Item>): SqliteStore<Row, Args, Surface, Item> {
  type StoredRow = Row & PartitionKeyColumn;
  type Functions = StoreFunctions<Args, Surface, Item>;
  const schema = partitionedSchema(config.schema);
  const version = createVersionAtom(`${config.name}_version`);
  const extra = (more?: Record<string, unknown>) => ({ store: config.name, table: schema.table, ...more });
  const capabilitiesOf = (conn: SqliteConnection): Caps => (config.capabilities ? config.capabilities(conn) : ({} as Caps));
  const where = (key: string): Partial<StoredRow> => ({ [PARTITION_KEY_COLUMN]: key }) as Partial<StoredRow>;
  const { fields, fromArgs, toKey } = config.partition;
  const partitionOfArgs = fromArgs ?? partitionFromFields<Args, Partition>(fields!);
  const keyOfPartition = toKey ?? keyFromFields<Partition>(fields!);

  /** Logs a write that changed a partition, for the inspector. Wired in development builds only. */
  const recordWrite = (partition: string, next: number, changes: ChangeSet): void => {
    const entities = changes === ALL_ENTITIES ? ALL_ENTITIES : Array.from(changes).slice(0, MAX_EVENT_ENTITIES);
    recordInspectorEvent({ kind: 'write', store: config.name, partition, version: next, entities, entityCount: changes === ALL_ENTITIES ? null : changes.size });
  };

  /** What the inspector looks into for each surface the store builds: the connection under it, and its partitions. */
  const inspectable = new WeakMap<Functions, RunningStore>();

  /** Declares the partitions over `table` and hands the store its context. `raw` is the connection before its guard. */
  const buildOn = (table: RowTable<StoredRow>, atom: VersionAtom, caps: Caps, raw: SqliteConnection): Functions => {
    table.init();
    const pushSpec = config.push;
    let ingest: PushIngest<Item, string> | undefined;
    // A store without pushes holds nothing, so its fetches needn't detect a body they already wrote.
    const holdWrites = pushSpec && ((key: string) => ingest!.hold(key));
    const partitions = definePartitions<StoredRow, string, Args, Partition>({
      name: config.name.replace(/_store$/, ''),
      table,
      version: atom,
      key: {
        of: partitionOfArgs,
        id: keyOfPartition,
        from: (key) => {
          const record = table.getMetaRecord(where(key));
          return record === undefined ? undefined : (JSON.parse(record) as Partition);
        },
        where,
      },
      fetch: config.fetch && { ...(config.fetch as unknown as StoreFetchSpec<StoredRow, Partition>), holdWrites },
      internMax: config.internMax,
      remember: (key, partition) => {
        const rowsWhere = where(key);
        if (table.getMetaRecord(rowsWhere) === undefined) table.setMeta(rowsWhere, table.getMeta(rowsWhere), JSON.stringify(partition));
      },
      ...(__DEV__ && { onChanged: recordWrite }),
      fixedColumns: (fields ?? []).filter((field) => field in config.schema.columns),
    });
    table.onChangesElsewhere?.((changes) => notifyManager.batch(() => changes.forEach((entities, key) => partitions.bump(key, entities))));
    const surface = config.build({
      defineRead: partitions.defineRead,
      defineReadAcross: partitions.defineReadAcross,
      defineCaches: partitions.defineCaches,
      rows: (key, filter, opts) => rowsOf(table).where(filter ? { ...filter, ...where(key) } : where(key), opts),
      keyOf: partitions.keyOf,
      partitionOf: partitions.partitionOf,
      keys: partitions.internedKeys,
      has: (partition) => partitions.has(partitions.keyOf(partition)),
      versionOf: partitions.versionOf,
      bump: partitions.bump,
      clearEtag: partitions.clearEtag,
      where,
      table,
      caps,
    });
    labelReads(surface.reads);
    let push: StorePush<Item> | undefined;
    if (pushSpec) {
      const { partitionsOf, etagRetireIntervalMs, toRows, ...spec } = pushSpec;
      const buffer = createPushIngest({
        ...spec,
        toRows: (key, items) => toRows(key, items, partitions.partitionOf(key)),
        name: config.name,
        table,
        where,
        bump: partitions.bump,
        onWrite: createEtagRetirement(partitions.clearEtag, etagRetireIntervalMs),
      });
      ingest = buffer;
      push = {
        ingest: (items) => {
          if (!items) return;
          let dropped = 0;
          let firstError: unknown;
          for (const item of items) {
            try {
              const keys = partitionsOf(item).map(partitions.keyOf);
              const loaded = keys.filter(partitions.has);
              for (const key of loaded.length ? loaded : keys) buffer.queue(key, item);
            } catch (error) {
              dropped += 1;
              firstError ??= error;
            }
          }
          if (dropped) {
            reportStoreDegradation({
              scope: `${config.name}.push`,
              group: 'store.push',
              context: 'pushed items threw before they were queued, so they were dropped and their rows stay stale until the next push or fetch',
              error: firstError,
              extra: extra({ dropped, total: items.length }),
            });
          }
        },
      };
    }
    const own = surface.lifecycle as { forget?: () => void } | undefined;
    const forget = own?.forget
      ? () => {
          partitions.lifecycle.forget();
          own.forget!();
        }
      : partitions.lifecycle.forget;
    const functions = { ...surface, ...(push && { push }), lifecycle: { ...partitions.lifecycle, ...own, forget } } as unknown as Functions;
    inspectable.set(functions, {
      conn: raw,
      reads: Object.keys(surface.reads),
      internedKeys: partitions.internedKeys,
      describe: partitions.partitionOf,
      versionOf: partitions.versionOf,
      entityChanges: (key) => entityChangesOf(atom, [key]),
      entityVersionOf: (key, entityId) => atom.getEntity([key], entityId),
      fetchedAt: partitions.inspect.fetchedAt,
      refetch: partitions.inspect.refetch,
      clearEtag: partitions.clearEtag,
    });
    return functions;
  };

  let running: Functions | undefined;
  let hasBeenRead = false;
  let reopens = 0;
  // What each surface the store has run on primed, so leaving it can have the next one fetch for itself.
  let resets: Array<() => void> = [];

  const buildOver = (
    conn: SqliteConnection,
    temporary: boolean,
    atom: VersionAtom = version,
    raw: SqliteConnection = conn,
  ): { surface: Functions; table: RowTable<StoredRow> } => {
    const table = createSqliteRowTable(schema, conn, config.nativeShredSpec as NativeShredSpec | undefined, { temporary });
    return { surface: buildOn(table, atom, capabilitiesOf(conn), raw), table };
  };

  let binding: InspectedBinding = { state: 'unbound', since: Date.now(), reopens: 0 };
  const moveBinding = (state: InspectedBinding['state'], database = binding.database): void => {
    binding = { state, ...(database === undefined ? {} : { database }), since: Date.now(), reopens };
    recordInspectorEvent({ kind: 'binding', store: config.name, binding });
  };

  const install = (surface: Functions): Functions => {
    const forget = surface.lifecycle?.forget;
    if (forget) resets.push(forget);
    running = surface;
    return surface;
  };

  /** Forgets what the running surface fetched, runs the store on `surface`, and has every reader read from it. */
  const replaceRunning = (surface: Functions): void => {
    const previous = resets;
    resets = [];
    previous.forEach((reset) => reset());
    install(surface);
    version.bumpAll();
  };

  // Built on first read, so a platform that binds first never builds it.
  const current = (): Functions => {
    hasBeenRead = true;
    return running ?? install(buildOver(NULL_CONNECTION, false).surface);
  };

  /**
   * The store over SQLite on `conn`, guarded so that a failure on it reopens the database or moves the store off it.
   */
  const buildGuarded = (conn: SqliteConnection, options: BindOptions): Functions => {
    const guarded = guardedConnection(
      conn,
      (error, op) => onSqliteFailure(error, op, options),
      (error, op) =>
        reportStoreDegradation({
          scope: `${config.name}.contention`,
          group: 'store.contention',
          context:
            `SQLite \`${op}\` was refused because another statement held the connection — absorbed, but the store is one ` +
            'connection short of where it should be, which usually means its dedicated reader never opened',
          error,
          extra: extra({ op }),
        }),
      (error, op, sql) => {
        if (statementErrors.seen(config.name, messageOf(error))) return;
        reportStoreDegradation({
          scope: `${config.name}.statement_error`,
          group: 'store.statement_error',
          context: `a SQLite \`${op}\` read failed on its own statement and answered empty; the connection is fine, and the read's SQL or the value it parsed is not`,
          error,
          extra: extra({ op, ...(sql ? { sql: sql.slice(0, 500) } : {}) }),
        });
      },
    );
    return buildOver(guarded, !!options.temporary, version, conn).surface;
  };

  /**
   * The last resort: nothing to read from, reported, and handed to the binding so a later retry can bring the store
   * back.
   */
  const leaveUnbound = (context: string, error: unknown, options: BindOptions, more?: Record<string, unknown>): void => {
    reportStoreDegradation({ scope: `${config.name}.unbound`, group: 'store.unbound', context, error, extra: extra(more) });
    replaceRunning(buildOver(NULL_CONNECTION, false).surface);
    moveBinding('unbound');
    options.recovery?.onLeftFile?.();
  };

  /** Moves the store to its in-memory fallback, or leaves it unbound when there is none. */
  const moveToFallback = (error: unknown, op: string, options: BindOptions): void => {
    const fallback = options.recovery?.fallback;
    if (!fallback) {
      leaveUnbound(`SQLite \`${op}\` failed mid-session and the store has no fallback; its reads are empty until a retry binds it`, error, options, { op });
      return;
    }
    try {
      const fallbackOptions: BindOptions = { temporary: true, recovery: { reopen: options.recovery!.reopen, onLeftFile: options.recovery!.onLeftFile } };
      replaceRunning(buildGuarded(fallback(), fallbackOptions));
      moveBinding('memory');
      options.recovery?.onLeftFile?.();
      reportStoreDegradation({
        scope: `${config.name}.in_memory`,
        group: 'store.in_memory',
        context: `SQLite \`${op}\` kept failing on the database file; the store runs on an in-memory database and refetches into it`,
        error,
        extra: extra({ op }),
      });
    } catch (fallbackError) {
      leaveUnbound('the in-memory fallback could not be opened either; the store reads empty until a retry binds it', fallbackError, options, {
        op,
        firstError: messageOf(error),
      });
    }
  };

  /**
   * A statement failed, and the connection it ran on answers nothing from here. The store reopens the database — or,
   * when the file is what failed, deletes it and starts empty — and refetches into it; after that, it moves to its
   * in-memory fallback. Deferred, so the failing statement's caller unwinds first.
   */
  const onSqliteFailure = (error: unknown, op: string, options: BindOptions): void => {
    queueMicrotask(() => {
      const recovery = options.recovery;
      if (!recovery || options.temporary || reopens >= MAX_REOPENS) {
        moveToFallback(error, op, options);
        return;
      }
      reopens += 1;
      const discard = CORRUPTION.test(messageOf(error));
      try {
        const conn = recovery.reopen({ discard });
        // A write that failed may have left rows short of what their ETag vouches for, so each partition's next fetch
        // brings a whole body rather than a 304. The descriptions stay.
        if (!discard && schema.meta) {
          try {
            conn.execute(`UPDATE ${schema.meta.table} SET ${schema.meta.column} = NULL;`);
          } catch {
            /* a database with no meta table yet has no ETags to clear */
          }
        }
        replaceRunning(buildGuarded(conn, options));
        moveBinding('database');
        reportStoreDegradation({
          scope: `${config.name}.reopened`,
          context: `SQLite \`${op}\` failed mid-session; the store reopened its database${discard ? ', deleting it first,' : ''} and will refetch into it`,
          error,
          extra: extra({ op, discard, reopens }),
          severity: 'info',
        });
      } catch (reopenError) {
        moveToFallback(reopenError, op, options);
      }
    });
  };

  const bindSqlite = (conn: SqliteConnection, options: BindOptions = {}): void => {
    const surface = buildGuarded(conn, options);
    // Reported rather than warned: a startup bind that lands after a read means startup ordering moved, and that
    // read's first paint was empty.
    if (options.startup && hasBeenRead) {
      reportStoreDegradation({
        scope: 'store.late_bind',
        context:
          'a store was bound at startup after something had already read from it, so that read painted empty first. Bind the ' +
          'store earlier in startup.',
      });
    }
    if (!options.temporary) reopens = 0;
    replaceRunning(surface);
    moveBinding(options.temporary ? 'memory' : 'database', options.database);
  };

  // Looks at `running` rather than calling `current()`: looking isn't a read, and must not build the unbound surface or
  // count as one for the late-bind check.
  registerInspectedStore(
    createInspectedStore({
      name: config.name,
      schema,
      nativeShred: !!config.nativeShredSpec,
      binding: () => binding,
      running: () => (running ? inspectable.get(running) : undefined),
    }),
  );

  return {
    reads: delegate(() => current().reads, `${config.name}.reads`),
    push: (config.push ? delegate(() => current().push as StorePush<Item> | undefined, `${config.name}.push`) : undefined) as StorePushOf<Item>,
    lifecycle: delegate(() => current().lifecycle, `${config.name}.lifecycle`),
    bindSqlite,
    testing: {
      over: (conn, options = {}) => buildOver(conn, false, options.version),
      swap: (surface) => {
        running = surface;
      },
      reset: () => {
        running = undefined;
        hasBeenRead = false;
        reopens = 0;
        resets = [];
        binding = { state: 'unbound', since: Date.now(), reopens: 0 };
      },
    },
  };
}

/** The default {@linkcode PartitionSpec.fromArgs | fromArgs}: the args' own values of the fields, once all have one. */
function partitionFromFields<Args, Partition>(fields: readonly string[]): (args: Loose<Args>) => Partition | null {
  return (args) => {
    const partition: Record<string, unknown> = {};
    for (const field of fields) {
      const value = (args as Record<string, unknown>)[field];
      if (!isArgPresent(value)) return null;
      partition[field] = value;
    }
    return partition as Partition;
  };
}

/**
 * The default {@linkcode PartitionSpec.toKey | toKey}: one field's value as it is, or several fields' values joined with
 * `:`, each escaped only where it holds a `:` or `%` of its own.
 */
function keyFromFields<Partition>(fields: readonly string[]): (partition: Partition) => string {
  const part = (value: unknown): string => {
    const text = String(value);
    return /[:%]/.test(text) ? encodeURIComponent(text) : text;
  };
  return fields.length === 1
    ? (partition) => String((partition as Record<string, unknown>)[fields[0]])
    : (partition) => fields.map((field) => part((partition as Record<string, unknown>)[field])).join(':');
}

// Exported so the built declaration files keep these names in scope for the doc links above; an import that only a
// doc comment uses is dropped from them.
export type { CommonDef, PartitionFetchSpec, Partitions, Read, bindSqliteStore, pairRead };
