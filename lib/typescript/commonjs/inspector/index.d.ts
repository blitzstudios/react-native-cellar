/**
 * Cellar's inspector: what a development tool, such as the Rozenite DevTools plugin, reads the stores through. It lists
 * every declared store with its schema, where it runs and its partitions, runs read-only SQL over a store's database,
 * and keeps a log of what the stores did (writes, moves between databases, fetches and degradation reports) with a
 * listener for each new event. The log is recorded only in a development build.
 *
 * Nothing here changes a store's rows: a query that would write is refused, and the only actions are refetching a
 * partition and clearing its ETag, which a store does on its own anyway.
 */
export type { InspectedColumn, InspectedPartition, InspectedQueryOptions, InspectedQueryResult, InspectedBlob, InspectedSchema, InspectedStore, InspectedSummary, } from './store';
export type { InspectedBinding, InspectedBindingState, InspectorBindingEvent, InspectorDegradationEvent, InspectorEvent, InspectorFetchEvent, InspectorWriteEvent, } from './events';
export { EVENT_CAPACITY, MAX_EVENT_ENTITIES, clearInspectorEvents, onInspectorEvent, recentInspectorEvents } from './events';
export { inspectedStore, inspectedStores } from './registry';
export { ReadOnlyViolation } from './read_only';
export { getIngestTimings, rollupIngestTimings } from '../diagnostics/ingest_timing';
export type { IngestRollup, IngestTiming } from '../diagnostics/ingest_timing';
//# sourceMappingURL=index.d.ts.map