/**
 * The tools an agent (Cursor, Claude, the Rozenite CLI) calls to look into the stores, and what each answers: the same
 * operations the panel's calls use. `useCellarAgentTools` registers them under the plugin's id.
 */
import { clearPartitionEtag, filterEvents, ingestReport, listStores, refetchPartition, runQuery, storeOf } from './operations';
const STORE = { type: 'string', description: 'The store name, from list-stores, such as "player_stats_store".' };
const PARTITION_KEY = { type: 'string', description: 'The partition key, from list-partitions.' };
const EVENT_KINDS = ['write', 'binding', 'fetch', 'degradation'];
export const cellarAgentTools = {
    listStores: {
        name: 'list-stores',
        description: "List every Cellar store: its SQLite table, where it runs (its own database, the in-memory fallback, or unbound), and its row and partition totals. Start here; the other tools take a store's name.",
        inputSchema: { type: 'object', properties: {} },
        readOnly: true,
        idempotent: true,
    },
    describeStore: {
        name: 'describe-store',
        description: "Describe one store's table as declared: columns (partition_key first), primary key, entity column, indexes, the store's read names, and where it runs. Use it before writing a query.",
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
            },
            required: ['store', 'sql'],
        },
        readOnly: true,
        idempotent: true,
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
export const agentToolHandlers = (inspector) => ({
    listStores: async () => ({
        stores: (await listStores(inspector)).map(({ name, schema, summary }) => ({ name, table: schema.table, ...summary })),
    }),
    describeStore: async ({ store }) => {
        const inspected = storeOf(inspector, store);
        return { name: inspected.name, ...inspected.schema(), binding: inspected.binding() };
    },
    listPartitions: async ({ store, match, limit = 200 }) => {
        const all = await storeOf(inspector, store).partitions();
        const matching = match ? all.filter((partition) => partition.key.includes(match)) : all;
        return { total: matching.length, partitions: matching.slice(0, limit) };
    },
    query: (request) => runQuery(inspector, request),
    recentEvents: async ({ store, kinds, limit = 100 }) => ({
        events: filterEvents(inspector.recentInspectorEvents(), { store, kinds, limit }),
    }),
    ingestTimings: async ({ store }) => {
        const report = ingestReport(inspector);
        return store ? { timings: report.timings.filter((t) => t.store === store), rollup: report.rollup.filter((r) => r.store === store) } : report;
    },
    refetchPartition: async (ref) => ({ refetched: refetchPartition(inspector, ref) }),
    clearEtag: async (ref) => {
        clearPartitionEtag(inspector, ref);
        return { cleared: true };
    },
});
