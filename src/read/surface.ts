/**
 * Reads: how a store turns a read definition into a hook ({@linkcode Read.useValue | useValue}) and a getter
 * ({@linkcode Read.getValue | getValue}).
 *
 * A read names a partition with its args (a partition is the set of rows one fetch returns and replaces), fetches the
 * partition if it has never been fetched, and runs the read's {@linkcode ReadDef.select | select} over the partition's
 * rows to compute its value. It declares none of its args: it is ready once every arg its caller passed has a value,
 * and what it depends on is found by running it. A read caches nothing itself: {@linkcode ReadDef.select | select}
 * returns values from the store's caches (declared in {@linkcode Partitions.defineCaches | defineCaches}), the hook runs
 * it again only when its args or something it read changes, and re-renders its component only when the new value
 * differs.
 */

import { useCallback, useMemo } from 'react';

import { argsKeyOf, cacheKeyOf, KEY_SEP, partitionsKey } from '../args_key';
import { getOrCreate } from '../collections';
import { PartitionField, partitionKeyOf } from './partition_fields';
import { ArgNotPassed, createArgsView } from './args_view';
import { createBoundedLru, createVersionedCache, shallowEqualArray, shallowEqualValue } from '../caches';
import { addressesPartition, NO_PARTS, PartitionEntry, partitionEntries, VersionAtom } from '../reactivity/version_atom';
import { createOnceGuard, onGuardReset } from '../diagnostics/once_guard';
import { shouldLog } from '../diagnostics/log_level';
import { NO_PRIMING, type PrimeState } from '../prime_state';
import { DataResult, DataStatus, makeResult, readStatus } from '../store_result';
import { Dep, runSubscribed, runTracked, trackDependency } from '../reactivity/tracking';
import { useTrackedValue } from '../reactivity/tracked_value';
import { covered, uncoveredReads } from '../table/read_coverage';
import type { PartitionLifecycle, Partitions, definePartitions } from '../define_partitions';
import type { pairRead } from './facade';
import type { shallowEqualStruct } from '../caches';
import type { byEntity } from './derived_values';
import type { StoreSurface } from '../define_sqlite_store';
import type { PrimeIntent } from '../write/fetch_ingest';
import { queryRuntime, type QueryRuntime } from '../runtime';

/**
 * The parts of a store's fetch ingest that its reads use: the hooks that fetch partitions, and imperative fetch starts.
 */
export interface FetchOwner<Key> {
  /** A hook that fetches one partition if it isn't fresh, and returns the fetch's state. */
  usePrime: (key: Key | undefined, enabled: boolean, opts?: { slice?: boolean }) => PrimeState;
  /** A hook that fetches each of several partitions that isn't fresh, and returns their combined state. */
  usePrimeMany: (keys: readonly Key[], enabled: boolean, opts?: { slice?: boolean }) => PrimeState;
  /**
   * Starts fetching a partition, outside a component; used by {@linkcode Read.getValue | getValue} for a partition that
   * has never been fetched.
   */
  ensure: (key: Key) => void;
  /** Fetches a partition again now, however recently it was fetched. */
  refetch: (key: Key) => void;
}

/**
 * What a store's reads need from the store: its version atom, how a partition key becomes its version key, whether a
 * partition has rows or has been fetched, and the fetch ingest. {@linkcode definePartitions} builds this for each
 * store.
 */
export interface ReadSurfaceKernel<Key> {
  /** The store's version atom: the per-partition and per-entity version numbers reads depend on and re-render from. */
  version: VersionAtom;
  /** The store's name, used in the dev warning about a screen making too many separate reads. */
  name?: string;
  /** A partition key's parts: its values as a list of strings, which identify the partition in the version atom. */
  toParts: (key: Key) => readonly string[];
  /**
   * Whether a partition holds any rows. A read runs its {@linkcode ReadDef.select | select} only when the partition has
   * rows.
   */
  has: (key: Key) => boolean;
  /**
   * Whether a partition has been written by a fetch this session. Having rows doesn't answer that: a socket push can
   * write a row into a partition that was never fetched, and that partition still needs fetching.
   */
  hasFetched?: (key: Key) => boolean;
  /**
   * How a read that declares no {@linkcode ReadDef.partition | partition} gets its partition from its args: the store's
   * key fields, or a function for a store whose key is computed from the args.
   */
  defaultPartition?: readonly string[] | ((args: never) => Key);
  /**
   * The store's fetch ingest. A store fed only by pushes has none, and its reads report `success` even with no rows.
   */
  ingest?: FetchOwner<Key>;
}

/**
 * The args a read's functions see ({@linkcode ReadDef.select | select}, its partition, {@linkcode CommonDef.enabled |
 * enabled}): every field non-null, since a read runs only once each arg it was handed has a value, and reading one it
 * wasn't handed stops the function before it sees `undefined`. The fields in `Optional`, the read's
 * {@linkcode CommonDef.optionalArgs | optionalArgs}, keep their `undefined`.
 */
export type ReadyArgs<Args, Optional extends keyof Args = never> = {
  readonly [K in Exclude<keyof Args, Optional>]: NonNullable<Args[K]>;
} & {
  // Mapped over the names rather than `keyof Args`, so the field keeps its `undefined` rather than losing it to `-?`.
  readonly [K in Optional]: Args[K] | undefined;
};

/**
 * The fields both kinds of read definition share: a read of one partition ({@linkcode ReadDef}) and a read across
 * several ({@linkcode ReadAcrossDef}), declared with {@linkcode Partitions.defineRead | defineRead} and
 * {@linkcode Partitions.defineReadAcross | defineReadAcross}.
 *
 * A read declares none of its args. It is ready once every arg its caller passed has a value (`undefined`, `null`,
 * `''` and an empty list count as none; `0` and `false` are values); until then it returns
 * {@linkcode CommonDef.empty | empty}, fetches nothing and runs nothing. A hook runs
 * {@linkcode ReadDef.select | select} again when its args change, compared by content, or when something it read
 * changes. A function of the read that reads an arg the caller didn't pass at all stops, and the read returns
 * {@linkcode CommonDef.empty | empty} as though it weren't ready.
 */
export interface CommonDef<Args, T, Optional extends keyof Args = never> {
  /**
   * Turns the read off for some args: while it returns false, the read returns {@linkcode CommonDef.empty | empty},
   * doesn't run {@linkcode ReadDef.select | select}, and doesn't fetch on this read's behalf. For args the read has
   * nothing for, such as a placeholder id or a sport without the data it reads. Other reads of the same partition
   * still fetch it.
   */
  enabled?: (args: ReadyArgs<Args, Optional>) => boolean;
  /**
   * The args the read may be handed without a value, such as a filter its `select` applies only when there is one.
   * The read is ready without them, and its functions see them as possibly `undefined`. Name the same fields as the
   * definition's third type argument, which is what types them: `defineRead<Args, Value, 'position'>`. An arg only the
   * store's key reads needs neither, since the key reads the args as passed.
   */
  optionalArgs?: readonly Optional[];
  /**
   * What the read returns when it has no value: while its partition has no rows yet, while it is disabled, and while
   * an arg it needs has no value. Use a constant (such as a frozen empty array), not a new object each time, since
   * returning a different object would re-render the caller.
   */
  empty: T;
  /**
   * Compares the read's previous value with a newly computed one. When they're equal, the hook keeps returning the
   * previous object, so its component doesn't re-render. Defaults to {@linkcode shallowEqualValue}, which compares
   * arrays by their elements and plain objects by their values, one level deep; pass one built with
   * {@linkcode shallowEqualStruct} when equality depends on a level deeper.
   */
  isEqual?: (left: T, right: T) => boolean;
  /**
   * Whether reading a partition that has never been fetched fetches it; true by default. Set false for a read that
   * should only use rows something else fetched, such as one that looks in partitions a value might be in without
   * wanting to fetch them all. Pass a function to decide per call, from the args. A function that reads an arg its
   * caller didn't pass declines. A read its {@linkcode CommonDef.enabled | enabled} turns off doesn't fetch either,
   * whatever this says.
   *
   * A fetch loads the whole partition, not just what the read selects, so a read of one row in a large partition pays
   * for all of it. A partition fetch large enough to matter is reported once per session (as an info notice) when
   * every read of it wanted only part of it, which a read shows by taking args beyond those that name its partition.
   */
  prime?: boolean | ((args: ReadyArgs<Args, Optional>) => boolean);
}

/**
 * The definition of a read of one partition. The args name one partition (through
 * {@linkcode ReadDef.partition | partition}, or the store's key by default); the read fetches it if it has never been
 * fetched, and {@linkcode ReadDef.select | select} computes the value from its rows. Nearly every read is this kind;
 * one that spans several partitions is a {@linkcode ReadAcrossDef}.
 */
export interface ReadDef<Args, Key, T, Optional extends keyof Args = never> extends CommonDef<Args, T, Optional> {
  /**
   * How the args name the partition to read: a list of args field names (each holding a string) that make its key,
   * such as `['sport', 'season', 'week']`, or a function returning the key. Defaults to the store's key.
   */
  partition?: readonly PartitionField<Args>[] | ((args: ReadyArgs<Args, Optional>) => Key);
  /**
   * Computes the read's value from the partition's rows, given the args and the partition's key. It runs only once
   * the read is ready and the partition has rows; otherwise the read returns {@linkcode CommonDef.empty | empty}.
   *
   * The read doesn't cache the result: a hook runs {@linkcode ReadDef.select | select} again when its args or something
   * it read changes, and {@linkcode Read.getValue | getValue} runs it on every call. So it should return values from
   * the store's caches, and build anything expensive inside one. If it reads through a {@linkcode byEntity} cache, it
   * depends on just the entities (such as the players) it read, and a write to other entities doesn't re-run it. If it
   * reads the table directly, it depends on the whole partition and runs again after any write to it.
   */
  select: (args: ReadyArgs<Args, Optional>, key: Key) => T;
}

/**
 * The definition of a read across several partitions, fetched and subscribed to together and computed into one value,
 * such as one player's stat rows across several weeks, one partition per week, or a row for each of several stat keys,
 * each of which could be in more than one partition. {@linkcode ReadAcrossDef.select | select} gets the partitions'
 * keys in the order {@linkcode ReadAcrossDef.partitions | partitions} named them.
 */
export interface ReadAcrossDef<Args, Key, T, Optional extends keyof Args = never> extends CommonDef<Args, T, Optional> {
  /**
   * The keys of the partitions the args name. Every one is fetched if it has never been fetched, and the read
   * re-renders when any of them changes. A key that names no partition (from a missing value) keeps its place in the
   * list, so positions line up with the caller's list.
   */
  partitions: (args: ReadyArgs<Args, Optional>) => readonly Key[];
  /**
   * Computes the read's value from the partitions' rows, given their keys in the order
   * {@linkcode ReadAcrossDef.partitions | partitions} returned them. Runs once the read is ready and at least one of
   * the partitions has rows. A read answering several lookups at once finds each one's own partitions from its args.
   */
  select: (args: ReadyArgs<Args, Optional>, keys: readonly Key[]) => T;
}

/**
 * Options one caller passes to a read's {@linkcode Read.useValue | useValue} hook, on top of what the read's definition
 * fixes. They apply to that call only.
 */
export interface ReadCallOptions {
  /**
   * Set false to turn this call off: it returns {@linkcode CommonDef.empty | empty}, fetches nothing, and doesn't
   * subscribe, while the hook stays in place among the component's hooks. True by default. For a component holding args
   * it shouldn't read with yet.
   */
  enabled?: boolean;
  /**
   * Set false to read without fetching, for a component whose parent already fetches the partition. The read still
   * subscribes, and re-renders when the parent's fetch writes the rows.
   *
   * A fetch loads the whole partition, which can be far larger than what one read selects: a read of one player fetches
   * that player's whole league, since `/players/{sport}` is the only endpoint. A list of fifty such reads, each
   * fetching, would be fifty calls for one league. Only `false` is accepted: a caller can decline to fetch, but can't
   * make a read fetch when its definition says `prime: false`.
   */
  prime?: false;
  /**
   * The query `meta` this call's fetch carries, as a React Query hook's options do, so an app whose query hooks gate
   * on it sees it there. A call whose `meta` the runtime's {@linkcode QueryRuntime.bypassesGates | bypassesGates}
   * accepts must stay current while its screen isn't live: it ignores the read gate too, and keeps re-rendering when its
   * data changes. Other calls of the same read keep following the gates.
   */
  meta?: Readonly<Record<string, unknown>>;
}

/**
 * A declared read, as a store's {@linkcode StoreSurface.reads | reads} hold it: a hook
 * ({@linkcode Read.useValue | useValue}) and a getter ({@linkcode Read.getValue | getValue}) that return the same
 * value. Both take the read's args, or `undefined` when the caller doesn't have them yet, which returns
 * {@linkcode CommonDef.empty | empty}.
 */
export interface Read<Args, T> {
  /**
   * The read's current value, for code outside a component. Starts a fetch if the partition has never been fetched (but
   * doesn't refetch a stale one), and returns {@linkcode CommonDef.empty | empty} until it has rows. Tracked: inside a
   * tracking scope (a {@linkcode Read.useValue | useValue} read, `useTrackedStores`, a tracked selector), the scope
   * re-runs when the value changes.
   */
  getValue: (args: Args | undefined) => T;
  /**
   * The read as a hook: fetches the partition if it hasn't been fetched or is stale, returns the value with the
   * fetch's state as a {@linkcode DataResult}, and re-renders the component when the value changes.
   */
  useValue: (args: Args | undefined, options?: ReadCallOptions) => DataResult<T>;
}

/** The element type of a read's value when that value is a list, one entry per partition the read spans. */
export type EachOf<T> = T extends readonly (infer Item)[] ? Item : never;

/**
 * A read across several partitions ({@linkcode Partitions.defineReadAcross | defineReadAcross}). When its value is a
 * list with one entry per partition, in the order its `partitions` names them, {@linkcode ReadAcross.useEach | useEach}
 * reports each entry's own fetch state.
 */
export interface ReadAcross<Args, T> extends Read<Args, T> {
  /**
   * The read as a hook, one {@linkcode DataResult} per partition: entry `i` is the value's `i`th element, `loading`
   * while partition `i` has no rows and its fetch is in flight, and `success` once it has rows, or for a key that
   * names no partition. Use it where each partition is its own answer, such as one season per row of a game log.
   */
  useEach: (args: Args | undefined, options?: ReadCallOptions) => readonly DataResult<EachOf<T>>[];
}

/** Each read's name in its store's {@linkcode StoreSurface.reads | reads}, for dev warnings about that read. */
const readLabels = new WeakMap<object, string>();

/** Names a store's reads by their keys in its {@linkcode StoreSurface.reads | reads}, so warnings can say which read. */
export function labelReads(reads: object): void {
  for (const [name, read] of Object.entries(reads)) if (read && typeof read === 'object') readLabels.set(read, name);
}

/** Stable identities so a disabled read's hooks keep the same deps across renders. */
const NO_KEYS: readonly never[] = Object.freeze([]);
const NO_PARTITIONS: readonly (readonly string[])[] = Object.freeze([]);
const NO_PRESENT: readonly boolean[] = Object.freeze([]);
const NO_ARGS_KEY = `${KEY_SEP}disabled`;

/** Above one viewport's worth of rows: a virtualized list self-limits around 20-30. */
const FANOUT_WARN_THRESHOLD = 48;

/** Entries in a surface's presence cache, which is keyed by partition and so bounds live partitions. */
const PRESENCE_CACHE_MAX = 512;
const fanoutWarned = createOnceGuard();
let fanoutTick: Map<string, { keys: Set<string>; batched: boolean }> | null = null;
onGuardReset(() => {
  fanoutTick = null;
});

function flushFanout(): void {
  const tick = fanoutTick;
  fanoutTick = null;
  if (!shouldLog('warn')) return;
  tick?.forEach((entry, store) => {
    if (entry.keys.size <= FANOUT_WARN_THRESHOLD || fanoutWarned.seen(store)) return;
    const sample = [...entry.keys].slice(0, 3).join(', ');
    // Already-batched callers need the opposite advice from per-row ones: telling a list that reads five ids a row
    // to "use a plural read" describes what it is doing, and it stops reading the warning.
    const remedy = entry.batched
      ? 'These reads are already plural, so the fix is not a plural read but one read higher up: lift it to the ' +
        "parent over the union of what its rows ask for, and let each row index into that result. If the rows' " +
        'sets come from a list the parent already holds, `createWindowedList` resolves them against it.'
      : 'A list is reading per row, which puts one subscription and one hydration on the heap per row. Read the ' +
        "set once in the parent — a plural `*ByIds` read, or `createWindowedList` so rows resolve against the " +
        "parent's list — and let each row index into that.";
    // eslint-disable-next-line no-console
    console.warn(
      `[${store}_store] ${entry.keys.size} separate reads in one tick (e.g. ${sample}). ${remedy} Note that a ` +
        'plural read still primes by PARTITION, not by the ids it asks for, so if this partition is coarse the ' +
        'parent read fetches all of it either way and this is about subscriptions rather than fetching; where the ' +
        'rows are already to hand from the payload that listed them, prefer rendering from those and declaring ' +
        '`prime: false`.',
    );
  });
}

/**
 * `batchSize` is the widest list a call passes, so a caller already asking for a set can be told something else.
 */
function noteRead(store: string, argsKey: string, batchSize: number): void {
  if (fanoutWarned.has(store)) return;
  if (!fanoutTick) {
    fanoutTick = new Map();
    setTimeout(flushFanout, 0);
  }
  const entry = getOrCreate(fanoutTick, store, () => ({ keys: new Set<string>(), batched: false }));
  entry.keys.add(argsKey);
  if (batchSize > 1) entry.batched = true;
}

/** The widest list among a call's args: 1 when it names one thing, which is the per-row shape the warning is for. */
function batchSizeOf(args: object): number {
  let widest = 1;
  for (const value of Object.values(args)) if (Array.isArray(value) && value.length > widest) widest = value.length;
  return widest;
}

/** Returns a {@linkcode DataResult} whose identity is stable across renders while its parts hold. */
export function useResult<T>(data: T, status: DataStatus, isFetching: boolean, doRefetch: () => void): DataResult<T> {
  return useMemo(() => makeResult(data, status, { isFetching, refetch: doRefetch }), [data, status, isFetching, doRefetch]);
}

const SELECTS_SLICE = { slice: true } as const;

/** A call's prime intent, with the query `meta` it passed. */
function intentWith(intent: { slice: boolean } | undefined, meta: Readonly<Record<string, unknown>> | undefined): PrimeIntent | undefined {
  if (!meta) return intent;
  return intent?.slice ? { slice: true, meta } : { meta };
}

/** Whether a call's `meta` marks it as bypassing the read gate, by the app's {@linkcode QueryRuntime.bypassesGates}. */
function bypassesGates(meta: Readonly<Record<string, unknown>> | undefined): boolean {
  return !!meta && !!queryRuntime().bypassesGates?.(meta);
}

/**
 * What a call wants of the partitions it primes: part of them when it passes an arg that naming them didn't read, the
 * way a read of one player passes a player id beside its sport. That is the only shape where an oversized fetch is
 * worth reporting; a call passing nothing else is asking for the partition.
 */
function intentOf(args: object, naming: ReadonlySet<string>): { slice: boolean } | undefined {
  for (const field of Object.keys(args)) if (!naming.has(field)) return SELECTS_SLICE;
  return undefined;
}

/**
 * Whether a read may prime its partitions and whether its {@linkcode ReadDef.select | select} may run. A read primes
 * only when it would read: {@linkcode CommonDef.prime | prime} can decline the fetch of a read that runs, but nothing
 * fetches for one that doesn't.
 */
function readGates(primes: () => boolean, addressable: boolean, primeWanted: boolean, enabled: () => boolean): { prime: boolean; read: boolean } {
  const read = addressable && enabled();
  return {
    // Both the declaration and the call site can veto priming, and neither can override the other: a read that
    // declares `prime: false` never fetches, and a caller passing `prime: false` never fetches, whoever else does.
    prime: read && primeWanted && primes(),
    read,
  };
}

/**
 * The status and {@linkcode DataResult} every read ends with; `hasData` is a thunk, called once the read is known
 * enabled.
 */
function useReadTail<T>(data: T, enabled: boolean, hasData: () => boolean, prime: PrimeState, doRefetch: () => void): DataResult<T> {
  const status = runSubscribed(() => readStatus(enabled, enabled && hasData(), prime));
  return useResult(data, status, prime.isFetching, doRefetch);
}

/** What a read's `select` returned when it stopped on an arg its caller didn't pass. */
const WAITING: unique symbol = Symbol('waiting on an arg');

/** How many times one call may build the same value from rows no cache holds before the read is warned about. */
const UNCACHED_REPEATS_WARN_AT = 3;
const uncachedWarned = createOnceGuard();
const notPassedWarned = createOnceGuard();

/**
 * Builds the read engine over one store's partitions: {@linkcode Partitions.defineRead | defineRead} and
 * {@linkcode Partitions.defineReadAcross | defineReadAcross} take a definition and hand back its
 * {@linkcode Read.useValue | useValue} / {@linkcode Read.getValue | getValue} pair, with the readiness gate, the
 * priming, the version subscription and the presence gate already wrapped around {@linkcode ReadDef.select | select}.
 * {@linkcode definePartitions} builds one per store, so stores declare reads.
 */
export function createReadSurface<Key>(kernel: ReadSurfaceKernel<Key>) {
  const { ingest, toParts } = kernel;
  const store = kernel.name ?? 'cellar';

  const usePriming = ingest?.usePrime ?? NO_PRIMING;
  const usePrimingAll = ingest?.usePrimeMany ?? NO_PRIMING;

  /** Whether each partition holds rows, keyed by partition and shared by every read on this surface. */
  const presenceByVersion = createVersionedCache<boolean>(PRESENCE_CACHE_MAX);
  // Held against the presence version, which moves only on a write that could have emptied or filled the partition,
  // and tracks presence alone: a read of one entity must not come to depend on the whole partition by asking this.
  const hasOne = (key: Key, parts: readonly string[]): boolean =>
    presenceByVersion.read(cacheKeyOf(parts), kernel.version.getPresence(parts), () => covered(() => kernel.has(key)));
  const hasAny = (entries: readonly PartitionEntry<Key>[]): boolean => entries.some((entry) => addressesPartition(entry.parts) && hasOne(entry.key, entry.parts));

  /**
   * Starts an unfetched partition's fetch. Only {@linkcode Read.getValue | getValue} needs it; a reactive read primes
   * through {@linkcode PartitionLifecycle.usePrime | usePrime}. Cold means never fetched, not empty: a partition
   * holding rows a socket pushed into it has never had its body, and gating on rows would leave it on that one row for
   * the session.
   */
  const primeIfCold = (key: Key, parts: readonly string[]): void => {
    if (!ingest) return;
    const fetched = kernel.hasFetched ? kernel.hasFetched(key) : hasOne(key, parts);
    if (!fetched) ingest.ensure(key);
  };

  /** Presence of every partition named, which is what a read reports when it has nothing else to depend on. */
  const trackPresence = (partitions: readonly (readonly string[])[]): void => {
    for (const parts of partitions) if (addressesPartition(parts)) kernel.version.getPresence(parts);
  };

  /**
   * Everything one read does around its functions: seeing its args through its view, running
   * {@linkcode ReadDef.select | select} so its result depends on enough, and, in dev, noticing a select that keeps
   * building the same value from rows no cache holds.
   */
  const readRunner = (optional: readonly PropertyKey[] | undefined) => {
    const view = createArgsView(optional);
    const repeats = __DEV__ ? createBoundedLru<{ stamp: string; count: number }>(64) : undefined;
    let self: object | undefined;
    const label = (): string => (self && readLabels.get(self)) ?? 'a read';

    const noteNotPassed = (field: string): void => {
      if (!__DEV__ || notPassedWarned.seen(store, label(), field)) return;
      // eslint-disable-next-line no-console
      console.warn(
        `[${store}_store] \`${label()}\` read the arg \`${field}\`, which its caller didn't pass, so it returns its empty ` +
          "value until the caller passes one. Pass it, as `null` while it isn't known yet, or name it in the read's `optionalArgs`.",
      );
    };

    const noteUncached = (argsKey: string, partitions: readonly (readonly string[])[]): void => {
      if (!repeats || uncachedWarned.has(store, label())) return;
      // Read in a scope of its own, so taking the stamp doesn't subscribe the caller to anything more.
      const stamp = runTracked(() => partitions.map((parts) => (addressesPartition(parts) ? kernel.version.get(parts) : '')).join(',')).value;
      const held = repeats.get(argsKey);
      const count = held && held.stamp === stamp ? held.count + 1 : 1;
      repeats.set(argsKey, { stamp, count });
      if (count < UNCACHED_REPEATS_WARN_AT || uncachedWarned.seen(store, label())) return;
      // eslint-disable-next-line no-console
      console.warn(
        `[${store}_store] \`${label()}\` built its value from rows no cache holds ${count} times for the same args and ` +
          'the same rows: a read keeps nothing, so every subscriber and every getValue call builds it again. Build it ' +
          "inside a cache in the store's defineCaches block (a byPartition cache keyed by what varies), or leave it " +
          'uncached on purpose if one screen holds it.',
      );
    };

    /** A read's `enabled` or `prime` over its args: true when absent, and false when it reads an arg not passed. */
    const predicate = (args: object, fn: ((args: never) => boolean) | undefined): boolean => {
      if (!fn) return true;
      try {
        return view.run(args, fn);
      } catch (error) {
        if (error instanceof ArgNotPassed) return false;
        throw error;
      }
    };

    return {
      view,
      bind: (read: object) => {
        self = read;
      },
      /**
       * Runs `fn` (a read's `select`, over its args) and makes sure the result depends on enough. A `select` built
       * from caches reports what it read and depends on that alone. One that read rows straight off the table, or
       * reported nothing at all, is made to depend on every partition it named: it could have read anything in them.
       * One that stopped on an arg its caller didn't pass depends on presence alone, and returns {@linkcode WAITING}.
       */
      select<T>(partitions: readonly (readonly string[])[], argsKey: () => string, fn: () => T): T | typeof WAITING {
        const before = uncoveredReads();
        let result: { value: T; deps: readonly Dep[] };
        try {
          result = runTracked(fn);
        } catch (error) {
          if (!(error instanceof ArgNotPassed)) throw error;
          noteNotPassed(error.field);
          trackPresence(partitions);
          return WAITING;
        }
        for (const dep of result.deps) trackDependency(dep);
        const uncovered = uncoveredReads() !== before;
        if (!result.deps.length || uncovered) for (const parts of partitions) if (addressesPartition(parts)) kernel.version.get(parts);
        if (__DEV__ && uncovered) noteUncached(argsKey(), partitions);
        return result.value;
      },
      /** Whether `enabled` lets the read run; an `enabled` that reads an arg its caller didn't pass doesn't. */
      enabled: (args: object, enabled: ((args: never) => boolean) | undefined): boolean => predicate(args, enabled),
      /** Whether `prime` lets the read fetch; a `prime` that reads an arg its caller didn't pass doesn't. */
      primes: (args: object, prime: boolean | ((args: never) => boolean) | undefined): boolean =>
        typeof prime === 'function' ? predicate(args, prime) : prime ?? true,
    };
  };

  function readOne<Args, T, Optional extends keyof Args>(def: ReadDef<Args, Key, T, Optional>): Read<Args, T> {
    const spec = def.partition ?? (kernel.defaultPartition as readonly PartitionField<Args>[] | ((args: ReadyArgs<Args, Optional>) => Key) | undefined);
    if (!spec) throw new Error(`${store}_store: this read needs a \`partition\`, since the store's key declares no \`fields\` to default to`);
    const keyOf = partitionKeyOf<ReadyArgs<Args, Optional>, Key>(spec as readonly PartitionField<ReadyArgs<Args, Optional>>[] | ((args: ReadyArgs<Args, Optional>) => Key));
    const runner = readRunner(def.optionalArgs);
    const { view } = runner;
    // The store's key and a field list read the args as passed: the key is shared by reads that take different args,
    // and a missing value names no partition. A read's own `partition` function sees the view, like its `select`.
    const keyIsLenient = typeof def.partition !== 'function';

    /** Where a call stands: waiting, or ready with its partition and what it wants of it. */
    const resolve = (args: Args | undefined) => {
      if (args === undefined || !view.ready(args as object)) return undefined;
      try {
        const { value: key, read } = view.record(args as object, keyOf as (view: never) => Key, keyIsLenient);
        return { key, parts: toParts(key), intent: intentOf(args as object, read) };
      } catch (error) {
        if (error instanceof ArgNotPassed) return undefined;
        throw error;
      }
    };

    const gatesFor = (args: Args, parts: readonly string[], wanted: boolean, primeWanted = true) =>
      readGates(
        () => runner.primes(args as object, def.prime as boolean | ((args: never) => boolean) | undefined),
        wanted && addressesPartition(parts),
        primeWanted,
        () => runner.enabled(args as object, def.enabled as ((args: never) => boolean) | undefined),
      );

    const run = (args: Args, key: Key, parts: readonly string[], argsKey: () => string): T => {
      const value = runner.select([parts], argsKey, () => view.run(args as object, (ready: ReadyArgs<Args, Optional>) => def.select(ready, key)));
      return value === WAITING ? def.empty : value;
    };

    function getValue(args: Args | undefined): T {
      const call = resolve(args);
      if (!call || !addressesPartition(call.parts)) return def.empty;
      const { key, parts } = call;
      const gates = gatesFor(args as Args, parts, true);
      if (gates.prime) primeIfCold(key, parts);
      // Every path reports something to the scope above it, so a derivation that got `empty` here still hears when
      // the partition lands: presence for a disabled or cold read, and whatever `select` read otherwise.
      if (!gates.read) {
        kernel.version.getPresence(parts);
        return def.empty;
      }
      if (!hasOne(key, parts)) return def.empty;
      return run(args as Args, key, parts, () => argsKeyOf(parts, args as object));
    }

    function useValue(args: Args | undefined, options?: ReadCallOptions): DataResult<T> {
      // A call that isn't ready addresses nothing; the hooks below still run, reading nothing.
      const call = resolve(args);
      const key = call?.key;
      const parts = call ? call.parts : NO_PARTS;
      const gates = gatesFor(args as Args, parts, (options?.enabled ?? true) && call !== undefined, options?.prime ?? true);
      const prime = usePriming(key, gates.prime, intentWith(call?.intent, options?.meta));
      const argsKey = call ? argsKeyOf(parts, args as object) : NO_ARGS_KEY;
      if (__DEV__ && gates.read) noteRead(store, argsKey, batchSizeOf(args as object));
      const data = useTrackedValue<T>(() => (hasOne(key as Key, parts) ? run(args as Args, key as Key, parts, () => argsKey) : def.empty), [argsKey], {
        enabled: gates.read,
        isEqual: def.isEqual ?? shallowEqualValue,
        empty: def.empty,
        bypassGate: bypassesGates(options?.meta),
      });
      const doRefetch = useCallback(() => {
        if (key !== undefined) ingest?.refetch(key);
      }, [argsKey]); // eslint-disable-line react-hooks/exhaustive-deps -- `argsKey` covers `key`
      return useReadTail(data, gates.read, () => addressesPartition(parts) && hasOne(key as Key, parts), prime, doRefetch);
    }

    const read: Read<Args, T> = { getValue, useValue };
    runner.bind(read);
    return read;
  }

  /** A read across several partitions, whose definition names them. */
  function readAcross<Args, T, Optional extends keyof Args>(def: ReadAcrossDef<Args, Key, T, Optional>): ReadAcross<Args, T> {
    const runner = readRunner(def.optionalArgs);
    const emptyEach: { value: T; present: readonly boolean[] } = { value: def.empty, present: NO_PRESENT };
    const { view } = runner;
    const partitionsArgsKey = (partitions: readonly (readonly string[])[], args: object): string => argsKeyOf([partitionsKey(partitions)], args);

    /** Where a call stands: waiting, or ready with its partitions and what it wants of them. */
    const resolve = (args: Args | undefined) => {
      if (args === undefined || !view.ready(args as object)) return undefined;
      try {
        const { value: keys, read } = view.record(args as object, def.partitions as (view: never) => readonly Key[]);
        const entries = partitionEntries(keys, toParts);
        return { keys, entries, partitions: entries.map((entry) => entry.parts), intent: intentOf(args as object, read) };
      } catch (error) {
        if (error instanceof ArgNotPassed) return undefined;
        throw error;
      }
    };

    /**
     * {@linkcode Partitions.defineRead | defineRead}'s gates over a set: addressable when at least one partition is,
     * since the rest are gaps.
     */
    const gatesFor = (args: Args, partitions: readonly (readonly string[])[], wanted: boolean, primeWanted = true) =>
      readGates(
        () => runner.primes(args as object, def.prime as boolean | ((args: never) => boolean) | undefined),
        wanted && partitions.some(addressesPartition),
        primeWanted,
        () => runner.enabled(args as object, def.enabled as ((args: never) => boolean) | undefined),
      );

    const run = (args: Args, keys: readonly Key[], partitions: readonly (readonly string[])[], argsKey: () => string): T => {
      const value = runner.select(partitions, argsKey, () => view.run(args as object, (ready: ReadyArgs<Args, Optional>) => def.select(ready, keys)));
      return value === WAITING ? def.empty : value;
    };

    function getValue(args: Args | undefined): T {
      const call = resolve(args);
      if (!call) return def.empty;
      const gates = gatesFor(args as Args, call.partitions, true);
      if (gates.prime) for (const entry of call.entries) if (addressesPartition(entry.parts)) primeIfCold(entry.key, entry.parts);
      // `hasAny` stops at the first partition holding rows, so the rest are reported here for a read that lands later.
      trackPresence(call.partitions);
      if (!gates.read || !hasAny(call.entries)) return def.empty;
      return run(args as Args, call.keys, call.partitions, () => partitionsArgsKey(call.partitions, args as object));
    }

    function useValue(args: Args | undefined, options?: ReadCallOptions): DataResult<T> {
      const call = resolve(args);
      const keys = call ? call.keys : (NO_KEYS as readonly Key[]);
      const entries = call ? call.entries : [];
      const partitions = call ? call.partitions : NO_PARTITIONS;
      const gates = gatesFor(args as Args, partitions, (options?.enabled ?? true) && call !== undefined, options?.prime ?? true);
      const prime = usePrimingAll(keys, gates.prime, intentWith(call?.intent, options?.meta));
      const argsKey = call ? partitionsArgsKey(partitions, args as object) : NO_ARGS_KEY;
      const data = useTrackedValue<T>(
        () => {
          trackPresence(partitions);
          return hasAny(entries) ? run(args as Args, keys, partitions, () => argsKey) : def.empty;
        },
        [argsKey],
        { enabled: gates.read, isEqual: def.isEqual ?? shallowEqualValue, empty: def.empty, bypassGate: bypassesGates(options?.meta) },
      );
      const doRefetch = useCallback(() => {
        for (const key of keys) ingest?.refetch(key);
      }, [argsKey]); // eslint-disable-line react-hooks/exhaustive-deps -- `argsKey` covers `keys`
      return useReadTail(data, gates.read, () => hasAny(entries), prime, doRefetch);
    }

    function useEach(args: Args | undefined, options?: ReadCallOptions): readonly DataResult<EachOf<T>>[] {
      const call = resolve(args);
      const keys = call ? call.keys : (NO_KEYS as readonly Key[]);
      const entries = call ? call.entries : [];
      const partitions = call ? call.partitions : NO_PARTITIONS;
      const gates = gatesFor(args as Args, partitions, (options?.enabled ?? true) && call !== undefined, options?.prime ?? true);
      const prime = usePrimingAll(keys, gates.prime, intentWith(call?.intent, options?.meta));
      const argsKey = call ? partitionsArgsKey(partitions, args as object) : NO_ARGS_KEY;
      const isEqual = def.isEqual ?? shallowEqualValue;
      // Which partitions hold rows is part of the tracked value, so one landing re-renders even when the value it adds
      // compares equal to the empty one it replaces.
      const tracked = useTrackedValue<{ value: T; present: readonly boolean[] }>(
        () => {
          trackPresence(partitions);
          const present = entries.map((entry) => addressesPartition(entry.parts) && hasOne(entry.key, entry.parts));
          return { value: present.some(Boolean) ? run(args as Args, keys, partitions, () => argsKey) : def.empty, present };
        },
        [argsKey],
        {
          enabled: gates.read,
          isEqual: (left, right) => isEqual(left.value, right.value) && shallowEqualArray(left.present, right.present),
          empty: emptyEach,
          bypassGate: bypassesGates(options?.meta),
        },
      );
      const doRefetch = useCallback(() => {
        for (const key of keys) ingest?.refetch(key);
      }, [argsKey]); // eslint-disable-line react-hooks/exhaustive-deps -- `argsKey` covers `keys`
      return useMemo(
        () =>
          entries.map((entry, index) => {
            const live = gates.read && addressesPartition(entry.parts);
            const status = runSubscribed(() => readStatus(live, live && !!tracked.present[index], prime));
            const items = tracked.value as unknown as readonly EachOf<T>[] | undefined;
            return makeResult(items?.[index] as EachOf<T>, status, { isFetching: prime.isFetching, refetch: doRefetch });
          }),
        // `argsKey` covers `entries`; the prime state's fields, not its object, since the object is rebuilt each render.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [tracked, argsKey, gates.read, prime.isInitialLoading, prime.isError, prime.isFetching, doRefetch],
      );
    }

    const read: ReadAcross<Args, T> = { getValue, useValue, useEach };
    runner.bind(read);
    return read;
  }

  /** The surface's cached presence probe, so a store asks the same question the reads gate on. */
  const has = (key: Key): boolean => hasOne(key, toParts(key));

  return {
    /**
     * Declares a read of one partition: `read<Args, Value>({ … })`, or `read<Args, Value, 'optionalArg'>({ optionalArgs:
     * ['optionalArg'], … })` for a read that may be handed an arg without a value.
     */
    read: readOne as <Args, T, Optional extends keyof Args = never>(def: ReadDef<Args, Key, T, Optional>) => Read<Args, T>,
    /** Declares a read across several partitions, whose definition names them: `readAcross<Args, Value>({ … })`. */
    readAcross: readAcross as <Args, T, Optional extends keyof Args = never>(def: ReadAcrossDef<Args, Key, T, Optional>) => ReadAcross<Args, T>,
    has,
  };
}

// Exported so the built declaration files keep these names in scope for the doc links above; an import that only a
// doc comment uses is dropped from them.
export type { DataResult, PartitionLifecycle, Partitions, StoreSurface, byEntity, definePartitions, pairRead, QueryRuntime, shallowEqualStruct, shallowEqualValue };
