"use strict";
/** Answers the panel's calls, and pushes the stores' events to it as they are recorded. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.EVENTS_PER_MESSAGE = exports.EVENT_FLUSH_MS = void 0;
exports.registerCellarHandlers = registerCellarHandlers;
const plugin_bridge_1 = require("@rozenite/plugin-bridge");
const operations_1 = require("./operations");
/** How long events gather before they go to the panel in one message, in ms. */
exports.EVENT_FLUSH_MS = 100;
/** The most events one message carries; a busier interval goes out as several. */
exports.EVENTS_PER_MESSAGE = 250;
/** Wires `client` up to answer the panel, and returns a function that unwires it. */
function registerCellarHandlers(client, inspector = operations_1.defaultInspector) {
    const rpc = (0, plugin_bridge_1.createRozeniteRpc)(client);
    const json = async (result) => JSON.stringify((await result) ?? null);
    const subscriptions = [
        rpc.handle('stores', () => json((0, operations_1.listStores)(inspector))),
        rpc.handle('partitions', ({ store }) => json((0, operations_1.storeOf)(inspector, store).partitions())),
        rpc.handle('entityChanges', ({ store, key, limit }) => json((0, operations_1.storeOf)(inspector, store).entityChanges(key, limit))),
        rpc.handle('caches', ({ store, heap }) => json((0, operations_1.listCaches)(inspector, store, heap))),
        rpc.handle('cacheEntries', ({ store, cache, offset, limit }) => json((0, operations_1.storeOf)(inspector, store).cacheEntries(cache, { offset, limit }))),
        rpc.handle('query', (params) => json((0, operations_1.runQuery)(inspector, params))),
        rpc.handle('refetch', (params) => json((0, operations_1.refetchPartition)(inspector, params))),
        rpc.handle('clearEtag', (params) => json((0, operations_1.clearPartitionEtag)(inspector, params))),
        rpc.handle('events', ({ afterId }) => json(inspector.recentInspectorEvents(afterId))),
        rpc.handle('ingest', () => json((0, operations_1.ingestReport)(inspector))),
    ];
    let pending = [];
    let timer;
    const flush = () => {
        timer = undefined;
        const events = pending;
        pending = [];
        for (let start = 0; start < events.length; start += exports.EVENTS_PER_MESSAGE) {
            client.send('cellar:events', { json: JSON.stringify(events.slice(start, start + exports.EVENTS_PER_MESSAGE)) });
        }
    };
    const stopListening = inspector.onInspectorEvent((event) => {
        pending.push(event);
        timer ?? (timer = setTimeout(flush, exports.EVENT_FLUSH_MS));
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
