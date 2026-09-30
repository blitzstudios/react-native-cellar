"use strict";

/**
 * One store as a development tool sees it: its schema, where it runs, its partitions, and read-only SQL over its
 * database. Built by {@linkcode defineSqliteStore} for every store it declares, and registered for
 * {@linkcode inspectedStores} to list.
 */

import { assertCompilesToRead, isWrappable, parseReadStatement } from "./read_only.js";
import { previewValue } from "./heap.js";
import { inspectedCacheEntries, inspectedCaches, inspectedCachesHeap, inspectedEntityCacheEntries } from "./caches.js";

/** A column of a store's table. */

/** A store's table as it was declared. */

/** One partition of a store. */

/**
 * One entity: an id within one partition. The same id in another partition is another entity, which is how Cellar
 * tracks change and keys its caches: a player id can name different players in different sports' partitions.
 */

/** A store at a glance. */

/** A value from a query result that JSON can't carry as it is. */

/** What a query returned. */

/** Options for {@linkcode InspectedStore.query}. */

/** The entities that changed lately in one partition. */

/** A store, for a development tool: what it holds and how it's doing. */

/** What {@linkcode createInspectedStore} reads a store's current state through; each looked up at the call. */

/** What the running store is built over, for the inspector to look into. */

const DEFAULT_LIMIT = 500;
const CACHE_TOTALS_MS = 5000;
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
async function readResult(conn, sql, params) {
  const target = conn.reader ?? conn;
  const result = target.executeAsync ? await target.executeAsync(sql, params) : target.execute(sql, params);
  const rows = result.rows?._array ?? [];
  const {
    metadata
  } = result;
  result.dispose?.();
  return {
    rows,
    metadata
  };
}

/**
 * A result's columns in the statement's order where the driver keeps it, and otherwise the row's own keys with the
 * table's columns first, in the table's order: nitro's rows don't keep the statement's order, and its metadata is only
 * whole once its keying bug is fixed.
 */
function columnsOf(row, metadata, tableOrder) {
  const keys = row ? Object.keys(row) : [];
  // A driver without metadata, such as sql.js, builds each row in the statement's order.
  if (!metadata) return keys;
  const named = Object.entries(metadata).map(([key, column]) => ({
    name: column.name ?? key,
    index: column.index
  }));
  if (named.length === keys.length && named.every(column => column.name in row)) return named.sort((a, b) => a.index - b.index).map(column => column.name);
  const rank = key => tableOrder.get(key) ?? tableOrder.size;
  return keys.map((key, index) => ({
    key,
    index
  })).sort((a, b) => rank(a.key) - rank(b.key) || a.index - b.index).map(({
    key
  }) => key);
}
async function read(conn, sql, params = []) {
  return (await readResult(conn, sql, params)).rows;
}
const now = () => typeof performance !== 'undefined' ? performance.now() : Date.now();

/** Builds the inspector's view of one store. */
export function createInspectedStore(source) {
  const {
    schema
  } = source;
  const meta = schema.meta;
  const table = quote(schema.table);
  const metaTable = quote(meta.table);
  const keyColumn = quote(meta.keyColumns[0]);
  const rowCounts = async conn => {
    const entity = quote(schema.entityId);
    const rows = await read(conn, `SELECT ${keyColumn} AS key, COUNT(*) AS rows, COUNT(DISTINCT ${entity}) AS entities FROM ${table} GROUP BY ${keyColumn};`);
    return new Map(rows.map(row => [row.key, {
      rows: Number(row.rows),
      entities: Number(row.entities)
    }]));
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
  const tableOrder = new Map([...Object.keys(schema.columns), meta.column, ...(meta.recordColumn ? [meta.recordColumn] : [])].map((column, index) => [column, index]));

  /** The caches' totals, estimated at most every {@linkcode CACHE_TOTALS_MS}, since a summary is asked for after every burst of writes. */
  let totals;
  const cacheTotals = () => {
    if (totals && Date.now() - totals.at < CACHE_TOTALS_MS) return totals.value;
    const list = inspectedCaches(source.name);
    const heap = inspectedCachesHeap(source.name);
    const value = {
      count: list.length,
      entries: list.reduce((sum, cache) => sum + cache.entries, 0),
      heapBytes: heap.heapBytes,
      sharedBytes: heap.sharedBytes
    };
    totals = {
      at: Date.now(),
      value
    };
    return value;
  };
  const unboundResult = offset => ({
    columns: [],
    rows: [],
    truncated: false,
    offset,
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
      const caches = cacheTotals();
      if (!running) return {
        binding,
        rows: 0,
        partitions: 0,
        caches
      };
      const [counts, records] = await Promise.all([rowCounts(running.conn), metaRecords(running.conn)]);
      const keys = new Set([...counts.keys(), ...records.keys()]);
      let rows = 0;
      for (const count of counts.values()) rows += count.rows;
      let databaseBytes;
      if (binding.state === 'database') {
        const [[pages], [size]] = await Promise.all([read(running.conn, 'PRAGMA page_count;'), read(running.conn, 'PRAGMA page_size;')]);
        if (pages && size) databaseBytes = Number(pages.page_count) * Number(size.page_size);
      }
      return {
        binding,
        rows,
        partitions: keys.size,
        caches,
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
          rows: counts.get(key)?.rows ?? 0,
          entities: counts.get(key)?.entities ?? 0,
          version: running.versionOf(key),
          etag: record?.etag ?? null,
          fetchedAt: running.fetchedAt(key) ?? null
        };
      }).sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    },
    query: async (sql, params = [], options = {}) => {
      const statement = parseReadStatement(sql);
      const running = source.running();
      const offset = Math.max(0, Math.floor(options.offset ?? 0));
      if (!running) return unboundResult(offset);
      assertCompilesToRead(running.conn, statement, params);
      const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_LIMIT, MAX_LIMIT));
      const text = isWrappable(statement) ? `SELECT * FROM (${statement.sql}) LIMIT ${limit + 1} OFFSET ${offset}` : statement.sql;
      const started = now();
      const {
        rows: all,
        metadata
      } = await readResult(running.conn, text, params);
      const durationMs = now() - started;
      const kept = all.length > limit ? all.slice(0, limit) : all;
      const columns = columnsOf(kept[0], metadata, tableOrder);
      return {
        columns,
        rows: kept.map(row => columns.map(column => toBridgeValue(row[column]))),
        truncated: all.length > limit,
        offset: isWrappable(statement) ? offset : 0,
        durationMs
      };
    },
    entityChanges: (partitionKey, limit = 50) => {
      const running = source.running();
      if (!running) return {
        version: 0,
        epoch: 0,
        count: 0,
        changed: []
      };
      const {
        epoch,
        changed
      } = running.entityChanges(partitionKey);
      const newest = changed.sort((a, b) => b.version - a.version);
      return {
        version: running.versionOf(partitionKey),
        epoch,
        count: newest.length,
        changed: newest.slice(0, limit)
      };
    },
    entity: async (partitionKey, entityId) => {
      const running = source.running();
      const cacheEntries = inspectedEntityCacheEntries(source.name, partitionKey, entityId);
      if (!running) return {
        partition: partitionKey,
        id: entityId,
        rows: [],
        version: 0,
        cacheEntries,
        sameIdIn: []
      };
      const entity = quote(schema.entityId);
      const [rows, others] = await Promise.all([read(running.conn, `SELECT * FROM ${table} WHERE ${keyColumn} = ? AND ${entity} = ? LIMIT 50;`, [partitionKey, entityId]), read(running.conn, `SELECT DISTINCT ${keyColumn} AS key FROM ${table} WHERE ${entity} = ? AND ${keyColumn} <> ? ORDER BY ${keyColumn};`, [entityId, partitionKey])]);
      return {
        partition: partitionKey,
        id: entityId,
        // In the table's column order, which nitro's row objects don't keep.
        rows: rows.map(row => previewValue(Object.fromEntries(Object.keys(schema.columns).map(column => [column, row[column]])))),
        version: running.entityVersionOf(partitionKey, entityId),
        cacheEntries,
        sameIdIn: others.map(other => other.key)
      };
    },
    caches: options => inspectedCaches(source.name, options),
    cacheEntries: (cache, page) => inspectedCacheEntries(`${source.name.replace(/_store$/, '')}.${cache}`, page),
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