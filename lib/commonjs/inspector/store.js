"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.createInspectedStore = createInspectedStore;
var _read_only = require("./read_only.js");
/**
 * One store as a development tool sees it: its schema, where it runs, its partitions, and read-only SQL over its
 * database. Built by {@linkcode defineSqliteStore} for every store it declares, and registered for
 * {@linkcode inspectedStores} to list.
 */

/** A column of a store's table. */

/** A store's table as it was declared. */

/** One partition of a store. */

/** A store at a glance. */

/** A value from a query result that JSON can't carry as it is. */

/** What a query returned. */

/** Options for {@linkcode InspectedStore.query}. */

/** A store, for a development tool: what it holds and how it's doing. */

/** What {@linkcode createInspectedStore} reads a store's current state through; each looked up at the call. */

/** What the running store is built over, for the inspector to look into. */

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 10_000;
const HEX_PREVIEW_BYTES = 64;
const quote = name => `"${name.replace(/"/g, '""')}"`;
const bytesOf = value => {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return undefined;
};

/** A result value as JSON can carry it: blobs described, everything else as it is. */
function toBridgeValue(value) {
  const bytes = bytesOf(value);
  if (!bytes) return typeof value === 'bigint' ? Number(value) : value;
  let hex = '';
  for (let i = 0; i < Math.min(bytes.length, HEX_PREVIEW_BYTES); i += 1) hex += bytes[i].toString(16).padStart(2, '0');
  const blob = {
    $blob: true,
    bytes: bytes.length,
    hex
  };
  return blob;
}

/**
 * Runs a read off the JS thread where the connection can (nitro runs `executeAsync` on its own thread), on the store's
 * dedicated reader when it has one, so counting a large table doesn't stall the app.
 */
async function read(conn, sql, params = []) {
  const target = conn.reader ?? conn;
  const result = target.executeAsync ? await target.executeAsync(sql, params) : target.execute(sql, params);
  const rows = result.rows?._array ?? [];
  result.dispose?.();
  return rows;
}
const now = () => typeof performance !== 'undefined' ? performance.now() : Date.now();

/** Builds the inspector's view of one store. */
function createInspectedStore(source) {
  const {
    schema
  } = source;
  const meta = schema.meta;
  const table = quote(schema.table);
  const metaTable = quote(meta.table);
  const keyColumn = quote(meta.keyColumns[0]);
  const rowCounts = async conn => {
    const rows = await read(conn, `SELECT ${keyColumn} AS key, COUNT(*) AS rows FROM ${table} GROUP BY ${keyColumn};`);
    return new Map(rows.map(row => [row.key, Number(row.rows)]));
  };
  const metaRecords = async conn => {
    const record = meta.recordColumn ? `, ${quote(meta.recordColumn)} AS record` : ', NULL AS record';
    try {
      const rows = await read(conn, `SELECT ${keyColumn} AS key, ${quote(meta.column)} AS etag${record} FROM ${metaTable};`);
      return new Map(rows.map(row => [row.key, {
        etag: row.etag,
        record: row.record
      }]));
    } catch {
      return new Map();
    }
  };
  const parse = record => {
    if (record == null) return undefined;
    try {
      return JSON.parse(record);
    } catch {
      return record;
    }
  };
  const unboundResult = () => ({
    columns: [],
    rows: [],
    truncated: false,
    durationMs: 0
  });
  return {
    name: source.name,
    schema: () => ({
      table: schema.table,
      metaTable: meta.table,
      columns: Object.entries(schema.columns).map(([name, def]) => ({
        name,
        type: def.type,
        notNull: !!def.notNull
      })),
      primaryKey: [...schema.primaryKey],
      entityColumn: schema.entityId,
      indexes: (schema.indexes ?? []).map(index => ({
        name: index.name,
        columns: index.columns.map(String)
      })),
      reads: source.running()?.reads ?? [],
      nativeShred: source.nativeShred
    }),
    binding: source.binding,
    summary: async () => {
      const binding = source.binding();
      const running = source.running();
      if (!running) return {
        binding,
        rows: 0,
        partitions: 0
      };
      const [counts, records] = await Promise.all([rowCounts(running.conn), metaRecords(running.conn)]);
      const keys = new Set([...counts.keys(), ...records.keys()]);
      let rows = 0;
      for (const count of counts.values()) rows += count;
      let databaseBytes;
      if (binding.state === 'database') {
        const [[pages], [size]] = await Promise.all([read(running.conn, 'PRAGMA page_count;'), read(running.conn, 'PRAGMA page_size;')]);
        if (pages && size) databaseBytes = Number(pages.page_count) * Number(size.page_size);
      }
      return {
        binding,
        rows,
        partitions: keys.size,
        ...(databaseBytes === undefined ? {} : {
          databaseBytes
        })
      };
    },
    partitions: async () => {
      const running = source.running();
      if (!running) return [];
      const [counts, records] = await Promise.all([rowCounts(running.conn), metaRecords(running.conn)]);
      const interned = new Set(running.internedKeys());
      const keys = new Set([...counts.keys(), ...records.keys(), ...interned]);
      return Array.from(keys, key => {
        const record = records.get(key);
        const partition = parse(record?.record ?? null) ?? (interned.has(key) ? running.describe(key) : undefined);
        return {
          key,
          ...(partition === undefined ? {} : {
            partition
          }),
          rows: counts.get(key) ?? 0,
          version: running.versionOf(key),
          etag: record?.etag ?? null,
          fetchedAt: running.fetchedAt(key) ?? null
        };
      }).sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    },
    query: async (sql, params = [], options = {}) => {
      const statement = (0, _read_only.parseReadStatement)(sql);
      const running = source.running();
      if (!running) return unboundResult();
      (0, _read_only.assertCompilesToRead)(running.conn, statement, params);
      const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_LIMIT, MAX_LIMIT));
      const text = (0, _read_only.isWrappable)(statement) ? `SELECT * FROM (${statement.sql}) LIMIT ${limit + 1}` : statement.sql;
      const started = now();
      const all = await read(running.conn, text, params);
      const durationMs = now() - started;
      const kept = all.length > limit ? all.slice(0, limit) : all;
      const columns = kept.length ? Object.keys(kept[0]) : [];
      return {
        columns,
        rows: kept.map(row => columns.map(column => toBridgeValue(row[column]))),
        truncated: all.length > limit,
        durationMs
      };
    },
    refetch: partitionKey => {
      const refetch = source.running()?.refetch;
      if (!refetch) return false;
      refetch(partitionKey);
      return true;
    },
    clearEtag: partitionKey => source.running()?.clearEtag(partitionKey)
  };
}

// Exported so the built declaration files keep these names in scope for the doc links above; an import that only a
// doc comment uses is dropped from them.
//# sourceMappingURL=store.js.map