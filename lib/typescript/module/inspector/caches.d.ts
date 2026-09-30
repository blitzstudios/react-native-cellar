/**
 * Every cache a store has declared, with what it has done since it was built: how often a lookup answered from an
 * entry, how often it had to build, and how often it lost an entry it was asked for again. Registered in development
 * builds only, by the watch each declared cache carries.
 */
/** A {@linkcode byPartition} cache, which holds a value per partition, or a {@linkcode byEntity} one, per entity. */
export type InspectedCacheKind = 'partition' | 'entity';
/** What a cache has done since it was built, counted as it happens. */
export interface CacheStats {
    /** Lookups answered from an entry. */
    hits: number;
    /** Lookups that found an entry built at another version, from before a write. */
    stale: number;
    /** Lookups that found no entry: never built, or evicted. */
    absent: number;
    /** Entries removed to make room. */
    evictions: number;
    /** Lookups for a key that had been evicted to make room: what a larger cache would have answered. */
    rereads: number;
    /** Values built and stored. */
    builds: number;
    /** Builds whose value `isEqual` found equal to the previous one, so the previous object was kept. */
    reused: number;
    /** When the cache was built, as a `Date.now()` timestamp; a store rebuilds its caches when it moves databases. */
    since: number;
}
/** One cache, as the inspector lists it. */
export interface InspectedCache extends CacheStats {
    /** The cache's name, as `store.cache`, such as `player_stats.statRows`. */
    name: string;
    /** The store part of the name, such as `player_stats`. */
    store: string;
    /** The cache part of the name, such as `statRows`. */
    cache: string;
    kind: InspectedCacheKind;
    /** What its entries are keyed by, such as `partition + entity`. */
    keyedBy: string;
    /** How many entries it holds at most. */
    max: number;
    /** How many entries it holds now. */
    entries: number;
}
interface RegisteredCache {
    name: string;
    keyedBy: string;
    kind: InspectedCacheKind;
    max: number;
    stats: CacheStats;
    size: () => number;
}
/** Lists a cache, replacing one listed under its name before, as a store's move to another database rebuilds its caches. */
export declare function registerInspectedCache(cache: RegisteredCache): void;
/** Every listed cache, or the ones of `store` (its name with or without `_store`). */
export declare function inspectedCaches(store?: string): InspectedCache[];
export type { byEntity, byPartition } from '../caches';
//# sourceMappingURL=caches.d.ts.map