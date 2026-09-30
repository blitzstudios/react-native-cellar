/** Answers the panel's calls, and pushes the stores' events to it as they are recorded. */
import { createRozeniteRpc } from '@rozenite/plugin-bridge';
import { clearPartitionEtag, defaultInspector, ingestReport, listCaches, listStores, refetchPartition, runQuery, storeOf } from './operations';
/** How long events gather before they go to the panel in one message, in ms. */
export const EVENT_FLUSH_MS = 100;
/** The most events one message carries; a busier interval goes out as several. */
export const EVENTS_PER_MESSAGE = 250;
/** Wires `client` up to answer the panel, and returns a function that unwires it. */
export function registerCellarHandlers(client, inspector = defaultInspector) {
    const rpc = createRozeniteRpc(client);
    const subscriptions = [
        rpc.handle('stores', () => listStores(inspector)),
        rpc.handle('partitions', ({ store }) => storeOf(inspector, store).partitions()),
        rpc.handle('entityChanges', async ({ store, key, limit }) => storeOf(inspector, store).entityChanges(key, limit)),
        rpc.handle('caches', async ({ store }) => listCaches(inspector, store)),
        rpc.handle('query', (params) => runQuery(inspector, params)),
        rpc.handle('refetch', async (params) => refetchPartition(inspector, params)),
        rpc.handle('clearEtag', async (params) => clearPartitionEtag(inspector, params)),
        rpc.handle('events', async ({ afterId }) => inspector.recentInspectorEvents(afterId)),
        rpc.handle('ingest', async () => ingestReport(inspector)),
    ];
    let pending = [];
    let timer;
    const flush = () => {
        timer = undefined;
        const events = pending;
        pending = [];
        for (let start = 0; start < events.length; start += EVENTS_PER_MESSAGE) {
            client.send('cellar:events', { events: events.slice(start, start + EVENTS_PER_MESSAGE) });
        }
    };
    const stopListening = inspector.onInspectorEvent((event) => {
        pending.push(event);
        timer ?? (timer = setTimeout(flush, EVENT_FLUSH_MS));
    });
    return () => {
        stopListening();
        if (timer !== undefined)
            clearTimeout(timer);
        pending = [];
        subscriptions.forEach((subscription) => subscription.remove());
        rpc.close();
    };
}
