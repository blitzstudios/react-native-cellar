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
import { PartitionField } from './partition_fields';
import { shallowEqualValue } from '../caches';
import { VersionAtom } from '../reactivity/version_atom';
import { type PrimeState } from '../prime_state';
import { DataResult, DataStatus } from '../store_result';
import type { PartitionLifecycle, Partitions, definePartitions } from '../define_partitions';
import type { pairRead } from './facade';
import type { shallowEqualStruct } from '../caches';
import type { byEntity } from './derived_values';
import type { StoreSurface } from '../define_sqlite_store';
/**
 * The parts of a store's fetch ingest that its reads use: the hooks that fetch partitions, and imperative fetch starts.
 */
export interface FetchOwner<Key> {
    /** A hook that fetches one partition if it isn't fresh, and returns the fetch's state. */
    usePrime: (key: Key | undefined, enabled: boolean, opts?: {
        slice?: boolean;
    }) => PrimeState;
    /** A hook that fetches each of several partitions that isn't fresh, and returns their combined state. */
    usePrimeMany: (keys: readonly Key[], enabled: boolean, opts?: {
        slice?: boolean;
    }) => PrimeState;
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
     * Turns the read off for some args: while it returns false, the read returns {@linkcode CommonDef.empty | empty} and
     * doesn't run {@linkcode ReadDef.select | select}. For args that name something that can't exist, such as a
     * placeholder id. It doesn't stop the fetch; use {@linkcode CommonDef.prime | prime} or the caller's
     * {@linkcode CommonDef.enabled | enabled} option for that. For args no caller wants fetched, such as a sport the
     * read has nothing for, declare both with the same predicate.
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
     * wanting to fetch them all. Pass a function to decide per call, from the args: a read with nothing to return for
     * some sport can decline to fetch that sport's partition, while other reads of it still fetch. A function that reads
     * an arg its caller didn't pass declines.
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
/** Names a store's reads by their keys in its {@linkcode StoreSurface.reads | reads}, so warnings can say which read. */
export declare function labelReads(reads: object): void;
/** Returns a {@linkcode DataResult} whose identity is stable across renders while its parts hold. */
export declare function useResult<T>(data: T, status: DataStatus, isFetching: boolean, doRefetch: () => void): DataResult<T>;
/**
 * Builds the read engine over one store's partitions: {@linkcode Partitions.defineRead | defineRead} and
 * {@linkcode Partitions.defineReadAcross | defineReadAcross} take a definition and hand back its
 * {@linkcode Read.useValue | useValue} / {@linkcode Read.getValue | getValue} pair, with the readiness gate, the
 * priming, the version subscription and the presence gate already wrapped around {@linkcode ReadDef.select | select}.
 * {@linkcode definePartitions} builds one per store, so stores declare reads.
 */
export declare function createReadSurface<Key>(kernel: ReadSurfaceKernel<Key>): {
    /**
     * Declares a read of one partition: `read<Args, Value>({ … })`, or `read<Args, Value, 'optionalArg'>({ optionalArgs:
     * ['optionalArg'], … })` for a read that may be handed an arg without a value.
     */
    read: <Args, T, Optional extends keyof Args = never>(def: ReadDef<Args, Key, T, Optional>) => Read<Args, T>;
    /** Declares a read across several partitions, whose definition names them: `readAcross<Args, Value>({ … })`. */
    readAcross: <Args, T, Optional extends keyof Args = never>(def: ReadAcrossDef<Args, Key, T, Optional>) => ReadAcross<Args, T>;
    has: (key: Key) => boolean;
};
export type { DataResult, PartitionLifecycle, Partitions, StoreSurface, byEntity, definePartitions, pairRead, shallowEqualStruct, shallowEqualValue };
//# sourceMappingURL=surface.d.ts.map