/**
 * One store as a development tool sees it: its schema, where it runs, its partitions, and read-only SQL over its
 * database. Built by {@linkcode defineSqliteStore} for every store it declares, and registered for
 * {@linkcode inspectedStores} to list.
 */

import type { defineSqliteStore } from '../define_sqlite_store';
import type { QueryExecResult, SqliteConnection } from '../table/connection';
import type { RowShape, RowTableSchema } from '../table/types';
import type { InspectedBinding } from './events';
import { assertCompilesToRead, isWrappable, parseReadStatement } from './read_only';
import { previewValue } from './heap';
import { inspectedCacheEntries, inspectedCaches, inspectedEntityCacheEntries } from './caches';
import type { InspectedCache, InspectedCacheEntries, InspectedCacheEntry, InspectedCachesOptions } from './caches';
import type { EntityChanges } from '../reactivity/version_atom';

/** A column of a store's table. */
export interface InspectedColumn {
  name: string;
  /** Its SQLite type, such as `TEXT`. */
  type: string;
  /** Whether it may not hold `NULL`. */
  notNull: boolean;
}

/** A store's table as it was declared. */
export interface InspectedSchema {
  /** The table's name. */
  table: string;
  /** The table holding each partition's ETag and description. */
  metaTable: string;
  /** Every column, `partition_key` first. */
  columns: InspectedColumn[];
  /** The primary key's columns, `partition_key` first; empty for a table whose rows have no identity. */
  primaryKey: string[];
  /** The column holding each row's entity id. */
  entityColumn: string;
  /** The table's secondary indexes. */
  indexes: Array<{ name: string; columns: string[] }>;
  /** The names of the store's reads. */
  reads: string[];
  /** Whether the store's fetches write through the native shredder. */
  nativeShred: boolean;
}

/** One partition of a store. */
export interface InspectedPartition {
  /** The partition's key. */
  key: string;
  /** What the partition is, as the store describes it, such as `{ season: '2026', week: 4 }`; absent if not known. */
  partition?: unknown;
  /** How many rows it holds. */
  rows: number;
  /** How many distinct entities its rows belong to. */
  entities: number;
  /** Its version: 0 before its first write, and one higher after every write that changed it. */
  version: number;
  /** The ETag its next fetch sends, or `null` if it has none. */
  etag: string | null;
  /** When its rows last landed from a fetch this session, as a `Date.now()` timestamp, or `null`. */
  fetchedAt: number | null;
}

/**
 * One entity: an id within one partition. The same id in another partition is another entity, which is how Cellar
 * tracks change and keys its caches: a player id can name different players in different sports' partitions.
 */
export interface InspectedEntity {
  partition: string;
  id: string;
  /** Its rows, previewed, at most 50. */
  rows: unknown[];
  /** The partition version at which it last changed; 0 if it hasn't this session. */
  version: number;
  /** Its entries in the store's per-entity caches, each with the cache's name. */
  cacheEntries: Array<InspectedCacheEntry & { cache: string }>;
  /** The other partitions with rows under the same id: other entities, whether or not they name the same thing. */
  sameIdIn: string[];
}

/** A store at a glance. */
export interface InspectedSummary {
  /** Where the store runs. */
  binding: InspectedBinding;
  /** How many rows its table holds. */
  rows: number;
  /** How many partitions hold rows or an ETag. */
  partitions: number;
  /** The size of the store's own database, in bytes; absent on the in-memory fallback and unbound. */
  databaseBytes?: number;
  /** The store's caches: how many, their entries, and roughly what they hold on the JS heap. Dev builds only. */
  caches: { count: number; entries: number; heapBytes: number };
}

/** A value from a query result that JSON can't carry as it is. */
export interface InspectedBlob {
  $blob: true;
  /** Its length in bytes. */
  bytes: number;
  /** Its first 64 bytes, as hex. */
  hex: string;
}

/** What a query returned. */
export interface InspectedQueryResult {
  /** The result's column names, in order; empty when it returned no rows. */
  columns: string[];
  /** Each row's values, in column order. Blobs come back as {@linkcode InspectedBlob}s. */
  rows: unknown[][];
  /** Whether there were more rows than `limit`, and the rest were left out: another page follows. */
  truncated: boolean;
  /** How many rows were skipped before these. */
  offset: number;
  /** How long the query took, in ms. */
  durationMs: number;
}

/** Options for {@linkcode InspectedStore.query}. */
export interface InspectedQueryOptions {
  /** The most rows to return; 500 by default, at most 10000. Only a `SELECT`, `WITH` or `VALUES` is limited. */
  limit?: number;
  /** How many rows to skip first, for the next page of a `SELECT`, `WITH` or `VALUES`; 0 by default. */
  offset?: number;
}

/** The entities that changed lately in one partition. */
export interface InspectedEntityChanges {
  /** The partition's version. */
  version: number;
  /**
   * The version at which every entity last counted as changed: the partition's first write, or a write that couldn't
   * say which entities it changed. Entities changed after it are listed.
   */
  epoch: number;
  /** How many entities changed after the epoch. */
  count: number;
  /** The most recently changed of them, newest first, each with the version it changed at. */
  changed: Array<{ id: string; version: number }>;
}

/** A store, for a development tool: what it holds and how it's doing. */
export interface InspectedStore {
  /** The store's name, such as `player_stats_store`. */
  readonly name: string;
  /** Its table as declared. */
  schema(): InspectedSchema;
  /** Where it runs now. */
  binding(): InspectedBinding;
  /** Its row and partition totals, and the size of its database file. */
  summary(): Promise<InspectedSummary>;
  /** Every partition that holds rows, has an ETag, or is remembered, by key. */
  partitions(): Promise<InspectedPartition[]>;
  /** The entities that changed lately in one partition, at most `limit` of them (50 by default). */
  entityChanges(partitionKey: string, limit?: number): InspectedEntityChanges;
  /** One entity: an id within one partition, with its rows, version and cache entries. */
  entity(partitionKey: string, entityId: string): Promise<InspectedEntity>;
  /** The store's caches and what each has done, with what each holds on the heap when asked; empty in a release build. */
  caches(options?: InspectedCachesOptions): InspectedCache[];
  /** A page of one of the store's caches' entries, by the cache's own name, such as `statRows`. */
  cacheEntries(cache: string, page?: { offset?: number; limit?: number }): InspectedCacheEntries;
  /**
   * Runs one read-only statement on the store's database and returns its rows. Throws for a statement that writes, for
   * a pragma that sets something, for more than one statement, and for SQL that SQLite rejects. Reads go to the
   * store's dedicated reader when it has one, so a long query doesn't hold up the store's writes.
   */
  query(sql: string, params?: ReadonlyArray<string | number | null>, options?: InspectedQueryOptions): Promise<InspectedQueryResult>;
  /** Fetches the partition again, sending its ETag. Returns false for a store that doesn't fetch. */
  refetch(partitionKey: string): boolean;
  /** Deletes the partition's ETag, so its next fetch downloads the whole body instead of possibly getting a 304. */
  clearEtag(partitionKey: string): void;
}

/** What {@linkcode createInspectedStore} reads a store's current state through; each looked up at the call. */
export interface InspectedStoreSource<Row extends RowShape> {
  name: string;
  schema: RowTableSchema<Row>;
  nativeShred: boolean;
  binding: () => InspectedBinding;
  /** The database the store runs on now, and what it built over it; `undefined` while it is unbound. */
  running: () => RunningStore | undefined;
}

/** What the running store is built over, for the inspector to look into. */
export interface RunningStore {
  /** The connection the store runs on, before Cellar's guard wraps it, so a bad query can't trip the store's recovery. */
  conn: SqliteConnection;
  /** The names of the store's reads. */
  reads: string[];
  /** The partitions the store remembers describing, by key. */
  internedKeys: () => Iterable<string>;
  /** A remembered partition's description. */
  describe: (key: string) => unknown;
  versionOf: (key: string) => number;
  entityChanges: (key: string) => EntityChanges;
  /** The partition version at which the entity last changed, read untracked. */
  entityVersionOf: (key: string, entityId: string) => number;
  fetchedAt: (key: string) => number | undefined;
  refetch?: (key: string) => void;
  clearEtag: (key: string) => void;
}

const DEFAULT_LIMIT = 500;
const CACHE_TOTALS_MS = 5000;
const MAX_LIMIT = 10_000;
const HEX_PREVIEW_BYTES = 64;

const quote = (name: string): string => `"${name.replace(/"/g, '""')}"`;

const bytesOf = (value: unknown): Uint8Array | undefined => {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return undefined;
};

/** A result value as JSON can carry it: blobs described, everything else as it is. */
function toBridgeValue(value: unknown): unknown {
  const bytes = bytesOf(value);
  if (!bytes) return typeof value === 'bigint' ? Number(value) : value;
  let hex = '';
  for (let i = 0; i < Math.min(bytes.length, HEX_PREVIEW_BYTES); i += 1) hex += bytes[i].toString(16).padStart(2, '0');
  const blob: InspectedBlob = { $blob: true, bytes: bytes.length, hex };
  return blob;
}

/**
 * Runs a read off the JS thread where the connection can (nitro runs `executeAsync` on its own thread), on the store's
 * dedicated reader when it has one, so counting a large table doesn't stall the app.
 */
async function readResult<T>(conn: SqliteConnection, sql: string, params: ReadonlyArray<string | number | null>): Promise<{ rows: T[]; metadata?: QueryExecResult['metadata'] }> {
  const target = conn.reader ?? conn;
  const result = target.executeAsync ? await target.executeAsync(sql, params) : target.execute(sql, params);
  const rows = (result.rows?._array ?? []) as T[];
  const { metadata } = result;
  result.dispose?.();
  return { rows, metadata };
}

/**
 * A result's columns in the statement's order where the driver keeps it, and otherwise the row's own keys with the
 * table's columns first, in the table's order: nitro's rows don't keep the statement's order, and its metadata is only
 * whole once its keying bug is fixed.
 */
function columnsOf(row: Record<string, unknown> | undefined, metadata: QueryExecResult['metadata'], tableOrder: ReadonlyMap<string, number>): string[] {
  const keys = row ? Object.keys(row) : [];
  // A driver without metadata, such as sql.js, builds each row in the statement's order.
  if (!metadata) return keys;
  const named = Object.entries(metadata).map(([key, column]) => ({ name: column.name ?? key, index: column.index }));
  if (named.length === keys.length && named.every((column) => column.name in row!)) return named.sort((a, b) => a.index - b.index).map((column) => column.name);
  const rank = (key: string): number => tableOrder.get(key) ?? tableOrder.size;
  return keys.map((key, index) => ({ key, index })).sort((a, b) => rank(a.key) - rank(b.key) || a.index - b.index).map(({ key }) => key);
}

async function read<T>(conn: SqliteConnection, sql: string, params: ReadonlyArray<string | number | null> = []): Promise<T[]> {
  return (await readResult<T>(conn, sql, params)).rows;
}

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Builds the inspector's view of one store. */
export function createInspectedStore<Row extends RowShape>(source: InspectedStoreSource<Row>): InspectedStore {
  const { schema } = source;
  const meta = schema.meta!;
  const table = quote(schema.table);
  const metaTable = quote(meta.table);
  const keyColumn = quote(meta.keyColumns[0]);

  const rowCounts = async (conn: SqliteConnection): Promise<Map<string, { rows: number; entities: number }>> => {
    const entity = quote(schema.entityId);
    const rows = await read<{ key: string; rows: number; entities: number }>(
      conn,
      `SELECT ${keyColumn} AS key, COUNT(*) AS rows, COUNT(DISTINCT ${entity}) AS entities FROM ${table} GROUP BY ${keyColumn};`,
    );
    return new Map(rows.map((row) => [row.key, { rows: Number(row.rows), entities: Number(row.entities) }]));
  };

  const metaRecords = async (conn: SqliteConnection): Promise<Map<string, { etag: string | null; record: string | null }>> => {
    const record = meta.recordColumn ? `, ${quote(meta.recordColumn)} AS record` : ', NULL AS record';
    try {
      const rows = await read<{ key: string; etag: string | null; record: string | null }>(conn, `SELECT ${keyColumn} AS key, ${quote(meta.column)} AS etag${record} FROM ${metaTable};`);
      return new Map(rows.map((row) => [row.key, { etag: row.etag, record: row.record }]));
    } catch {
      return new Map();
    }
  };

  const parse = (record: string | null): unknown => {
    if (record == null) return undefined;
    try {
      return JSON.parse(record);
    } catch {
      return record;
    }
  };

  const tableOrder = new Map([...Object.keys(schema.columns), meta.column, ...(meta.recordColumn ? [meta.recordColumn] : [])].map((column, index) => [column, index]));

  /** The caches' totals, estimated at most every {@linkcode CACHE_TOTALS_MS}, since a summary is asked for after every burst of writes. */
  let totals: { at: number; value: InspectedSummary['caches'] } | undefined;
  const cacheTotals = (): InspectedSummary['caches'] => {
    if (totals && Date.now() - totals.at < CACHE_TOTALS_MS) return totals.value;
    const list = inspectedCaches(source.name, { heap: true });
    const value = {
      count: list.length,
      entries: list.reduce((sum, cache) => sum + cache.entries, 0),
      heapBytes: list.reduce((sum, cache) => sum + (cache.heapBytes ?? 0), 0),
    };
    totals = { at: Date.now(), value };
    return value;
  };

  const unboundResult = (offset: number): InspectedQueryResult => ({ columns: [], rows: [], truncated: false, offset, durationMs: 0 });

  return {
    name: source.name,
    schema: () => ({
      table: schema.table,
      metaTable: meta.table,
      columns: Object.entries(schema.columns).map(([name, def]) => ({ name, type: def.type, notNull: !!def.notNull })),
      primaryKey: [...schema.primaryKey],
      entityColumn: schema.entityId,
      indexes: (schema.indexes ?? []).map((index) => ({ name: index.name, columns: index.columns.map(String) })),
      reads: source.running()?.reads ?? [],
      nativeShred: source.nativeShred,
    }),
    binding: source.binding,
    summary: async () => {
      const binding = source.binding();
      const running = source.running();
      const caches = cacheTotals();
      if (!running) return { binding, rows: 0, partitions: 0, caches };
      const [counts, records] = await Promise.all([rowCounts(running.conn), metaRecords(running.conn)]);
      const keys = new Set([...counts.keys(), ...records.keys()]);
      let rows = 0;
      for (const count of counts.values()) rows += count.rows;
      let databaseBytes: number | undefined;
      if (binding.state === 'database') {
        const [[pages], [size]] = await Promise.all([
          read<{ page_count: number }>(running.conn, 'PRAGMA page_count;'),
          read<{ page_size: number }>(running.conn, 'PRAGMA page_size;'),
        ]);
        if (pages && size) databaseBytes = Number(pages.page_count) * Number(size.page_size);
      }
      return { binding, rows, partitions: keys.size, caches, ...(databaseBytes === undefined ? {} : { databaseBytes }) };
    },
    partitions: async () => {
      const running = source.running();
      if (!running) return [];
      const [counts, records] = await Promise.all([rowCounts(running.conn), metaRecords(running.conn)]);
      const interned = new Set(running.internedKeys());
      const keys = new Set([...counts.keys(), ...records.keys(), ...interned]);
      return Array.from(keys, (key): InspectedPartition => {
        const record = records.get(key);
        const partition = parse(record?.record ?? null) ?? (interned.has(key) ? running.describe(key) : undefined);
        return {
          key,
          ...(partition === undefined ? {} : { partition }),
          rows: counts.get(key)?.rows ?? 0,
          entities: counts.get(key)?.entities ?? 0,
          version: running.versionOf(key),
          etag: record?.etag ?? null,
          fetchedAt: running.fetchedAt(key) ?? null,
        };
      }).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
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
      const { rows: all, metadata } = await readResult<Record<string, unknown>>(running.conn, text, params);
      const durationMs = now() - started;
      const kept = all.length > limit ? all.slice(0, limit) : all;
      const columns = columnsOf(kept[0], metadata, tableOrder);
      return {
        columns,
        rows: kept.map((row) => columns.map((column) => toBridgeValue(row[column]))),
        truncated: all.length > limit,
        offset: isWrappable(statement) ? offset : 0,
        durationMs,
      };
    },
    entityChanges: (partitionKey, limit = 50) => {
      const running = source.running();
      if (!running) return { version: 0, epoch: 0, count: 0, changed: [] };
      const { epoch, changed } = running.entityChanges(partitionKey);
      const newest = changed.sort((a, b) => b.version - a.version);
      return { version: running.versionOf(partitionKey), epoch, count: newest.length, changed: newest.slice(0, limit) };
    },
    entity: async (partitionKey, entityId) => {
      const running = source.running();
      const cacheEntries = inspectedEntityCacheEntries(source.name, partitionKey, entityId);
      if (!running) return { partition: partitionKey, id: entityId, rows: [], version: 0, cacheEntries, sameIdIn: [] };
      const entity = quote(schema.entityId);
      const [rows, others] = await Promise.all([
        read<Record<string, unknown>>(running.conn, `SELECT * FROM ${table} WHERE ${keyColumn} = ? AND ${entity} = ? LIMIT 50;`, [partitionKey, entityId]),
        read<{ key: string }>(running.conn, `SELECT DISTINCT ${keyColumn} AS key FROM ${table} WHERE ${entity} = ? AND ${keyColumn} <> ? ORDER BY ${keyColumn};`, [
          entityId,
          partitionKey,
        ]),
      ]);
      return {
        partition: partitionKey,
        id: entityId,
        rows: rows.map((row) => previewValue(row)),
        version: running.entityVersionOf(partitionKey, entityId),
        cacheEntries,
        sameIdIn: others.map((other) => other.key),
      };
    },
    caches: (options) => inspectedCaches(source.name, options),
    cacheEntries: (cache, page) => inspectedCacheEntries(`${source.name.replace(/_store$/, '')}.${cache}`, page),
    refetch: (partitionKey) => {
      const refetch = source.running()?.refetch;
      if (!refetch) return false;
      refetch(partitionKey);
      return true;
    },
    clearEtag: (partitionKey) => source.running()?.clearEtag(partitionKey),
  };
}

// Exported so the built declaration files keep these names in scope for the doc links above; an import that only a
// doc comment uses is dropped from them.
export type { defineSqliteStore };
