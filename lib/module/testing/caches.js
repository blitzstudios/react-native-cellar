"use strict";

/** A store's cache block, for a suite that builds one module of a store rather than the whole store. */

import { bindCaches } from "../cache_block.js";
/**
 * A {@linkcode Partitions.defineCaches | defineCaches} function like the one {@linkcode definePartitions} gives a
 * store's modules, for testing a module on its own. It takes {@linkcode byPartition} caches only, since a
 * {@linkcode byEntity} cache reads a store's rows. Pass the version atom the test bumps, or its caches won't see the
 * writes.
 */
export function testCache(version, opts = {}) {
  const parts = opts.parts ?? (key => [key ?? '']);
  return decls => bindCaches(opts.store ?? 'test', {
    parts,
    version: key => version.get(parts(key)),
    entityVersion: (key, entityId) => version.getEntity(parts(key), entityId)
  }, decls);
}

// Exported so the built declaration files keep these names in scope for the doc links above; an import that only a
// doc comment uses is dropped from them.
//# sourceMappingURL=caches.js.map