"use strict";
/** What the app answers the panel and agents with, over Cellar's inspector. */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.openDeviceFile = exports.nitroDump = exports.defaultInspector = void 0;
exports.storeOf = storeOf;
exports.listStores = listStores;
exports.runQuery = runQuery;
exports.listCaches = listCaches;
exports.refetchPartition = refetchPartition;
exports.clearPartitionEtag = clearPartitionEtag;
exports.ingestReport = ingestReport;
exports.filterEvents = filterEvents;
const cellarInspector = __importStar(require("@sleeperhq/react-native-cellar/inspector"));
exports.defaultInspector = cellarInspector;
/** Cellar's dump, loaded when first asked for, since only a device running nitro can write one. */
const nitroDump = (name = 'cellar-dump.db') => Object.assign(() => require('@sleeperhq/react-native-cellar/nitro').dumpSqliteStores({ name }), { fileName: name });
exports.nitroDump = nitroDump;
/**
 * Opens a file through React Native's networking, which reads `file://` URLs into a native blob on both platforms, so
 * the whole file never enters JS: each part is sliced off the blob and read as a data URL.
 */
const openDeviceFile = async (path) => {
    const blob = await (await fetch(`file://${encodeURI(path)}`)).blob();
    return {
        size: blob.size,
        read: (offset, length) => new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
                const url = String(reader.result ?? '');
                resolve(url.slice(url.indexOf(',') + 1));
            };
            reader.onerror = () => reject(reader.error ?? new Error(`Couldn't read ${path}`));
            reader.readAsDataURL(blob.slice(offset, Math.min(offset + length, blob.size)));
        }),
        close: () => blob.close?.(),
    };
};
exports.openDeviceFile = openDeviceFile;
/** The store named `name`, or an error that lists the stores there are. */
function storeOf(inspector, name) {
    const store = inspector.inspectedStore(name);
    if (store)
        return store;
    const names = inspector.inspectedStores().map((candidate) => candidate.name);
    throw new Error(`Unknown store "${name}". Stores: ${names.join(', ') || '(none declared)'}.`);
}
async function listStores(inspector) {
    return Promise.all(inspector.inspectedStores().map(async (store) => ({ name: store.name, schema: store.schema(), summary: await store.summary() })));
}
function runQuery(inspector, { store, sql, params, limit, offset }) {
    return storeOf(inspector, store).query(sql, params ?? [], { limit, offset });
}
function listCaches(inspector, store, heap = false) {
    return store ? storeOf(inspector, store).caches({ heap }) : inspector.inspectedCaches(undefined, { heap });
}
function refetchPartition(inspector, { store, key }) {
    return storeOf(inspector, store).refetch(key);
}
function clearPartitionEtag(inspector, { store, key }) {
    storeOf(inspector, store).clearEtag(key);
}
function ingestReport(inspector) {
    const timings = inspector.getIngestTimings();
    return {
        timings: timings.map((timing) => ({ ...timing, store: timing.store.replace(/_ingest$/, '') })),
        rollup: inspector.rollupIngestTimings(timings).map((roll) => ({ ...roll, store: roll.store.replace(/_ingest$/, '') })),
    };
}
/** The recorded events of `kinds` for `store`, newest last, at most `limit` of them. */
function filterEvents(events, { store, kinds, limit }) {
    const matching = events.filter((event) => (!kinds?.length || kinds.includes(event.kind)) && (!store || !('store' in event) || event.store === store));
    return limit === undefined ? matching : matching.slice(-limit);
}
