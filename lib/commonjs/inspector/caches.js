"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.inspectedCaches = inspectedCaches;
exports.registerInspectedCache = registerInspectedCache;
/**
 * Every cache a store has declared, with what it has done since it was built: how often a lookup answered from an
 * entry, how often it had to build, and how often it lost an entry it was asked for again. Registered in development
 * builds only, by the watch each declared cache carries.
 */

/** A {@linkcode byPartition} cache, which holds a value per partition, or a {@linkcode byEntity} one, per entity. */

/** What a cache has done since it was built, counted as it happens. */

/** One cache, as the inspector lists it. */

const caches = new Map();

/** Lists a cache, replacing one listed under its name before, as a store's move to another database rebuilds its caches. */
function registerInspectedCache(cache) {
  if (__DEV__) caches.set(cache.name, cache);
}

/** Every listed cache, or the ones of `store` (its name with or without `_store`). */
function inspectedCaches(store) {
  const prefix = store === undefined ? undefined : `${store.replace(/_store$/, '')}.`;
  const out = [];
  for (const {
    name,
    keyedBy,
    kind,
    max,
    stats,
    size
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
      entries: size(),
      ...stats
    });
  }
  return out;
}

// Exported so the built declaration files keep these names in scope for the doc links above; an import that only a
// doc comment uses is dropped from them.
//# sourceMappingURL=caches.js.map