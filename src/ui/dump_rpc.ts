/**
 * The panel over a database dump instead of a running app: the same calls, answered by sql.js from the dump's bytes in
 * the browser. A dump holds the stores' rows and ETags but none of the app's memory, so the calls about caches,
 * events and fetches answer empty, and the ones that act on the app refuse.
 */

import type { Database, SqlJsStatic, SqlValue } from 'sql.js';
import type { CellarMethods, DatabaseDump, InspectedPartition, InspectedQueryResult, StoreOverview } from '../shared/protocol';
import type { CellarRpc } from '../shared/wire';

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 10_000;
const READ_VERBS = /^\s*(SELECT|WITH|VALUES|EXPLAIN|PRAGMA)\b/i;

const quote = (name: string): string => `"${name.replace(/"/g, '""')}"`;

const bridgeValue = (value: SqlValue): unknown => {
  if (!(value instanceof Uint8Array)) return value;
  let hex = '';
  for (let i = 0; i < Math.min(value.length, 64); i += 1) hex += value[i].toString(16).padStart(2, '0');
  return { $blob: true, bytes: value.length, hex };
};

function select(db: Database, sql: string, params: SqlValue[] = []): { columns: string[]; rows: SqlValue[][] } {
  const statement = db.prepare(sql);
  try {
    statement.bind(params);
    const rows: SqlValue[][] = [];
    while (statement.step()) rows.push(statement.get());
    return { columns: statement.getColumnNames(), rows };
  } finally {
    statement.free();
  }
}

function objects(db: Database, sql: string, params: SqlValue[] = []): Array<Record<string, SqlValue>> {
  const { columns, rows } = select(db, sql, params);
  return rows.map((row) => Object.fromEntries(columns.map((column, index) => [column, row[index]])));
}

interface DumpStore {
  table: string;
  metaTable: string;
  columns: Array<{ name: string; type: string; notNull: boolean }>;
  entityColumn: string;
}

/**
 * The stores in a dump: each table with a `partition_key` column and a `<table>_meta` beside it. A dump keeps rows,
 * not keys, so the entity column is taken to be the first `…_id` column after `partition_key`.
 */
function storesOf(db: Database): DumpStore[] {
  const tables = new Set(objects(db, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((row) => String(row.name)));
  const stores: DumpStore[] = [];
  for (const table of tables) {
    if (!tables.has(`${table}_meta`)) continue;
    const columns = objects(db, `PRAGMA table_info(${quote(table)})`).map((column) => ({
      name: String(column.name),
      type: String(column.type || ''),
      notNull: Number(column.notnull) === 1,
    }));
    if (columns[0]?.name !== 'partition_key') continue;
    const rest = columns.slice(1);
    const entityColumn = (rest.find((column) => column.name.endsWith('_id')) ?? rest[0])?.name ?? 'partition_key';
    stores.push({ table, metaTable: `${table}_meta`, columns, entityColumn });
  }
  return stores;
}

/** A call the dump can't answer, since it needs the app. */
const needsApp = (what: string) => () => Promise.reject(new Error(`${what} needs the running app; this is a dump.`));

/** The panel's calls, answered from a dump loaded into sql.js. */
export function createDumpRpc(SQL: SqlJsStatic, bytes: Uint8Array, fileName: string): { rpc: CellarRpc; stores: StoreOverview[] } {
  const db = new SQL.Database(bytes);
  const stores = storesOf(db);
  const storeOf = (name: string): DumpStore => {
    const store = stores.find((candidate) => candidate.table === name);
    if (!store) throw new Error(`Unknown store "${name}". Stores: ${stores.map((candidate) => candidate.table).join(', ')}.`);
    return store;
  };

  const partitionsOf = (store: DumpStore): InspectedPartition[] => {
    const entity = quote(store.entityColumn);
    const counts = new Map(
      objects(db, `SELECT partition_key AS key, COUNT(*) AS rows, COUNT(DISTINCT ${entity}) AS entities FROM ${quote(store.table)} GROUP BY partition_key`).map((row) => [
        String(row.key),
        { rows: Number(row.rows), entities: Number(row.entities) },
      ]),
    );
    const metaColumns = new Set(objects(db, `PRAGMA table_info(${quote(store.metaTable)})`).map((column) => String(column.name)));
    const record = metaColumns.has('partition') ? ', partition AS record' : ', NULL AS record';
    const metas = new Map(
      objects(db, `SELECT partition_key AS key, etag${record} FROM ${quote(store.metaTable)}`).map((row) => [String(row.key), { etag: row.etag, record: row.record }]),
    );
    const keys = new Set([...counts.keys(), ...metas.keys()]);
    return Array.from(keys, (key): InspectedPartition => {
      const meta = metas.get(key);
      let partition: unknown;
      if (typeof meta?.record === 'string') {
        try {
          partition = JSON.parse(meta.record);
        } catch {
          partition = meta.record;
        }
      }
      return {
        key,
        ...(partition === undefined ? {} : { partition }),
        rows: counts.get(key)?.rows ?? 0,
        entities: counts.get(key)?.entities ?? 0,
        version: 0,
        etag: meta?.etag == null ? null : String(meta.etag),
        fetchedAt: null,
      };
    }).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  };

  const overviews: StoreOverview[] = stores.map((store) => {
    const partitions = partitionsOf(store);
    return {
      name: store.table,
      schema: {
        table: store.table,
        metaTable: store.metaTable,
        columns: store.columns,
        primaryKey: [],
        entityColumn: store.entityColumn,
        indexes: [],
        reads: [],
        nativeShred: false,
      },
      summary: {
        binding: { state: 'database', database: fileName, since: 0, reopens: 0 },
        rows: partitions.reduce((sum, partition) => sum + partition.rows, 0),
        partitions: partitions.length,
        caches: { count: 0, entries: 0, heapBytes: 0, sharedBytes: 0 },
      },
    };
  });

  const query = async ({ sql, params = [], limit, offset = 0 }: Parameters<CellarMethods['query']>[0]): Promise<InspectedQueryResult> => {
    const text = sql.trim().replace(/;+\s*$/, '');
    if (!READ_VERBS.test(text)) throw new Error('Only reads run here (SELECT, WITH, VALUES, EXPLAIN, PRAGMA).');
    const cap = Math.max(1, Math.min(limit ?? DEFAULT_LIMIT, MAX_LIMIT));
    const wrappable = /^\s*(SELECT|WITH|VALUES)\b/i.test(text);
    const started = performance.now();
    const { columns, rows } = select(db, wrappable ? `SELECT * FROM (${text}) LIMIT ${cap + 1} OFFSET ${offset}` : text, params);
    const kept = rows.length > cap ? rows.slice(0, cap) : rows;
    return {
      columns,
      rows: kept.map((row) => row.map(bridgeValue)),
      truncated: rows.length > cap,
      offset: wrappable ? offset : 0,
      durationMs: performance.now() - started,
    };
  };

  const methods: { [K in keyof CellarMethods]: (params: never) => Promise<unknown> } = {
    stores: async () => overviews,
    partitions: async ({ store }: { store: string }) => partitionsOf(storeOf(store)),
    entity: async ({ store, key, id }: { store: string; key: string; id: string }) => {
      const found = storeOf(store);
      const entity = quote(found.entityColumn);
      const rows = objects(db, `SELECT * FROM ${quote(found.table)} WHERE partition_key = ? AND ${entity} = ? LIMIT 50`, [key, id]);
      const others = objects(db, `SELECT DISTINCT partition_key AS key FROM ${quote(found.table)} WHERE ${entity} = ? AND partition_key <> ? ORDER BY partition_key`, [id, key]);
      return { partition: key, id, rows, version: 0, cacheEntries: [], sameIdIn: others.map((other) => String(other.key)) };
    },
    entityChanges: async () => ({ version: 0, epoch: 0, count: 0, changed: [] }),
    caches: async () => [],
    cacheEntries: needsApp('A cache'),
    query: (params: Parameters<CellarMethods['query']>[0]) => query(params),
    refetch: needsApp('Refetching'),
    clearEtag: needsApp('Clearing an ETag'),
    events: async () => [],
    ingest: async () => ({ timings: [], rollup: [] }),
    dump: needsApp('Dumping') as () => Promise<DatabaseDump>,
    dumpName: needsApp('Saving a dump'),
    readDump: needsApp('Saving a dump'),
  };

  const rpc: CellarRpc = {
    method: (name) => ({
      invoke: (...params: unknown[]) => (methods[name] as (params: unknown) => Promise<never>)(params[0]),
    }),
  };
  return { rpc, stores: overviews };
}
