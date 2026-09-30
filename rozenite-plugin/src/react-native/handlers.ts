/** Answers the panel's calls, and pushes the stores' events to it as they are recorded. */

import { createRozeniteRpc } from '@rozenite/plugin-bridge';
import type { RozeniteDevToolsClient } from '@rozenite/plugin-bridge';
import type { InspectorEvent } from '@sleeperhq/react-native-cellar/inspector';
import type { CellarEventMap } from '../shared/protocol';
import type { CellarWireMethods } from '../shared/wire';
import { clearPartitionEtag, defaultInspector, ingestReport, listCaches, listStores, refetchPartition, runQuery, storeOf } from './operations';
import type { CellarInspector } from './operations';

/** How long events gather before they go to the panel in one message, in ms. */
export const EVENT_FLUSH_MS = 100;
/** The most events one message carries; a busier interval goes out as several. */
export const EVENTS_PER_MESSAGE = 250;

/** Wires `client` up to answer the panel, and returns a function that unwires it. */
export function registerCellarHandlers(client: RozeniteDevToolsClient<CellarEventMap>, inspector: CellarInspector = defaultInspector): () => void {
  const rpc = createRozeniteRpc<CellarWireMethods>(client as unknown as RozeniteDevToolsClient);
  const json = async (result: unknown): Promise<string> => JSON.stringify((await result) ?? null);
  const subscriptions = [
    rpc.handle('stores', () => json(listStores(inspector))),
    rpc.handle('partitions', ({ store }) => json(storeOf(inspector, store).partitions())),
    rpc.handle('entityChanges', ({ store, key, limit }) => json(storeOf(inspector, store).entityChanges(key, limit))),
    rpc.handle('caches', ({ store, heap }) => json(listCaches(inspector, store, heap))),
    rpc.handle('cacheEntries', ({ store, cache, offset, limit }) => json(storeOf(inspector, store).cacheEntries(cache, { offset, limit }))),
    rpc.handle('query', (params) => json(runQuery(inspector, params))),
    rpc.handle('refetch', (params) => json(refetchPartition(inspector, params))),
    rpc.handle('clearEtag', (params) => json(clearPartitionEtag(inspector, params))),
    rpc.handle('events', ({ afterId }) => json(inspector.recentInspectorEvents(afterId))),
    rpc.handle('ingest', () => json(ingestReport(inspector))),
  ];

  let pending: InspectorEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = (): void => {
    timer = undefined;
    const events = pending;
    pending = [];
    for (let start = 0; start < events.length; start += EVENTS_PER_MESSAGE) {
      client.send('cellar:events', { json: JSON.stringify(events.slice(start, start + EVENTS_PER_MESSAGE)) });
    }
  };
  const stopListening = inspector.onInspectorEvent((event) => {
    pending.push(event);
    timer ??= setTimeout(flush, EVENT_FLUSH_MS);
  });

  return () => {
    stopListening();
    if (timer !== undefined) clearTimeout(timer);
    pending = [];
    subscriptions.forEach((subscription) => subscription.remove());
    rpc.close();
  };
}
