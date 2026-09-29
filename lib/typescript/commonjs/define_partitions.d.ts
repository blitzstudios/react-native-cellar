/**
 * Divides a store's table into partitions and builds the store's fetching and reads on them.
 *
 * A partition is the set of rows one fetch returns and replaces, such as every player in one league, or one week of one
 * sport's stats. It is picked out by column values (its {@linkcode PartitionKeySpec.where | where}, such as `{ league:
 * 'nfl' }`), and it is the entity of everything fetch-related: one React Query query per partition, one ETag per
 * partition, one version number per partition that re-renders its readers. A read names the partition it reads with its
 * args, and reading a partition that has never been fetched fetches it.
 */
import { RawQuery } from './write/fetch_ingest';
import { Read, ReadAcross, ReadAcrossDef, ReadDef, ReadyArgs } from './read/surface';
import { RowShape, RowTable } from './table/types';
import { CacheFactory } from './cache_block';
import { addressesPartition, VersionAtom } from './reactivity/version_atom';
import { PrimeState } from './prime_state';
import type { DataResult } from './store_result';
import type { Loose } from './read/facade';
import { ChangeSet } from './table/change_set';
import type { SqliteStoreConfig } from './define_sqlite_store';
import type { CommonDef } from './read/surface';
import type { byPartition } from './caches';
import type { byEntity, DerivedValues } from './read/derived_values';
/** No partition: args still being filled in, or a slot a caller left empty, which keeps its index in the result. */
type MaybePartition<Descriptor> = Descriptor | null | undefined;
/**
 * How a store gets from a read's args to the partition they name, and from the partition to its rows.
 *
 * A partition is the set of rows one fetch returns and replaces. Each has a key, which identifies it everywhere: its
 * React Query query key, its version, its ETag and its fetch state all derive from the key. There are two ways to make
 * the key from a read's args:
 *
 * - {@linkcode PartitionKeySpec.fields | fields}: the key is those args fields, such as `['league']`, and two args with
 *   the same values in them name the same partition. Use this whenever the fields are small values.
 * - {@linkcode PartitionKeySpec.of | of} and {@linkcode PartitionKeySpec.id | id}: {@linkcode PartitionKeySpec.of | of}
 *   turns the args into a partition record (an object describing what to fetch), and
 *   {@linkcode PartitionKeySpec.id | id} turns the record into a string key. For a partition described by more than a
 *   few small fields. Cellar remembers each record by its key, so the fetch can get the record back from the key.
 *
 * Either way, {@linkcode PartitionKeySpec.where | where} turns the key into the column values that pick out the
 * partition's rows in the table.
 */
export interface PartitionKeySpec<Row extends RowShape, Key, Args, Descriptor> {
    /**
     * The args fields that make up a partition's key, in order, such as `['sport', 'season', 'week']`. Two args with the
     * same values in these fields name the same partition. A read's args must carry them, and a read whose args are
     * missing one of them (undefined, null or `''`) reads nothing and fetches nothing until it has a value.
     */
    fields?: readonly (keyof Key & string)[];
    /**
     * Turns a read's args into the record describing the partition to read, for use with
     * {@linkcode PartitionKeySpec.id | id} instead of {@linkcode PartitionKeySpec.fields | fields}. It gets the args as
     * loosely as a screen holds them, so any field can be missing: return `null` or `undefined` until the args are
     * complete, and the read reads nothing and fetches nothing until then, the same as a missing field.
     */
    of?: (args: Loose<Args>) => MaybePartition<Descriptor>;
    /**
     * Turns a partition record (from {@linkcode PartitionKeySpec.of | of}) into the partition's string key. The key
     * identifies the partition everywhere, so it must be the same every time for equal records, and different for
     * different ones.
     */
    id?: (descriptor: Descriptor) => Key;
    /**
     * Turns a partition key back into its record: the reverse of {@linkcode PartitionKeySpec.id | id}, for a store whose
     * keys can be parsed. Cellar remembers the record for each key it has seen, but only for the most recent
     * {@linkcode PartitionsConfig.internMax | internMax} partitions. Without {@linkcode PartitionKeySpec.from | from}, a
     * partition whose record was forgotten can't be fetched again for the rest of the session, which is reported; with
     * it, the record is parsed back from the key.
     */
    from?: (key: Key) => MaybePartition<Descriptor>;
    /**
     * The column values that pick out a partition's rows in the table, such as `{ league: 'nfl' }`. Everything that works
     * on a partition's rows uses it: a fetch deletes the rows that match it and writes the response's rows in their
     * place, and the partition's ETag is stored against it. Every row a fetch writes must match it, or it would sit
     * outside the partition the next fetch replaces (checked in dev).
     */
    where: (key: Key) => Partial<Row>;
}
/**
 * How a store fetches one partition: the request to make, and how the response becomes the partition's rows. A fetch
 * replaces the partition: afterwards the rows matching its {@linkcode PartitionKeySpec.where | where} are exactly the
 * response's rows. Omit it for a store fed only by socket pushes.
 */
export interface PartitionFetchSpec<Row extends RowShape, Key, Descriptor> {
    /**
     * Describes the request for one partition, without running it: returns a {@linkcode RawQuery} whose
     * {@linkcode RawQuery.queryFn | queryFn} makes the request, and whose {@linkcode RawQuery.staleTime | staleTime} and
     * {@linkcode RawQuery.cacheTime | cacheTime} are the partition's React Query timings. `etag` is the partition's
     * stored ETag, if it has one; send it as `If-None-Match`, and a 304 response keeps the partition's rows as they are.
     * `partition` is the partition's key, or its record for a store keyed with {@linkcode PartitionKeySpec.of | of} and
     * {@linkcode PartitionKeySpec.id | id}.
     */
    query: (partition: Descriptor, etag?: string) => RawQuery;
    /**
     * Turns a response body, as unparsed JSON text, into the partition's rows, in JS. The rows replace everything the
     * partition held. It runs on web, in tests, and on a device whenever the native shred isn't used for this partition
     * (no native program, {@linkcode PartitionFetchSpec.canShredNatively | canShredNatively} returns false, or the native
     * shred failed). Every row must match the partition's {@linkcode PartitionKeySpec.where | where}.
     */
    toRows: (partition: Descriptor, rawJson: string, key: Key) => readonly Row[];
    /**
     * Whether this partition's response can be written by the native C++ shredder instead of
     * {@linkcode PartitionFetchSpec.toRows | toRows}; true by default. Return false for a partition whose body the store's
     * native programs can't read, such as one that isn't a JSON array or object of elements.
     */
    canShredNatively?: (partition: Descriptor) => boolean;
    /**
     * Called when a fetch of the partition starts, and returns a function Cellar calls when the fetch has finished.
     * For a store that also receives socket pushes: hold the partition's pushes until the release is called. A fetch
     * replaces the whole partition, so a push written while the request was in flight would otherwise be overwritten by
     * the older response. Returns nothing when there are no pushes to hold, and the fetch then skips checking whether its
     * body is the one it last wrote, which only a partition taking pushes needs.
     */
    holdWrites?: (key: Key) => (() => void) | undefined;
}
/**
 * The configuration of a store's partitions: the table they divide, the version they bump, how read args name a
 * partition and which rows it holds, and how a partition is fetched. A partition is the set of rows one fetch returns
 * and replaces.
 */
export interface PartitionsConfig<Row extends RowShape, Key, Args, Descriptor> {
    /** The store's name, such as `player`. It prefixes the store's React Query keys and names it in logs and reports. */
    name: string;
    /** The row table the partitions divide: the store's SQLite table. */
    table: RowTable<Row>;
    /**
     * The store's version atom: the version numbers, per partition and per entity, that the store's reads depend on. A
     * write that changes a partition bumps its version with the entities it changed, which re-renders the readers of
     * those entities.
     */
    version: VersionAtom;
    /**
     * How read args name a partition (by {@linkcode PartitionKeySpec.fields | fields}, or by
     * {@linkcode PartitionKeySpec.of | of} and {@linkcode PartitionKeySpec.id | id}), and which rows a partition holds
     * ({@linkcode PartitionKeySpec.where | where}).
     */
    key: PartitionKeySpec<Row, Key, Args, Descriptor>;
    /**
     * How a partition is fetched: its request, and how its response becomes rows. Omit it for a store fed only by pushes.
     */
    fetch?: PartitionFetchSpec<Row, Key, Descriptor>;
    /**
     * Called after a write changes a partition's rows, with the partition's key, its new version, and the entities the
     * write changed (the entity ids whose rows were added, changed or removed). Not called for a write that changed
     * nothing. For a store that keeps something computed from a partition, such as a ranking, and needs to discard it
     * when the rows change.
     */
    onChanged?: (key: Key, version: number, changes: ChangeSet) => void;
    /**
     * How many partitions to remember details for: each partition's record (for a store keyed with
     * {@linkcode PartitionKeySpec.of | of} and {@linkcode PartitionKeySpec.id | id}) and when it was last fetched. 512 by
     * default. A forgotten fetch time makes the partition read as never fetched.
     */
    internMax?: number;
    /**
     * Called when a partition's version is bumped, with its key and its record if Cellar still holds it, so the store
     * can keep the record somewhere {@linkcode PartitionKeySpec.from | from} can find it again.
     */
    remember?: (key: Key, descriptor: Descriptor) => void;
}
/**
 * Options for a store's {@linkcode PartitionLifecycle.usePrime | usePrime} and
 * {@linkcode PartitionLifecycle.usePrimeMany | usePrimeMany} hooks, which start fetching partitions without reading
 * them.
 */
export interface PrimeHookOptions {
    /**
     * Set false to fetch nothing, while the hook keeps its place among the component's hooks; true by default. For a
     * component that shouldn't fetch yet, such as one whose screen isn't visible.
     */
    enabled?: boolean;
}
/** Options for a store's imperative {@linkcode PartitionLifecycle.fetch | fetch}. */
export interface FetchOptions {
    /**
     * How old the partition's last fetch may be, in ms, for this call to skip fetching: a partition fetched more recently
     * is left as it is. Defaults to the {@linkcode RawQuery.staleTime | staleTime} of the partition's query.
     */
    staleTime?: number;
}
/**
 * The partition operations a store publishes for code outside its reads, grouped as
 * {@linkcode Partitions.lifecycle | lifecycle}: starting fetches, checking whether a partition has rows, and refetching
 * or discarding it. A partition is the set of rows one fetch returns and replaces. Every member takes the same args a
 * read does, and works out the partition from them.
 */
export interface PartitionLifecycle<Args> {
    /**
     * A hook that fetches the partition the args name, if it hasn't been fetched or is older than its
     * {@linkcode RawQuery.staleTime | staleTime}, and returns the fetch's state. It reads nothing: the rows land in the
     * table for reads to use. Args with a field still missing, or `undefined` args, fetch nothing, so it can be called
     * unconditionally.
     */
    usePrime: (args: Loose<Args> | undefined, options?: PrimeHookOptions) => PrimeState;
    /**
     * A hook that fetches each partition the list of args names, if it hasn't been fetched or is older than its
     * {@linkcode RawQuery.staleTime | staleTime}, and returns their combined state: loading or fetching if any is, failed
     * only if all failed.
     */
    usePrimeMany: (args: readonly Args[], options?: PrimeHookOptions) => PrimeState;
    /**
     * Whether the partition the args name holds any rows. Tracked: inside a tracking scope (a
     * {@linkcode Read.useValue | useValue} read, `useTrackedStores`, a tracked selector), the scope re-runs when the
     * partition goes from empty to having rows or back.
     */
    has: (args: Args) => boolean;
    /**
     * The version number of the partition the args name: 0 before its first write, and bumped by every write that
     * changes its rows. Tracked: inside a tracking scope, the scope re-runs whenever it changes.
     */
    getVersion: (args: Args) => number;
    /**
     * When a fetch last wrote the partition the args name, in epoch ms, or 0 if it hasn't been fetched this session.
     * Tracked: inside a tracking scope, the scope re-runs when the partition changes.
     */
    getFetchedAt: (args: Args) => number;
    /**
     * Fetches the partition the args name, outside a component, unless it was fetched within
     * {@linkcode RawQuery.staleTime | staleTime} or a fetch is already in flight (then it waits for that one). Resolves
     * once the rows are written.
     */
    fetch: (args: Args, options?: FetchOptions) => Promise<void>;
    /** Fetches the partition the args name again now, however recently it was fetched. Its ETag is still sent. */
    refetch: (args: Args) => void;
    /**
     * Marks the partition the args name as stale, keeping its rows: if a mounted component is reading it, it is fetched
     * again now; otherwise the next reader fetches it. Its ETag is still sent, so an unchanged partition costs a 304.
     */
    invalidate: (args: Args) => void;
    /**
     * Discards React Query's state for every partition's fetch, so the next component that reads a partition fetches it
     * again, however recently it was fetched. The rows stay in the table. Used when the store moves to a different
     * database, whose rows the old fetches didn't write.
     */
    forget: () => void;
}
/** Where a read's partitions come from, as records; `null` and `undefined` both stand for none. */
type PartitionsFrom<Args, Descriptor> = (args: Args) => readonly MaybePartition<Descriptor>[] | null | undefined;
/**
 * A {@linkcode ReadAcrossDef} as a store declares it: its partitions named as the records a caller holds, which Cellar
 * turns into keys.
 */
interface PartitionReadAcrossDef<Args, Key, T, Descriptor, Optional extends keyof Args> extends Omit<ReadAcrossDef<Args, Key, T, Optional>, 'partitions'> {
    /**
     * The partitions the args name, as records, such as one per week a player's stats are read across. Every one is
     * fetched if it has never been fetched, and the read re-renders when any of them changes. A record that names no
     * partition keeps its place, so positions line up with the caller's list.
     */
    partitions: PartitionsFrom<ReadyArgs<Args, Optional>, Descriptor>;
}
/**
 * What {@linkcode definePartitions} returns to a store's {@linkcode SqliteStoreConfig.build | build}: the functions
 * that declare the store's reads and caches, lower-level access to its partitions for the store's own code,
 * and the {@linkcode Partitions.lifecycle | lifecycle} group to publish. A partition is the set of rows one fetch
 * returns and replaces.
 */
export interface Partitions<Row extends RowShape, Key, Args, Descriptor> {
    /**
     * Declares a read of one partition: the args name the partition, and {@linkcode ReadDef.select | select} computes the
     * value from its rows. The read fetches the partition when it hasn't been fetched, and re-renders its callers when
     * their args or the rows it used change. It returns {@linkcode CommonDef.empty | empty} until every arg its caller
     * passed has a value and the partition has rows.
     *
     * `defineRead<Args, Value>({ … })`. A read that may be handed an arg without a value names it twice, as the third type
     * argument, which types it, and in {@linkcode CommonDef.optionalArgs | optionalArgs}, which the read checks:
     * `defineRead<Args, Value, 'position'>({ optionalArgs: ['position'], … })`.
     */
    defineRead: <A extends Args, T, Optional extends keyof A = never>(def: ReadDef<A, Key, T, Optional>) => Read<A, T>;
    /**
     * Declares a read across several partitions, such as one player's stats across several weeks, or a row for each of
     * several stat keys: its {@linkcode PartitionReadAcrossDef.partitions | partitions} names them, all of them are
     * fetched and subscribed to, and its {@linkcode ReadAcrossDef.select | select} gets their keys, in order. Declared
     * like {@linkcode Partitions.defineRead | defineRead}.
     */
    defineReadAcross: <A, T, Optional extends keyof A = never>(def: PartitionReadAcrossDef<A, Key, T, Descriptor, Optional>) => ReadAcross<A, T>;
    /**
     * Declares the store's caches: every value it keeps on the heap beyond its rows, in one object, each under a name,
     * with entries kept per partition. Each entry is one of two kinds, named for what a write discards:
     *
     * - {@linkcode byEntity}: one value per entity (an entity is the thing a row belongs to, such as one player, named by
     *   the table's `entityId` column, such
     *   as one player's rows), built from that entity's rows by `fromRows` and rebuilt only when a write changes them. It
     *   returns {@linkcode DerivedValues}, read by partition key and entity id, such as `gamesByTeam.at(key, team)`.
     * - {@linkcode byPartition}: values computed from a whole partition, discarded by any write to it. The value is
     *   computed at the lookup, by the `build` the lookup passes: `summaryMap.for(key).read(() => …)`.
     *
     * A value is built from rows already in the table, on first use; nothing here fetches, since the reads fetch their
     * partitions before their {@linkcode ReadDef.select | select} runs. The store's name and the entry's key name each
     * cache in warnings.
     */
    defineCaches: CacheFactory<Key, Row, Descriptor>;
    /**
     * The column values that pick out a partition's rows in the table, such as `{ league: 'nfl' }`: the store's
     * {@linkcode PartitionKeySpec.where | key.where}.
     */
    where: (key: Key) => Partial<Row>;
    /**
     * The key for a partition record, for a store keyed with {@linkcode PartitionKeySpec.of | of} and
     * {@linkcode PartitionKeySpec.id | id}: runs {@linkcode PartitionKeySpec.id | id}, and remembers the record under the
     * key, so the partition's fetch can get the record back.
     */
    keyOf: (partition: Descriptor) => Key;
    /** The record of the partition `key` names; the reverse of {@linkcode Partitions.keyOf | keyOf}. */
    partitionOf: (key: Key) => Descriptor;
    /** Every partition key whose record is still remembered, from least to most recently used. */
    internedKeys: () => IterableIterator<Key>;
    /**
     * Whether the partition holds any rows. Tracked: inside a tracking scope, the scope re-runs when the partition goes
     * from empty to having rows or back.
     */
    has: (key: Key) => boolean;
    /**
     * The partition's version number: 0 before its first write, and bumped by every write that changes its rows.
     * Tracked: inside a tracking scope, the scope re-runs whenever it changes.
     */
    versionOf: (key: Key) => number;
    /**
     * Tells the partition's readers about a write the store made itself, such as a
     * {@linkcode RowTable.upsert | table.upsert} of a socket push: bumps the partition's version, calls
     * {@linkcode PartitionsConfig.onChanged | onChanged}, and returns the new version. Table writes never notify anyone
     * on their own; fetches call this for you, and anything else that writes rows must.
     *
     * Pass the entities the write changed (the entity ids in its change set), and only readers of those entities
     * re-render; without them, every entity counts as changed. An empty set changes nothing and bumps nothing.
     */
    bump: (key: Key, changes?: ChangeSet) => number;
    /**
     * Deletes the partition's stored ETag, so its next fetch downloads the full body instead of possibly getting a 304.
     */
    clearEtag: (key: Key) => void;
    /**
     * The partition operations for code outside the store's reads (fetching, checking and refetching partitions), ready
     * to publish as-is.
     */
    lifecycle: PartitionLifecycle<Args>;
}
/**
 * Divides a store's table into partitions and builds the store's fetching and reads on them. A partition is the set of
 * rows one fetch returns and replaces, picked out by column values (its {@linkcode PartitionKeySpec.where | where}),
 * such as every player in one league.
 *
 * From the config it builds one React Query query per partition that fetches the partition (sending its stored ETag,
 * and writing the response with the native shredder or {@linkcode PartitionFetchSpec.toRows | toRows}), and bumps the
 * partition's version with the entities the write changed, which re-renders the readers of those entities. It returns
 * the functions that declare the store's reads and caches on those partitions, and the
 * {@linkcode Partitions.lifecycle | lifecycle} operations to publish. Call it from a store's
 * {@linkcode SqliteStoreConfig.build | build}, after {@linkcode RowTable.init | table.init()}.
 */
export declare function definePartitions<Row extends RowShape, Key, Args = Key, Descriptor = Args>(config: PartitionsConfig<Row, Key, Args, Descriptor>): Partitions<Row, Key, Args, Descriptor>;
export type { CommonDef, DataResult, DerivedValues, RawQuery, Read, ReadAcrossDef, ReadDef, RowTable, SqliteStoreConfig, addressesPartition, byEntity, byPartition };
//# sourceMappingURL=define_partitions.d.ts.map