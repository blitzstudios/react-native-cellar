/** What the app answers the panel and agents with, over Cellar's inspector. */
import * as cellarInspector from '@sleeperhq/react-native-cellar/inspector';
export const defaultInspector = cellarInspector;
/** The store named `name`, or an error that lists the stores there are. */
export function storeOf(inspector, name) {
    const store = inspector.inspectedStore(name);
    if (store)
        return store;
    const names = inspector.inspectedStores().map((candidate) => candidate.name);
    throw new Error(`Unknown store "${name}". Stores: ${names.join(', ') || '(none declared)'}.`);
}
export async function listStores(inspector) {
    return Promise.all(inspector.inspectedStores().map(async (store) => ({ name: store.name, schema: store.schema(), summary: await store.summary() })));
}
export function runQuery(inspector, { store, sql, params, limit, offset }) {
    return storeOf(inspector, store).query(sql, params ?? [], { limit, offset });
}
export function listCaches(inspector, store) {
    return store ? storeOf(inspector, store).caches() : inspector.inspectedCaches();
}
export function refetchPartition(inspector, { store, key }) {
    return storeOf(inspector, store).refetch(key);
}
export function clearPartitionEtag(inspector, { store, key }) {
    storeOf(inspector, store).clearEtag(key);
}
export function ingestReport(inspector) {
    const timings = inspector.getIngestTimings();
    return {
        timings: timings.map((timing) => ({ ...timing, store: timing.store.replace(/_ingest$/, '') })),
        rollup: inspector.rollupIngestTimings(timings).map((roll) => ({ ...roll, store: roll.store.replace(/_ingest$/, '') })),
    };
}
/** The recorded events of `kinds` for `store`, newest last, at most `limit` of them. */
export function filterEvents(events, { store, kinds, limit }) {
    const matching = events.filter((event) => (!kinds?.length || kinds.includes(event.kind)) && (!store || !('store' in event) || event.store === store));
    return limit === undefined ? matching : matching.slice(-limit);
}
