"use strict";
/**
 * The tools an agent (Cursor, Claude, the Rozenite CLI) calls to look into the stores, and what each answers: the same
 * operations the panel's calls use. `useCellarAgentTools` registers them under the plugin's id.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.agentToolHandlers = exports.cellarAgentTools = void 0;
const operations_1 = require("./operations");
const STORE = { type: 'string', description: 'The store name, from list-stores, such as "player_stats_store".' };
const PARTITION_KEY = { type: 'string', description: 'The partition key, from list-partitions.' };
const EVENT_KINDS = ['write', 'binding', 'fetch', 'degradation'];
exports.cellarAgentTools = {
    listStores: {
        name: 'list-stores',
        description: "List every Cellar store: its SQLite table, where it runs (its own database, the in-memory fallback, or unbound), and its row and partition totals. Start here; the other tools take a store's name.",
        inputSchema: { type: 'object', properties: {} },
        readOnly: true,
        idempotent: true,
    },
    describeStore: {
        name: 'describe-store',
        description: "Describe one store's table as declared: columns (partition_key first), the columns that make a row unique (uniqueBy), the columns each partition keeps its own value of (perPartition), entity column, indexes, the store's read names, and where it runs. Use it before writing a query.",
        inputSchema: { type: 'object', properties: { store: STORE }, required: ['store'] },
        readOnly: true,
        idempotent: true,
    },
    listPartitions: {
        name: 'list-partitions',
        description: "List a store's partitions — the sets of rows one fetch replaces — each with its key, description, row count, version (writes that changed it), ETag, and when it last landed from a fetch.",
        inputSchema: {
            type: 'object',
            properties: {
                store: STORE,
                match: { type: 'string', description: 'Only partitions whose key contains this text.' },
                limit: { type: 'number', description: 'The most partitions to return; 200 by default.' },
            },
            required: ['store'],
        },
        readOnly: true,
        idempotent: true,
    },
    query: {
        name: 'query',
        description: "Run one read-only SQL statement (SELECT, WITH, VALUES, EXPLAIN, or a reading PRAGMA) on a store's live database and return its columns and rows. Writes, setting pragmas, and multiple statements are refused. Every row carries partition_key; filter on it to read one partition. Blobs come back as { $blob, bytes, hex }.",
        inputSchema: {
            type: 'object',
            properties: {
                store: STORE,
                sql: { type: 'string', description: 'One statement. Use ? placeholders for values.' },
                params: { type: 'array', items: { type: ['string', 'number', 'null'] }, description: 'Values for the ? placeholders, in order.' },
                limit: { type: 'number', description: 'The most rows to return; 500 by default, at most 10000.' },
                offset: { type: 'number', description: 'How many rows to skip, for the next page when the last came back truncated.' },
            },
            required: ['store', 'sql'],
        },
        readOnly: true,
        idempotent: true,
    },
    entity: {
        name: 'entity',
        description: "One entity, which is an id within one partition (the same id in another partition is another entity, and may name something else: player 1003 is a different player in each sport): its rows, the partition version at which it last changed, its per-entity cache entries with their values, and the other partitions using the same id.",
        inputSchema: {
            type: 'object',
            properties: {
                store: STORE,
                key: PARTITION_KEY,
                id: { type: 'string', description: "The entity's id, the value of the store's entity column (describe-store)." },
            },
            required: ['store', 'key', 'id'],
        },
        readOnly: true,
    },
    entityChanges: {
        name: 'entity-changes',
        description: "The entities (such as players) that changed lately in one partition, newest first, each with the partition version it changed at, and the epoch: the version at which every entity last counted as changed.",
        inputSchema: {
            type: 'object',
            properties: { store: STORE, key: PARTITION_KEY, limit: { type: 'number', description: 'The most entities to list; 50 by default.' } },
            required: ['store', 'key'],
        },
        readOnly: true,
    },
    listCaches: {
        name: 'list-caches',
        description: "List the stores' caches (values kept on the JS heap, per partition or per entity) with their entries against their limit, hits, misses (stale after a write, or absent), evictions, re-reads of evicted keys (what a larger cache would have answered), builds and isEqual reuses. Development builds only.",
        inputSchema: {
            type: 'object',
            properties: {
                store: { type: 'string', description: "Only this store's caches." },
                heap: { type: 'boolean', description: 'Also estimate what each cache holds on the JS heap, in bytes.' },
            },
        },
        readOnly: true,
    },
    cacheEntries: {
        name: 'cache-entries',
        description: "A page of one cache's entries, most recently used first: each entry's key parts (partition, then entity and any others), the version it was built at, its estimated heap bytes, and its value previewed ($type marks Maps, Sets, class instances and cut-off values).",
        inputSchema: {
            type: 'object',
            properties: {
                store: STORE,
                cache: { type: 'string', description: "The cache's name within its store, from list-caches (its `cache` field)." },
                offset: { type: 'number', description: 'How many entries to skip.' },
                limit: { type: 'number', description: 'The most entries to return; 50 by default, at most 500.' },
            },
            required: ['store', 'cache'],
        },
        readOnly: true,
    },
    recentEvents: {
        name: 'recent-events',
        description: 'List what the stores did recently, oldest first: writes (partition, new version, entity ids changed), binding moves (reopened, moved to memory, unbound), fetches (request and write ms, rows; -1 rows is a 304, -2 an unchanged body), and degradation reports. Recorded in development builds, the latest 1000.',
        inputSchema: {
            type: 'object',
            properties: {
                store: { type: 'string', description: 'Only this store\'s events. Degradation reports name a scope rather than a store and are always included.' },
                kinds: { type: 'array', items: { type: 'string', enum: EVENT_KINDS }, description: 'Only these kinds of event.' },
                limit: { type: 'number', description: 'The most events to return, the newest; 100 by default.' },
            },
        },
        readOnly: true,
    },
    ingestTimings: {
        name: 'ingest-timings',
        description: 'The latest 128 partition fetches with how long the request and the write each took, and the totals per store, to tell whether slow loading is the network or SQLite.',
        inputSchema: { type: 'object', properties: { store: { type: 'string', description: 'Only this store\'s fetches.' } } },
        readOnly: true,
    },
    dumpDatabases: {
        name: 'dump-databases',
        description: "Copy every store's database into one SQLite file on the device and return its path (on a simulator, a path on this Mac, which sqlite3 can open directly), size and tables. Only rows are copied, not indexes. The file is replaced by the next dump.",
        inputSchema: { type: 'object', properties: {} },
    },
    refetchPartition: {
        name: 'refetch-partition',
        description: 'Fetch one partition again, sending its ETag, as the store would when it goes stale. Returns false for a store that does not fetch.',
        inputSchema: { type: 'object', properties: { store: STORE, key: PARTITION_KEY }, required: ['store', 'key'] },
        idempotent: true,
    },
    clearEtag: {
        name: 'clear-etag',
        description: "Delete one partition's ETag so its next fetch downloads the whole body instead of possibly getting a 304.",
        inputSchema: { type: 'object', properties: { store: STORE, key: PARTITION_KEY }, required: ['store', 'key'] },
        idempotent: true,
    },
};
const agentToolHandlers = (inspector, dump = (0, operations_1.nitroDump)()) => ({
    dumpDatabases: () => dump(),
    listStores: async () => ({
        stores: (await (0, operations_1.listStores)(inspector)).map(({ name, schema, summary }) => ({ name, table: schema.table, ...summary })),
    }),
    describeStore: async ({ store }) => {
        const inspected = (0, operations_1.storeOf)(inspector, store);
        return { name: inspected.name, ...inspected.schema(), binding: inspected.binding() };
    },
    listPartitions: async ({ store, match, limit = 200 }) => {
        const all = await (0, operations_1.storeOf)(inspector, store).partitions();
        const matching = match ? all.filter((partition) => partition.key.includes(match)) : all;
        return { total: matching.length, partitions: matching.slice(0, limit) };
    },
    query: (request) => (0, operations_1.runQuery)(inspector, request),
    entity: async ({ store, key, id }) => (0, operations_1.storeOf)(inspector, store).entity(key, id),
    entityChanges: async ({ store, key, limit }) => (0, operations_1.storeOf)(inspector, store).entityChanges(key, limit),
    listCaches: async ({ store, heap }) => ({ caches: (0, operations_1.listCaches)(inspector, store, heap) }),
    cacheEntries: async ({ store, cache, offset, limit }) => (0, operations_1.storeOf)(inspector, store).cacheEntries(cache, { offset, limit }),
    recentEvents: async ({ store, kinds, limit = 100 }) => ({
        events: (0, operations_1.filterEvents)(inspector.recentInspectorEvents(), { store, kinds, limit }),
    }),
    ingestTimings: async ({ store }) => {
        const report = (0, operations_1.ingestReport)(inspector);
        return store ? { timings: report.timings.filter((t) => t.store === store), rollup: report.rollup.filter((r) => r.store === store) } : report;
    },
    refetchPartition: async (ref) => ({ refetched: (0, operations_1.refetchPartition)(inspector, ref) }),
    clearEtag: async (ref) => {
        (0, operations_1.clearPartitionEtag)(inspector, ref);
        return { cleared: true };
    },
});
exports.agentToolHandlers = agentToolHandlers;
