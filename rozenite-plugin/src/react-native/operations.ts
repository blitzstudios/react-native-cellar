/** What the app answers the panel and agents with, over Cellar's inspector. */

import * as cellarInspector from '@sleeperhq/react-native-cellar/inspector';
import type { InspectedStore, InspectorEvent } from '@sleeperhq/react-native-cellar/inspector';
import type { IngestReport, PartitionRef, QueryRequest, StoreOverview } from '../shared/protocol';

/** The part of Cellar's inspector the plugin reads; a test hands in its own. */
export type CellarInspector = Pick<
  typeof cellarInspector,
  'inspectedStores' | 'inspectedStore' | 'inspectedCaches' | 'recentInspectorEvents' | 'onInspectorEvent' | 'getIngestTimings' | 'rollupIngestTimings'
>;

export const defaultInspector: CellarInspector = cellarInspector;

/** The store named `name`, or an error that lists the stores there are. */
export function storeOf(inspector: CellarInspector, name: string): InspectedStore {
  const store = inspector.inspectedStore(name);
  if (store) return store;
  const names = inspector.inspectedStores().map((candidate) => candidate.name);
  throw new Error(`Unknown store "${name}". Stores: ${names.join(', ') || '(none declared)'}.`);
}

export async function listStores(inspector: CellarInspector): Promise<StoreOverview[]> {
  return Promise.all(inspector.inspectedStores().map(async (store) => ({ name: store.name, schema: store.schema(), summary: await store.summary() })));
}

export function runQuery(inspector: CellarInspector, { store, sql, params, limit, offset }: QueryRequest) {
  return storeOf(inspector, store).query(sql, params ?? [], { limit, offset });
}

export function listCaches(inspector: CellarInspector, store?: string, heap = false) {
  return store ? storeOf(inspector, store).caches({ heap }) : inspector.inspectedCaches(undefined, { heap });
}

export function refetchPartition(inspector: CellarInspector, { store, key }: PartitionRef): boolean {
  return storeOf(inspector, store).refetch(key);
}

export function clearPartitionEtag(inspector: CellarInspector, { store, key }: PartitionRef): void {
  storeOf(inspector, store).clearEtag(key);
}

export function ingestReport(inspector: CellarInspector): IngestReport {
  const timings = inspector.getIngestTimings();
  return {
    timings: timings.map((timing) => ({ ...timing, store: timing.store.replace(/_ingest$/, '') })),
    rollup: inspector.rollupIngestTimings(timings).map((roll) => ({ ...roll, store: roll.store.replace(/_ingest$/, '') })),
  };
}

/** The recorded events of `kinds` for `store`, newest last, at most `limit` of them. */
export function filterEvents(
  events: readonly InspectorEvent[],
  { store, kinds, limit }: { store?: string; kinds?: readonly InspectorEvent['kind'][]; limit?: number },
): InspectorEvent[] {
  const matching = events.filter(
    (event) => (!kinds?.length || kinds.includes(event.kind)) && (!store || !('store' in event) || event.store === store),
  );
  return limit === undefined ? matching : matching.slice(-limit);
}
