"use strict";

/**
 * Every cache a store has declared, with what it has done since it was built: how often a lookup answered from an
 * entry, how often it had to build, and how often it lost an entry it was asked for again. Registered in development
 * builds only, by the watch each declared cache carries.
 */

import { KEY_SEP } from "../key.js";
import { GROUP_SEP } from "../args_key.js";
import { estimateHeap, estimateIntoSliced, previewValue, sliceClock } from "./heap.js";

/** A {@linkcode byPartition} cache, which holds a value per partition, or a {@linkcode byEntity} one, per entity. */

/** What a cache has done since it was built, counted as it happens. */

/** One cache, as the inspector lists it. */

/** One cache entry, for a development tool to show. */

/** A page of a cache's entries, most recently used first. */

/** What one entry costs the cache besides its value: its recency node, its map entry and its version slot. */
const ENTRY_OVERHEAD_BYTES = 170;

/** Each slot's estimate, kept with the slot, which a rebuild replaces: only a new or rebuilt entry is walked. */
const slotBytes = new WeakMap();
function bytesOf(key, slot) {
  let known = slotBytes.get(slot);
  if (!known) {
    const estimate = estimateHeap(slot.value);
    known = {
      bytes: estimate.bytes,
      partial: estimate.partial
    };
    slotBytes.set(slot, known);
  }
  return {
    bytes: known.bytes + ENTRY_OVERHEAD_BYTES + 16 + key.length,
    partial: known.partial
  };
}
function heapOf(table) {
  let heapBytes = 0;
  let heapPartial = false;
  for (const [key, slot] of table.entries()) {
    const {
      bytes,
      partial
    } = bytesOf(key, slot);
    heapBytes += bytes;
    heapPartial ||= partial;
  }
  return {
    heapBytes,
    heapPartial
  };
}
const caches = new Map();

/** Lists a cache, replacing one listed under its name before, as a store's move to another database rebuilds its caches. */
export function registerInspectedCache(cache) {
  if (__DEV__) caches.set(cache.name, cache);
}

/** What a store's caches hold on the heap together. */

/** A store walk counts at most this many objects. */
const STORE_WALK_OBJECTS = 1_000_000;
const storeHeaps = new Map();

/**
 * What `store`'s caches hold on the heap together, walked with one set of seen objects so that a row one cache hands
 * back and another indexes counts once. The walk visits every entry, megabytes of rows for a store that ranks, so it
 * runs in slices that yield between them, and its result is kept until a cache changes; callers that ask while it
 * runs share it.
 */
export function inspectedCachesHeap(store) {
  const prefix = `${store.replace(/_store$/, '')}.`;
  const list = Array.from(caches.values()).filter(cache => cache.name.startsWith(prefix));
  const signature = list.map(({
    name,
    stats,
    table
  }) => `${name}:${stats.builds}:${stats.evictions}:${table.size}`).join('|');
  const known = storeHeaps.get(prefix);
  if (known?.signature === signature) return known.heap;
  const heap = walkCachesHeap(list);
  storeHeaps.set(prefix, {
    signature,
    heap
  });
  heap.catch(() => {
    if (storeHeaps.get(prefix)?.heap === heap) storeHeaps.delete(prefix);
  });
  return heap;
}
async function walkCachesHeap(list) {
  const estimate = {
    bytes: 0,
    objects: 0,
    partial: false
  };
  const values = [];
  let separate = 0;
  const entries = list.flatMap(({
    table
  }) => Array.from(table.entries()));
  const clock = sliceClock();
  for (let i = 0; i < entries.length; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (i % 256 === 0 && clock.due()) await clock.yield();
    const [key, slot] = entries[i];
    estimate.bytes += ENTRY_OVERHEAD_BYTES + 16 + key.length;
    values.push(slot.value);
    if (!slotBytes.has(slot)) {
      const own = {
        bytes: 0,
        objects: 0,
        partial: false
      };
      // eslint-disable-next-line no-await-in-loop
      await estimateIntoSliced([slot.value], own, new Set());
      slotBytes.set(slot, {
        bytes: own.bytes,
        partial: own.partial
      });
    }
    separate += bytesOf(key, slot).bytes;
  }
  await estimateIntoSliced(values, estimate, new Set(), STORE_WALK_OBJECTS);
  return {
    heapBytes: estimate.bytes,
    sharedBytes: Math.max(0, separate - estimate.bytes),
    partial: estimate.partial
  };
}

/** Options for {@linkcode inspectedCaches}. */

/** Every listed cache, or the ones of `store` (its name with or without `_store`). */
export function inspectedCaches(store, options = {}) {
  const prefix = store === undefined ? undefined : `${store.replace(/_store$/, '')}.`;
  const out = [];
  for (const {
    name,
    keyedBy,
    kind,
    max,
    stats,
    table
  } of caches.values()) {
    if (prefix && !name.startsWith(prefix)) continue;
    const dot = name.indexOf('.');
    out.push({
      name,
      store: name.slice(0, dot),
      cache: name.slice(dot + 1),
      kind,
      keyedBy,
      max,
      entries: table.size,
      ...stats,
      ...(options.heap ? heapOf(table) : {})
    });
  }
  return out;
}

/** The entries of `store`'s per-entity caches for one entity of one partition; looking doesn't count as using. */
export function inspectedEntityCacheEntries(store, partitionKey, entityId) {
  const prefix = `${store.replace(/_store$/, '')}.`;
  const split = new RegExp(`[${KEY_SEP}${GROUP_SEP}]`);
  const out = [];
  for (const {
    name,
    kind,
    table
  } of caches.values()) {
    if (kind !== 'entity' || !name.startsWith(prefix)) continue;
    for (const [key, slot] of table.entries()) {
      const parts = key.split(split);
      // An entity cache's key is the partition, then the entity, then any other parts.
      if (parts[0] !== partitionKey || parts[1] !== entityId) continue;
      out.push({
        cache: name.slice(prefix.length),
        key: parts,
        version: slot.version,
        heapBytes: bytesOf(key, slot).bytes,
        value: previewValue(slot.value)
      });
    }
  }
  return out;
}

/** A page of the cache `name`'s entries, most recently used first; looking doesn't count as using. */
export function inspectedCacheEntries(name, page = {}) {
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
      value: previewValue(slot.value)
    }))
  };
}

// Exported so the built declaration files keep these names in scope for the doc links above; an import that only a
// doc comment uses is dropped from them.
//# sourceMappingURL=caches.js.map