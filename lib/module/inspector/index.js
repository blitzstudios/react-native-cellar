"use strict";

/**
 * Cellar's inspector: what a development tool, such as the Rozenite DevTools plugin, reads the stores through. It lists
 * every declared store with its schema, where it runs, its partitions and the entities they changed lately, and its
 * caches with their hits and misses; runs read-only SQL over a store's database, a page at a time; and keeps a log of
 * what the stores did (writes, moves between databases, fetches and degradation reports) with a listener for each new
 * event. The log is recorded only in a development build.
 *
 * Nothing here changes a store's rows: a query that would write is refused, and the only actions are refetching a
 * partition and clearing its ETag, which a store does on its own anyway.
 */

export { EVENT_CAPACITY, MAX_EVENT_ENTITIES, clearInspectorEvents, onInspectorEvent, recentInspectorEvents } from "./events.js";
export { inspectedStore, inspectedStores } from "./registry.js";
export { inspectedCacheEntries, inspectedCaches, inspectedCachesHeap } from "./caches.js";
export { estimateHeap, previewValue } from "./heap.js";
export { ReadOnlyViolation } from "./read_only.js";
export { getIngestTimings, rollupIngestTimings } from "../diagnostics/ingest_timing.js";
//# sourceMappingURL=index.js.map