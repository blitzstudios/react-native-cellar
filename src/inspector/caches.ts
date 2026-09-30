/**
 * Every cache a store has declared, with what it has done since it was built: how often a lookup answered from an
 * entry, how often it had to build, and how often it lost an entry it was asked for again. Registered in development
 * builds only, by the watch each declared cache carries.
 */

import type { BoundedLru } from '../caches';
import { KEY_SEP } from '../key';
import { GROUP_SEP } from '../args_key';
import { estimateHeap, estimateInto, previewValue } from './heap';
import type { HeapEstimate } from './heap';

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
  /**
   * Roughly what its entries hold on the JS heap, in bytes, with what each entry costs the cache itself; present when
   * asked for. Each entry is estimated on its own, so an object two entries share counts in both.
   */
  heapBytes?: number;
  /** Whether some entry was too large to walk whole, so {@linkcode InspectedCache.heapBytes | heapBytes} is a floor. */
  heapPartial?: boolean;
}

/** One cache entry, for a development tool to show. */
export interface InspectedCacheEntry {
  /** The entry's key, split into its parts: the partition's, then the entity's and any others; objects appear as `#n`. */
  key: string[];
  /** The version the entry was built at. */
  version: number;
  /** Roughly what the entry holds on the JS heap, in bytes. */
  heapBytes: number;
  /** The value, previewed: see {@linkcode previewValue}. */
  value: unknown;
}

/** A page of a cache's entries, most recently used first. */
export interface InspectedCacheEntries {
  total: number;
  offset: number;
  entries: InspectedCacheEntry[];
}

type CacheSlot = { version: number; value: unknown };

interface RegisteredCache {
  name: string;
  keyedBy: string;
  kind: InspectedCacheKind;
  max: number;
  stats: CacheStats;
  table: BoundedLru<CacheSlot>;
}

/** What one entry costs the cache besides its value: its recency node, its map entry and its version slot. */
const ENTRY_OVERHEAD_BYTES = 170;

/** Each slot's estimate, kept with the slot, which a rebuild replaces: only a new or rebuilt entry is walked. */
const slotBytes = new WeakMap<CacheSlot, { bytes: number; partial: boolean }>();

function bytesOf(key: string, slot: CacheSlot): { bytes: number; partial: boolean } {
  let known = slotBytes.get(slot);
  if (!known) {
    const estimate = estimateHeap(slot.value);
    known = { bytes: estimate.bytes, partial: estimate.partial };
    slotBytes.set(slot, known);
  }
  return { bytes: known.bytes + ENTRY_OVERHEAD_BYTES + 16 + key.length, partial: known.partial };
}

function heapOf(table: BoundedLru<CacheSlot>): { heapBytes: number; heapPartial: boolean } {
  let heapBytes = 0;
  let heapPartial = false;
  for (const [key, slot] of table.entries()) {
    const { bytes, partial } = bytesOf(key, slot);
    heapBytes += bytes;
    heapPartial ||= partial;
  }
  return { heapBytes, heapPartial };
}

const caches = new Map<string, RegisteredCache>();

/** Lists a cache, replacing one listed under its name before, as a store's move to another database rebuilds its caches. */
export function registerInspectedCache(cache: RegisteredCache): void {
  if (__DEV__) caches.set(cache.name, cache);
}

/** What a store's caches hold on the heap together. */
export interface InspectedCachesHeap {
  /** Roughly what they hold, counting an object that two entries or two caches share once. */
  heapBytes: number;
  /** How much of the caches' own estimates is objects they share: their sum less {@linkcode heapBytes}. */
  sharedBytes: number;
  /** Whether the walk stopped at its limit, so the figures are floors. */
  partial: boolean;
}

/** A store walk counts at most this many objects. */
const STORE_WALK_OBJECTS = 1_000_000;
const storeHeaps = new Map<string, { signature: string; heap: InspectedCachesHeap }>();

/**
 * What `store`'s caches hold on the heap together, walked with one set of seen objects so that a row one cache hands
 * back and another indexes counts once. The walk visits every entry, so it is kept until a cache changes.
 */
export function inspectedCachesHeap(store: string): InspectedCachesHeap {
  const prefix = `${store.replace(/_store$/, '')}.`;
  const list = Array.from(caches.values()).filter((cache) => cache.name.startsWith(prefix));
  const signature = list.map(({ name, stats, table }) => `${name}:${stats.builds}:${stats.evictions}:${table.size}`).join('|');
  const known = storeHeaps.get(prefix);
  if (known?.signature === signature) return known.heap;
  const estimate: HeapEstimate = { bytes: 0, objects: 0, partial: false };
  const seen = new Set<object>();
  let separate = 0;
  for (const { table } of list) {
    for (const [key, slot] of table.entries()) {
      estimate.bytes += ENTRY_OVERHEAD_BYTES + 16 + key.length;
      estimateInto(slot.value, estimate, seen, STORE_WALK_OBJECTS);
      separate += bytesOf(key, slot).bytes;
    }
  }
  const heap = { heapBytes: estimate.bytes, sharedBytes: Math.max(0, separate - estimate.bytes), partial: estimate.partial };
  storeHeaps.set(prefix, { signature, heap });
  return heap;
}

/** Options for {@linkcode inspectedCaches}. */
export interface InspectedCachesOptions {
  /** Estimates what each cache holds on the JS heap; only entries built since the last estimate are walked. */
  heap?: boolean;
}

/** Every listed cache, or the ones of `store` (its name with or without `_store`). */
export function inspectedCaches(store?: string, options: InspectedCachesOptions = {}): InspectedCache[] {
  const prefix = store === undefined ? undefined : `${store.replace(/_store$/, '')}.`;
  const out: InspectedCache[] = [];
  for (const { name, keyedBy, kind, max, stats, table } of caches.values()) {
    if (prefix && !name.startsWith(prefix)) continue;
    const dot = name.indexOf('.');
    out.push({ name, store: name.slice(0, dot), cache: name.slice(dot + 1), kind, keyedBy, max, entries: table.size, ...stats, ...(options.heap ? heapOf(table) : {}) });
  }
  return out;
}

/** The entries of `store`'s per-entity caches for one entity of one partition; looking doesn't count as using. */
export function inspectedEntityCacheEntries(store: string, partitionKey: string, entityId: string): Array<InspectedCacheEntry & { cache: string }> {
  const prefix = `${store.replace(/_store$/, '')}.`;
  const split = new RegExp(`[${KEY_SEP}${GROUP_SEP}]`);
  const out: Array<InspectedCacheEntry & { cache: string }> = [];
  for (const { name, kind, table } of caches.values()) {
    if (kind !== 'entity' || !name.startsWith(prefix)) continue;
    for (const [key, slot] of table.entries()) {
      const parts = key.split(split);
      // An entity cache's key is the partition, then the entity, then any other parts.
      if (parts[0] !== partitionKey || parts[1] !== entityId) continue;
      out.push({ cache: name.slice(prefix.length), key: parts, version: slot.version, heapBytes: bytesOf(key, slot).bytes, value: previewValue(slot.value) });
    }
  }
  return out;
}

/** A page of the cache `name`'s entries, most recently used first; looking doesn't count as using. */
export function inspectedCacheEntries(name: string, page: { offset?: number; limit?: number } = {}): InspectedCacheEntries {
  const cache = caches.get(name);
  if (!cache) throw new Error(`Unknown cache "${name}".`);
  const offset = Math.max(0, page.offset ?? 0);
  const limit = Math.max(1, Math.min(page.limit ?? 50, 500));
  const all = Array.from(cache.table.entries()).reverse();
  return {
    total: all.length,
    offset,
    entries: all.slice(offset, offset + limit).map(([key, slot]) => ({
      key: key.split(new RegExp(`[${KEY_SEP}${GROUP_SEP}]`)),
      version: slot.version,
      heapBytes: bytesOf(key, slot).bytes,
      value: previewValue(slot.value),
    })),
  };
}

// Exported so the built declaration files keep these names in scope for the doc links above; an import that only a
// doc comment uses is dropped from them.
export type { byEntity, byPartition } from '../caches';
