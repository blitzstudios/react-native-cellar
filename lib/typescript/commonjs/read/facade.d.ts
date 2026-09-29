/**
 * The types a store's service (its public API, such as `playerService`) is written with, and {@linkcode pairRead},
 * which publishes each of a store's reads as a hook and a getter taking one `{ params, options }` argument.
 */
import type { EachOf, Read, ReadAcross, ReadCallOptions } from './surface';
import type { DataResult } from '../store_result';
import type { CommonDef } from './surface';
import type { RawQuery } from '../write/fetch_ingest';
/**
 * An id a caller may not have yet, such as a route param still loading. A published read accepts it as is, and returns
 * {@linkcode CommonDef.empty | empty} until it has a value (`undefined`, `null` and `''` count as not having one).
 */
export type MaybeId = string | undefined | null;
/** The {@linkcode ReadOptions.options | options} part of a published read hook's argument, `{ params, options }`. */
export type ReadOptions = {
    /**
     * Options for this call only: `enabled: false` turns the read off (it returns {@linkcode CommonDef.empty | empty} and
     * fetches nothing) while the hook stays in place, and `prime: false` reads without fetching, for a component whose
     * parent fetches.
     */
    options?: ReadCallOptions;
};
/**
 * `T` with every value nullable. A published read takes its params this way: a caller passes every field `T` requires,
 * each as a value it may not have yet (`string | null | undefined`), and the read returns
 * {@linkcode CommonDef.empty | empty} until they arrive. A field `T` makes optional may still be left out.
 */
export type Loose<T> = {
    [K in keyof T]: T[K] | null | undefined;
};
/**
 * A store read as a service publishes it (from {@linkcode pairRead}): a hook for components and a getter for other
 * code, which return the same value. The hook is named with `use` so React Compiler treats it as a hook rather than
 * memoizing the call away.
 */
export interface PairedRead<Params, T> {
    /**
     * The read as a hook: fetches its partition if it hasn't been fetched or is stale, returns the value with the fetch's
     * state as a {@linkcode DataResult}, and re-renders the component when the value changes. Returns
     * {@linkcode CommonDef.empty | empty}, and fetches nothing, until every field it was passed has a value.
     */
    useValue: (args: {
        /**
         * The read's args. Every value is nullable; the read returns {@linkcode CommonDef.empty | empty} until each has
         * one, apart from the read's {@linkcode CommonDef.optionalArgs | optionalArgs}.
         */
        params: Params;
    } & ReadOptions) => DataResult<T>;
    /**
     * The read's current value, for code outside a component. Starts a fetch if the partition has never been fetched (but
     * doesn't refetch a stale one), and returns {@linkcode CommonDef.empty | empty} until it has rows. Tracked: inside a
     * tracking scope (a {@linkcode PairedRead.useValue | useValue} read, `useTrackedStores`, a tracked selector), the
     * scope re-runs when the value changes.
     */
    getValue: (args: {
        /**
         * The read's args. Every value is nullable; the read returns {@linkcode CommonDef.empty | empty} until each has
         * one, apart from the read's {@linkcode CommonDef.optionalArgs | optionalArgs}.
         */
        params: Params;
    }) => T;
}
/**
 * Publishes a store read as a hook ({@linkcode Read.useValue | useValue}) and a getter
 * ({@linkcode Read.getValue | getValue}) for a service's public API, each taking one `{ params }` argument. `read`
 * returns the read from the store, such as `() => playerStore.reads.byId`; it is called on every use, so it always
 * reaches the read built over the store's current database. The params are the read's args with every value nullable,
 * and both return {@linkcode CommonDef.empty | empty} until each has one (`undefined`, `null`, `''` and an empty list
 * count as none), apart from the read's {@linkcode CommonDef.optionalArgs | optionalArgs}: the read itself waits for
 * them, fetching nothing meanwhile.
 *
 * The two return the same value but fetch differently. {@linkcode Read.useValue | useValue} fetches through React
 * Query, and refetches when the partition is older than its {@linkcode RawQuery.staleTime | staleTime}.
 * {@linkcode Read.getValue | getValue} fetches only a partition that has never been fetched: a one-off call has no
 * component to refresh, and a getter called in a loop would otherwise flood the network.
 */
export declare function pairRead<Args, T>(read: () => ReadAcross<Args, T>): PairedReadAcross<Loose<Args>, T>;
export declare function pairRead<Args, T>(read: () => Read<Args, T>): PairedRead<Loose<Args>, T>;
/** A read across several partitions as a service publishes it: {@linkcode PairedRead}, plus its per-partition hook. */
export interface PairedReadAcross<Params, T> extends PairedRead<Params, T> {
    /** One `DataResult` per partition the args name, in order: {@linkcode ReadAcross.useEach}. */
    useEach: (args: {
        params: Params;
    } & ReadOptions) => readonly DataResult<EachOf<T>>[];
}
/** Every read of a store, paired: what {@linkcode publishReads} hands back. */
export type PublishedReads<Reads> = {
    readonly [K in keyof Reads]: Reads[K] extends ReadAcross<infer A, infer T> ? PairedReadAcross<Loose<A>, T> : Reads[K] extends Read<infer A, infer T> ? PairedRead<Loose<A>, T> : never;
};
/**
 * Every one of a store's reads, published as a hook and a getter ({@linkcode pairRead}), under the read's own name.
 * `reads` is called on every use, like `pairRead`'s, so a read always reaches the store's current database. Nothing
 * can be published one way only: each read's pair exists as soon as the store declares the read.
 */
export declare function publishReads<Reads extends object>(reads: () => Reads): PublishedReads<Reads>;
/** The version hook a store's lifecycle has, which a lookup subscribes to: `store.lifecycle.usePrimeAndVersion`. */
export type UsePrimeAndVersion<KeyArgs> = (args: Loose<KeyArgs> | undefined, options?: {
    enabled?: boolean;
    bypassGates?: boolean;
}) => DataResult<number>;
/**
 * A hook returning a function that looks one entry up in a partition, such as a sport's players by id: `lookup(rest)`
 * is `read`'s value for the partition's args plus `rest`. The hook fetches the partition, and the function's identity
 * changes whenever the partition does, so a component that passes it down re-renders its children then and only then.
 */
export declare function lookupRead<KeyArgs extends object, Rest extends object, T>(usePrimeAndVersion: () => UsePrimeAndVersion<KeyArgs>, read: () => Read<KeyArgs & Rest, T>): (args: {
    params: Loose<KeyArgs>;
} & ReadOptions) => (rest: Loose<Rest>) => T;
export type { CommonDef, DataResult, RawQuery, Read };
//# sourceMappingURL=facade.d.ts.map