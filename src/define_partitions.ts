/**
 * Divides a store's table into partitions and builds the store's fetching and reads on them.
 *
 * A partition is the set of rows one fetch returns and replaces, such as every player in one league, or one week of one
 * sport's stats. It is picked out by column values (its {@linkcode PartitionKeySpec.where | where}, such as `{ league:
 * 'nfl' }`), and it is the entity of everything fetch-related: one React Query query per partition, one ETag per
 * partition, one version number per partition that re-renders its readers. A read names the partition it reads with its
 * args, and reading a partition that has never been fetched fetches it.
 */


import { cacheKey, cacheKeyOf } from './args_key';
import { createFetchIngest, FetchIngest, RawQuery } from './write/fetch_ingest';
import { createReadSurface, Read, ReadAcross, ReadAcrossDef, ReadDef, ReadyArgs } from './read/surface';
import { RowShape, RowTable, SqlValue } from './table/types';
import { createBoundedLru } from './caches';
import { bindCaches, CacheFactory } from './cache_block';
import { addressesPartition, VersionAtom } from './reactivity/version_atom';
import { PartitionField, partitionKeyOf } from './read/partition_fields';
import { NO_PRIMING, PrimeState } from './prime_state';
import type { DataResult } from './store_result';
import { reportStoreDegradation } from './diagnostics/telemetry';
import type { Loose } from './read/facade';
import { ALL_ENTITIES, ChangeSet, isUnchanged, WriteResult } from './table/change_set';
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

/** How one partition is fetched and written. A fetch replaces the partition's rows with the response's. */
export interface FetchPlan<Row extends RowShape, Key = string> {
  /** The request. Its `queryFn` gets the stored ETag to send as `If-None-Match`; a 304 keeps the rows. */
  query: RawQuery;
  /**
   * The body, as unparsed JSON text, to rows. Runs on web, in tests, without {@linkcode FetchPlan.native | native}, and
   * when the native shred fails.
   */
  toRows: (rawJson: string, key: Key) => readonly Row[];
  /**
   * The store's native program that shreds the body in C++, and its binds from index 1 (bind 0 is the partition key).
   * Omit it for a body the shred can't iterate, such as a single object.
   */
  native?: { variant: string; binds?: readonly SqlValue[] };
  /** The columns the body fills, when it fills only some; the rest keep their stored values. Every column by default. */
  fills?: ReadonlyArray<keyof Row & string>;
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
  /** The plan for a partition, given its record. Omit it for a store fed only by pushes. */
  fetch?: (partition: Descriptor) => FetchPlan<Row, Key>;
  /**
   * Called when a fetch starts; returns the release Cellar calls when it finishes. Holds the partition's pushes in
   * between, which the older response would otherwise overwrite. Return nothing when there are no pushes to hold.
   */
  holdWrites?: (key: Key) => (() => void) | undefined;
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
  /** What Cellar's inspector reads and does by key rather than by args. */
  inspect: {
    /** When the partition's rows last landed from a fetch, or `undefined` if they haven't this session. Untracked. */
    fetchedAt: (key: Key) => number | undefined;
    /** Fetches the partition again, sending its ETag; absent for partitions that don't fetch. */
    refetch?: (key: Key) => void;
  };
}

const INTERN_MAX = 512;
const NO_INTERNED: readonly never[] = Object.freeze([]);
/** The empty record list a read across partitions falls back on when its args name none. */
const NO_DESCRIPTORS: readonly never[] = Object.freeze([]);

/**
 * Divides a store's table into partitions and builds the store's fetching and reads on them. A partition is the set of
 * rows one fetch returns and replaces, picked out by column values (its {@linkcode PartitionKeySpec.where | where}),
 * such as every player in one league.
 *
 * From the config it builds one React Query query per partition that fetches the partition (sending its stored ETag,
 * and writing the response with the native shredder or {@linkcode FetchPlan.toRows | toRows}), and bumps the
 * partition's version with the entities the write changed, which re-renders the readers of those entities. It returns
 * the functions that declare the store's reads and caches on those partitions, and the
 * {@linkcode Partitions.lifecycle | lifecycle} operations to publish. Call it from a store's
 * {@linkcode SqliteStoreConfig.build | build}, after {@linkcode RowTable.init | table.init()}.
 */
export function definePartitions<Row extends RowShape, Key, Args = Key, Descriptor = Args>(
  config: PartitionsConfig<Row, Key, Args, Descriptor>,
): Partitions<Row, Key, Args, Descriptor> {
  const { name, table, version, key: keySpec, fetch: fetchSpec } = config;
  const where = keySpec.where;

  /** A key's parts: its positional form, which reaches only as far as the version and query keys. */
  const fields = keySpec.fields;
  const toParts: (key: Key) => readonly string[] = !fields
    ? (key) => [(key as unknown as string) ?? '']
    : fields.length === 1
    ? (key) => [(key as Record<string, string>)[fields[0]] ?? '']
    : (key) => fields.map((field) => (key as Record<string, string>)[field] ?? '');

  /** The record⇄key mapping. Bounded; every path to a key re-registers, so a live partition's entry stays warm. */
  const toId = keySpec.id;
  const interned = toId ? createBoundedLru<Descriptor>(config.internMax ?? INTERN_MAX) : undefined;
  /** Each record's key, so a store that hands back the same record object for the same args derives its key once. */
  const keyMemo = new WeakMap<object, Key>();
  const keyOf = (partition: Descriptor): Key => {
    if (!toId || !interned) return partition as unknown as Key;
    const memoable = typeof partition === 'object' && partition !== null;
    let key = memoable ? keyMemo.get(partition) : undefined;
    if (key === undefined) {
      key = toId(partition);
      if (memoable) {
        // A record keyed once must never change, or its memoized key would name another partition.
        if (__DEV__) Object.freeze(partition);
        keyMemo.set(partition, key);
      }
    }
    interned.set(key as unknown as string, partition);
    return key;
  };
  /**
   * The key an absent partition maps to: all-empty parts, which {@linkcode addressesPartition} rejects, so nothing is
   * read or primed.
   */
  const GAP_KEY = (fields ? Object.freeze({}) : '') as unknown as Key;
  const keyOfMaybe = (partition: MaybePartition<Descriptor>): Key => (partition == null ? GAP_KEY : keyOf(partition));

  const describe = (key: Key): Descriptor => {
    if (!interned) return key as unknown as Descriptor;
    const partition = interned.get(key as unknown as string);
    if (partition) return partition;

    // Evicted, so re-derive it if the store can. Re-interned on the way past, since something is asking about
    // this partition again and the next ask should be a hit.
    const reparsed = keySpec.from?.(key);
    if (reparsed != null) {
      interned.set(key as unknown as string, reparsed);
      return reparsed;
    }

    // Nothing else in Cellar fails a read outright, and this is the one bound that can. A store whose keys
    // are parseable should declare `from`; one whose keys are not needs a larger `internMax`.
    reportStoreDegradation({
      scope: `partitions.intern_evicted.${name}`,
      group: 'partitions.intern_evicted',
      context: `${name}_store: partition ${String(key)} left the key table, so it cannot be addressed again`,
      extra: { internMax: config.internMax ?? INTERN_MAX },
    });
    throw new Error(`${name}_store: unknown partition ${String(key)}`);
  };

  /**
   * How a read and every {@linkcode Partitions.lifecycle | lifecycle} member gets from args to the key;
   * {@linkcode PartitionKeySpec.of | key.of} reads them at their loosest.
   */
  const keyOfArgs: (args: Args) => Key = keySpec.of
    ? (args) => keyOfMaybe(keySpec.of!(args as Loose<Args>))
    : !fields
    ? (args) => args as unknown as Key
    : // The fields are named against `Key` and here pick out of `Args`, which a read hands over only once each has a value.
      partitionKeyOf<Args, Key>(fields as unknown as readonly PartitionField<Args>[]);

  const bump = (key: Key, changes: ChangeSet = ALL_ENTITIES): number => {
    if (config.remember && interned) {
      const descriptor = interned.get(key as unknown as string);
      if (descriptor) config.remember(key, descriptor);
    }
    const parts = toParts(key);
    if (isUnchanged(changes)) return version.get(parts);
    const next = version.bump(parts, changes);
    config.onChanged?.(key, next, changes);
    return next;
  };

  /** When each partition's rows last landed. Bounded, and a forgotten timestamp reads as never-fetched. */
  const fetchedAt = createBoundedLru<number>(config.internMax ?? INTERN_MAX);

  /** Each request's plan, which writes its body. */
  const planOfQuery = new WeakMap<RawQuery, FetchPlan<Row, Key>>();
  const queryFor = (key: Key): RawQuery => {
    const plan = fetchSpec!(interned ? describe(key) : (key as unknown as Descriptor));
    planOfQuery.set(plan.query, plan);
    return plan.query;
  };

  /** Replaces the partition's rows, through the native shred where the body allows it and JS parsing otherwise. */
  async function ingestRaw(key: Key, rawJson: string, query: RawQuery): Promise<WriteResult> {
    const plan = planOfQuery.get(query);
    if (!plan) throw new Error(`${name}_store: a fetched body arrived for a request this store did not plan`);
    const parse = (raw: string): Row[] => plan.toRows(raw, key) as Row[];
    const result = await table.shred(where(key), rawJson, parse, plan.native, !plan.native, plan.fills);
    fetchedAt.set(cacheKeyOf(toParts(key)), Date.now());
    return result;
  }

  const ingest: FetchIngest<Key> | undefined = fetchSpec
    ? createFetchIngest<Key>({
        ingestKeyRoot: `${name}_store_ingest`,
        version,
        toParts,
        rawQuery: queryFor,
        getEtag: (key) => table.getMeta(where(key)),
        setEtag: (key, etag) => table.setMeta(where(key), etag),
        ingestRaw,
        bump,
        holdWrites: config.holdWrites,
      })
    : undefined;

  const surface = createReadSurface<Key>({
    name,
    version,
    toParts,
    has: (key) => table.has(where(key)),
    hasFetched: (key) => fetchedAt.get(cacheKeyOf(toParts(key))) !== undefined,
    defaultPartition: keySpec.of ? (keyOfArgs as (args: never) => Key) : fields,
    ingest,
  });

  /** Whether the partition holds rows. Tracks, since the surface's probe takes the version on every call. */
  const has = (key: Key): boolean => surface.has(key);
  const versionOf = (key: Key): number => version.get(toParts(key));
  /** What every memo this store declares is bound by: a partition's version, and each entity's. */
  const memoBinding = { parts: toParts, version: versionOf, entityVersion: (key: Key, entityId: string) => version.getEntity(toParts(key), entityId) };

  // Bound once, so the hook a component calls is the same one on every render.
  const usePriming = ingest?.usePrime ?? NO_PRIMING;
  const usePrimingAll = ingest?.usePrimeMany ?? NO_PRIMING;

  /**
   * The key a priming hook's args address. Args short of a value are `keyOfArgs`' business as usual: a missing field
   * becomes an empty part and {@linkcode PartitionKeySpec.of | key.of} answers `null`, and either way
   * {@linkcode addressesPartition} rejects the key, so nothing is primed.
   */
  const keyOfHookArgs = (args: Loose<Args>): Key => keyOfArgs(args as Args);

  /** A read across partitions names them as records; the keys they address are this layer's to resolve. */
  function readAcrossOf<A, T, Optional extends keyof A>(def: PartitionReadAcrossDef<A, Key, T, Descriptor, Optional>): ReadAcross<A, T> {
    const named = def.partitions;
    return surface.readAcross<A, T, Optional>({ ...def, partitions: (args) => (named(args) ?? NO_DESCRIPTORS).map(keyOfMaybe) } as ReadAcrossDef<A, Key, T, Optional>);
  }

  return {
    defineRead: surface.read,
    defineReadAcross: readAcrossOf as Partitions<Row, Key, Args, Descriptor>['defineReadAcross'],
    defineCaches: (decls) => bindCaches(name, memoBinding, decls, { table, filter: where, partitionOf: describe }),
    where,
    keyOf,
    partitionOf: describe,
    internedKeys: () => (interned ? (interned.keys() as IterableIterator<Key>) : NO_INTERNED[Symbol.iterator]()),
    has,
    versionOf,
    bump,
    clearEtag: (key) => table.setMeta(where(key), undefined),
    lifecycle: {
      usePrime: (args, options) => usePriming(args === undefined ? undefined : keyOfHookArgs(args), options?.enabled ?? true),
      usePrimeMany: (args, options) => usePrimingAll(args.map(keyOfArgs), options?.enabled ?? true),
      has: (args) => has(keyOfArgs(args)),
      getVersion: (args) => versionOf(keyOfArgs(args)),
      getFetchedAt: (args) => {
        const parts = toParts(keyOfArgs(args));
        // Read for its tracking side effect, so a derivation gating on this getter hears about the change.
        version.get(parts);
        return fetchedAt.get(cacheKeyOf(parts)) ?? 0;
      },
      fetch: (args, options) => (ingest ? ingest.prefetch(keyOfArgs(args), options).then(() => undefined) : Promise.resolve()),
      refetch: (args) => ingest?.refetch(keyOfArgs(args)),
      invalidate: (args) => ingest?.invalidate(keyOfArgs(args)),
      forget: () => ingest?.forget(),
    },
    inspect: {
      fetchedAt: (key) => fetchedAt.get(cacheKeyOf(toParts(key))),
      // Fetched outright rather than invalidated: an invalidation refetches only a query something is observing, and
      // the partition asked about may have no reader mounted.
      ...(ingest && {
        refetch: (key: Key) => {
          ingest.prefetch(key, { staleTime: 0, via: 'inspector' }).catch(() => {
            /* a failed fetch is the store's to report, as any other */
          });
        },
      }),
    },
  };
}

// Exported so the built declaration files keep these names in scope for the doc links above; an import that only a
// doc comment uses is dropped from them.
export type {
  CommonDef,
  DataResult,
  DerivedValues,
  RawQuery,
  Read,
  ReadAcrossDef,
  ReadDef,
  RowTable,
  SqliteStoreConfig,
  addressesPartition,
  byEntity,
  byPartition,
};
