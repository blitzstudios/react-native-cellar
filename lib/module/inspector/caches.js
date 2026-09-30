"use strict";

/**
 * Every cache a store has declared, with what it has done since it was built: how often a lookup answered from an
 * entry, how often it had to build, and how often it lost an entry it was asked for again. Registered in development
 * builds only, by the watch each declared cache carries.
 */

import { KEY_SEP } from "../key.js";
import { GROUP_SEP } from "../args_key.js";
import { estimateHeap, previewValue } from "./heap.js";

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