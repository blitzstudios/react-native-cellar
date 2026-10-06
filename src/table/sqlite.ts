/** The row table on SQLite: rows live in the database, and become JS objects at the moment a read materializes them. */

import { cacheKeyOf } from '../args_key';
import { chunkList } from '../collections';
import { createPresence, whereMapKey } from './presence';
import { noteTableRead } from './read_coverage';
import { columnNames, FindOpts, IndexDef, ReplaceRow, RowShape, RowTable, RowTableSchema, SqlValue } from './types';
import { assertRowsMatchWhere, assertEntityIdColumn, comparator, whereClause } from './query';
import { ALL_ENTITIES, NO_CHANGES, unionChanges, WriteResult } from './change_set';
import { stageNames, entityDiffSql, EntityDiffSql, WriteMode } from './entity_diff_sql';
import {
  addColumnSql,
  addedColumns,
  createIndexSql,
  createMetaTableSql,
  createTableSql,
  dropIndexSql,
  planSchemaMigration,
  readLiveSchema,
  reportPushFedRebuild,
  schemaFingerprint,
  schemaStructureStamp,
} from './schema';
import { partitionedShredSpec, PARTITION_KEY_COLUMN } from './partitioned';
import { NativeShredSpec, ShredSpec } from '../write/shred_spec';
import { BatchCommand, readRows, runBatch, runBatchAsync, SqliteConnection } from './connection';
import { reportStoreDegradation } from '../diagnostics/telemetry';
import type { defineSqliteStore } from '../define_sqlite_store';

const MAX_BIND_VARIABLES = 999; // SQLite's pre-3.32 default
const DEFAULT_IN_CHUNK = 900;
const DEFAULT_UPSERT_CHUNK = 250; // rows per transaction, sized to stay sub-frame

function bindList(count: number): string {
  return new Array(count).fill('?').join(', ');
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

/** A shred spec whose wiring is wrong: a bug, and the one shred failure that propagates past the fallback. */
class ShredSpecMisconfigured extends Error {}

/**
 * Files a write whose diff never ran, once per table: the first says the connection is failing, and the rest say the
 * same.
 */
function createDiffLostReporter(table: string): () => void {
  let reported = false;
  return () => {
    if (reported) return;
    reported = true;
    reportStoreDegradation({
      scope: `row_table.diff_lost.${table}`,
      context: 'a write found no record of its own diff, so it reported every entity changed; readers repaint rather than show stale rows',
      extra: { table },
    });
  };
}

/**
 * Dev-only: {@linkcode ShredSpec.deleteWhere | deleteWhere} must name exactly the filter's columns, so the native and
 * JS paths replace the same rows.
 */
function assertDeleteWhereMatches(table: string, variant: string, spec: ShredSpec, where: Partial<RowShape>): void {
  const deleteColumns = new Set((spec.deleteWhere ?? []).map((clause) => clause.column));
  const whereColumns = Object.keys(where);
  const missing = whereColumns.filter((column) => !deleteColumns.has(column));
  const extra = [...deleteColumns].filter((column) => !whereColumns.includes(column));
  if (!missing.length && !extra.length) return;

  const detail = [
    missing.length
      ? `does not cover ${missing
          .map((column) => `\`${column}\``)
          .join(', ')} — the replace would leave the previous rows behind and the insert would append to them`
      : '',
    extra.length
      ? `covers ${extra.map((column) => `\`${column}\``).join(', ')}, which the filter does not — the replace would reach outside the partition being written`
      : '',
  ]
    .filter(Boolean)
    .join('; and it ');

  throw new ShredSpecMisconfigured(
    `row_table: the '${variant}' shred spec for \`${table}\` ${detail}. ` +
      `\`deleteWhere\` must name exactly the columns of the filter passed to \`shred\` (${
        whereColumns.map((column) => `\`${column}\``).join(', ') || 'none'
      }), ` +
      `so the native and JS ingest paths replace the same rows.`,
  );
}

/** Options for {@linkcode createSqliteRowTable}. */
export interface SqliteRowTableOptions {
  /**
   * Creates the table, its indexes and its ETag table as `TEMP` tables, held in memory and starting empty each
   * launch. A temp table is visible only to its own connection, so it is never read through a separate reader.
   */
  temporary?: boolean;
}

/**
 * Creates a {@linkcode RowTable} backed by a SQLite table. Rows stay in SQLite, and only the ones a read selects become
 * JS objects. {@linkcode defineSqliteStore} creates one when a store is bound. Call its
 * {@linkcode RowTable.init | init} before anything else, which creates the table or rebuilds an outdated one.
 */
export function createSqliteRowTable<Row extends RowShape>(
  schema: RowTableSchema<Row>,
  conn: SqliteConnection,
  storeShredSpec?: NativeShredSpec,
  options: SqliteRowTableOptions = {},
): RowTable<Row> {
  if (__DEV__) assertEntityIdColumn(schema);
  const cols = columnNames(schema);
  const nativeShredSpec = schema.partitioned && storeShredSpec ? partitionedShredSpec(storeShredSpec) : storeShredSpec;

  /** Fills in each row's `partition_key` from the replace's `where`: the rows are the caller's to hand over. */
  const stampPartition = (where: Partial<Row>, rows: readonly ReplaceRow<Row>[]): readonly Row[] => {
    if (!schema.partitioned) return rows as readonly Row[];
    const key = where[PARTITION_KEY_COLUMN as keyof Row];
    if (key == null) return rows as readonly Row[];
    for (const row of rows) (row as RowShape)[PARTITION_KEY_COLUMN] = key as SqlValue;
    return rows as readonly Row[];
  };

  const stageFingerprint = schemaFingerprint(schema);
  const asyncStage = stageNames(schema.table, stageFingerprint, 'async');
  const asyncDiff = entityDiffSql(schema, asyncStage, MAX_BIND_VARIABLES);
  const syncDiff = entityDiffSql(schema, stageNames(schema.table, stageFingerprint, 'sync'), MAX_BIND_VARIABLES);

  /**
   * Async writes run one at a time. Each stages its rows and then diffs the stage in a second step, and the native
   * shred cannot join the diff's transaction, so a second write starting in between would empty or refill the stage
   * the first one is about to diff. SQLite serializes writes on the one writer handle anyway, so this costs nothing.
   */
  /** Settles with nothing, so the queue does not keep the last write's result, a whole partition's change set, alive. */
  let writeTail: Promise<void> = Promise.resolve();
  function serialized<T>(write: () => Promise<T>): Promise<T> {
    const run = writeTail.then(write, write);
    writeTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  let lastWriteId = 0;
  const nextWriteId = (): number => {
    lastWriteId += 1;
    return lastWriteId;
  };

  const diffLost = createDiffLostReporter(schema.table);

  /**
   * Reads back what one write changed. The summary row is always written, so finding none means the transaction never
   * ran — a guarded connection in release answers a failed statement with silence — and the write reports every entity
   * rather than none: a reader woken for nothing costs a render, and one left asleep shows stale data.
   */
  function readBack(sql: EntityDiffSql, writeId: number): WriteResult {
    const [statement, params] = sql.readBack(writeId);
    const result = conn.execute(statement, params);
    const rows = (result.rows?._array ?? []) as Array<{ entity_id: SqlValue; rows: number | null }>;
    result.dispose?.();
    let count: number | undefined;
    const changed = new Set<string>();
    for (const row of rows) {
      if (row.rows != null) count = row.rows;
      else if (row.entity_id != null) changed.add(String(row.entity_id));
    }
    if (count === undefined) {
      diffLost();
      return { changes: ALL_ENTITIES, rows: 0 };
    }
    return { changes: changed.size ? changed : NO_CHANGES, rows: count };
  }

  const presence = createPresence();

  // `setMeta` is the only writer, so once loaded these caches answer every etag and description read on their own.
  const metaCache = new Map<string, string | undefined>();
  const recordCache = new Map<string, string>();
  let metaLoaded = false;
  const metaKey = (where: Partial<Row>): string =>
    schema.meta ? cacheKeyOf(schema.meta.keyColumns.map((column) => String(where[column as keyof Row] ?? ''))) : '';
  function ensureMetaLoaded(meta: NonNullable<typeof schema.meta>): void {
    if (metaLoaded) return;
    const cols = [...meta.keyColumns, meta.column, ...(meta.recordColumn ? [meta.recordColumn] : [])];
    const rows = readRows<Record<string, string | undefined>>(conn, `SELECT ${cols.join(', ')} FROM ${meta.table};`);
    for (const row of rows) {
      const key = metaKey(row as Partial<Row>);
      metaCache.set(key, row[meta.column] ?? undefined);
      const record = meta.recordColumn ? row[meta.recordColumn] : undefined;
      if (record != null) recordCache.set(key, record);
    }
    metaLoaded = true;
  }

  /** Adds the description column to an ETag table built before it existed; a new one is created with it. */
  function ensureRecordColumn(meta: NonNullable<typeof schema.meta>): void {
    if (!meta.recordColumn) return;
    const present = readRows<{ name: string }>(conn, `PRAGMA table_info(${meta.table});`).some((column) => column.name === meta.recordColumn);
    if (!present) conn.execute(`ALTER TABLE ${meta.table} ADD COLUMN ${meta.recordColumn} TEXT;`);
  }

  const secondaryIndexes = schema.indexes ?? [];
  const runIndexDdl = async (sql: (idx: IndexDef<Row>) => string): Promise<void> => {
    for (const idx of secondaryIndexes) {
      // eslint-disable-next-line no-await-in-loop -- DDL must not interleave
      if (conn.executeAsync) await conn.executeAsync(sql(idx));
      else conn.execute(sql(idx));
    }
  };

  let deferrals = 0;

  /** Bulk-writes with the secondary indexes dropped and rebuilt after: one sort beats maintaining them row by row. */
  async function withDeferredIndexes<T>(write: () => Promise<T>): Promise<T> {
    // Never without a dedicated reader. Dropping and recreating indexes around the write turns one statement into
    // several, and every one of them is a window in which a read that needs a transaction — the ranker's `TEMP`
    // tables, which fall back to this handle when there is no reader — can land inside the write and be refused as a
    // nested transaction. That refusal degrades the store, which costs far more than the indexes save.
    const defer =
      !!conn.reader && secondaryIndexes.length > 0 && (deferrals > 0 || readRows(conn, `SELECT 1 FROM ${schema.table} LIMIT 1;`).length === 0);
    if (!defer) return write();
    deferrals += 1;
    // Swallowed: the rebuild below is `IF NOT EXISTS`, so it restores whatever did drop.
    if (deferrals === 1) await runIndexDdl(dropIndexSql).catch(() => {});
    try {
      return await write();
    } finally {
      deferrals -= 1;
      if (deferrals === 0) await runIndexDdl((idx) => createIndexSql(schema.table, idx));
    }
  }

  /**
   * The declared spec pointed at the stage, one copy per variant. The declared spec is never edited: its table name is
   * part of the schema stamps, and changing it would rebuild every installed database. Held by identity, since the
   * native adapter caches a spec's serialization by the object.
   */
  const stageSpecs = new Map<string, ShredSpec>();
  const stageSpecFor = (variant: string, spec: ShredSpec): ShredSpec => {
    let staged = stageSpecs.get(variant);
    if (!staged) stageSpecs.set(variant, (staged = { ...spec, table: asyncStage.stage }));
    return staged;
  };

  /** Stages `rows` and applies them in one transaction, then reads back what changed. */
  async function stageAndApply(mode: WriteMode, where: Partial<Row>, rows: readonly Row[]): Promise<WriteResult> {
    const writeId = nextWriteId();
    await runBatchAsync(conn, [...asyncDiff.ensure, asyncDiff.clear, ...asyncDiff.stageRows(rows), ...asyncDiff.diff(mode, where, writeId)]);
    return readBack(asyncDiff, writeId);
  }

  /**
   * Whether the partition holds no rows, asked of the writer so it sees every write before it. An empty partition has
   * nothing to compare against, so its write skips the stage and lands straight in the table: every entity it brings is
   * new. That is a first load — a cold start, a new week — and it is the one write where staging would double the cost.
   */
  const partitionIsEmpty = (where: Partial<Row>): boolean => {
    const { sql, params } = whereClause(where);
    const result = conn.execute(`SELECT 1 AS one FROM ${schema.table}${sql} LIMIT 1;`, params);
    const empty = !(result.rows?._array ?? []).length;
    result.dispose?.();
    return empty;
  };

  const entityIdsOf = (rows: readonly Row[]): ReadonlySet<string> => (rows.length ? new Set(rows.map((row) => String(row[schema.entityId]))) : NO_CHANGES);

  /** The entities a direct write landed, read back from the table, since the native shred's rows never reach JS. */
  const entitiesLanded = (where: Partial<Row>, rows: number): WriteResult => {
    const { sql, params } = whereClause(where);
    const result = conn.execute(`SELECT DISTINCT ${schema.entityId} AS entity_id FROM ${schema.table}${sql};`, params);
    const entityIds = new Set(((result.rows?._array ?? []) as Array<{ entity_id: SqlValue }>).map((row) => String(row.entity_id)));
    result.dispose?.();
    // Rows landed but none can be found: the read failed silently, so say everything changed rather than nothing.
    if (rows > 0 && !entityIds.size) {
      diffLost();
      return { changes: ALL_ENTITIES, rows };
    }
    return { changes: entityIds.size ? entityIds : NO_CHANGES, rows };
  };

  /** A whole-partition replace written straight into the table, the way every write worked before change sets. */
  const replaceDirectly = (where: Partial<Row>, rows: readonly Row[]): BatchCommand[] => {
    const { sql, params } = whereClause(where);
    return [[`DELETE FROM ${schema.table}${sql};`, params], ...syncDiff.insertInto(schema.table, rows)];
  };

  async function shredOrParse(
    where: Partial<Row>,
    rawJson: string,
    parseRows: (rawJson: string) => ReplaceRow<Row>[],
    partition: object,
    inJs: boolean,
  ): Promise<WriteResult> {
    const direct = partitionIsEmpty(where);
    if (!inJs && conn.shredJsonArrayAsync && nativeShredSpec) {
      try {
        const variant = nativeShredSpec.variant(partition as Readonly<Record<string, unknown>>);
        const spec = nativeShredSpec.specs[variant];
        // A partition with no spec entry is one this store shreds in JS; the catch below is that fallback.
        if (!spec) throw new Error(`row_table: shred variant '${variant}' is not in the spec table`);
        if (__DEV__) assertDeleteWhereMatches(schema.table, variant, spec, where);
        const storeBinds = nativeShredSpec.binds(partition as Readonly<Record<string, unknown>>);
        const binds = schema.partitioned ? [where[PARTITION_KEY_COLUMN as keyof Row] as SqlValue, ...storeBinds] : storeBinds;
        let result: WriteResult;
        if (direct) {
          const landed = await conn.shredJsonArrayAsync(spec, rawJson, binds);
          result = entitiesLanded(where, landed);
        } else {
          await runBatchAsync(conn, [...asyncDiff.ensure, asyncDiff.clear]);
          await conn.shredJsonArrayAsync(stageSpecFor(variant, spec), rawJson, binds);
          const writeId = nextWriteId();
          await runBatchAsync(conn, asyncDiff.diff('replace', where, writeId));
          result = readBack(asyncDiff, writeId);
        }
        presence.afterDelete(where);
        return result;
      } catch (error) {
        if (error instanceof ShredSpecMisconfigured) throw error;
        reportStoreDegradation({
          scope: `row_table.native_shred.${schema.table}`,
          context: 'native shred failed; fell back to the JS parse path, which builds the transient object graph the shred exists to avoid',
          error,
          extra: { table: schema.table, where: whereMapKey(where), rawLength: rawJson.length },
        });
      }
    }
    const rows = stampPartition(where, parseRows(rawJson));
    if (__DEV__) assertRowsMatchWhere(schema.table, where, rows);
    let result: WriteResult;
    if (direct) {
      await runBatchAsync(conn, replaceDirectly(where, rows));
      result = { changes: entityIdsOf(rows), rows: rows.length };
    } else {
      result = await stageAndApply('replace', where, rows);
    }
    presence.afterDelete(where);
    return result;
  }

  function selectRows(where: Partial<Row>): Row[] {
    const { sql, params } = whereClause(where);
    return readRows<Row>(conn, `SELECT * FROM ${schema.table}${sql};`, params);
  }

  return {
    primaryKey: schema.primaryKey,
    entityId: schema.entityId,

    init(): void {
      if (options.temporary) {
        conn.execute(createTableSql(schema, true));
        for (const idx of secondaryIndexes) conn.execute(createIndexSql(schema.table, idx));
        if (schema.meta) conn.execute(createMetaTableSql(schema.meta, true));
        return;
      }
      const live = readLiveSchema(conn, schema.table);
      const plan = planSchemaMigration(schema, live, nativeShredSpec);
      if (plan === 'rebuild') {
        if (schema.pushFed) reportPushFedRebuild(schema.table);
        // Drops the table's indexes with it, which is how an index change gets applied.
        conn.execute(`DROP TABLE IF EXISTS ${schema.table};`);
        // The etags describe the dropped rows, so keeping them would 304 the refetch away.
        if (schema.meta) conn.execute(`DROP TABLE IF EXISTS ${schema.meta.table};`);
      }
      // A widening keeps every row, so this is the one migration that costs a user nothing.
      if (plan === 'extend') for (const column of addedColumns(schema, live.columns) ?? []) conn.execute(addColumnSql(schema, column));
      conn.execute(createTableSql(schema));
      for (const idx of secondaryIndexes) conn.execute(createIndexSql(schema.table, idx));
      if (schema.meta) {
        conn.execute(createMetaTableSql(schema.meta));
        ensureRecordColumn(schema.meta);
      }
      // The columns a widening just added are NULL in every row that predates them, and a kept etag would answer the
      // fetch that fills them with a 304. Cleared rather than dropping the table, so the rows stay.
      if (plan === 'extend' && schema.meta) {
        conn.execute(
          schema.meta.recordColumn ? `UPDATE ${schema.meta.table} SET ${schema.meta.column} = NULL;` : `DELETE FROM ${schema.meta.table};`,
        );
      }
      // Stamped even where the plan is `none`, so a database built before this stamp existed acquires one on the next
      // launch, and its next widening is an `ALTER TABLE` rather than a rebuild. `PRAGMA` takes no bind parameter.
      const structure = schemaStructureStamp(schema, nativeShredSpec);
      if (live.structure !== structure) conn.execute(`PRAGMA application_id = ${structure};`);
      // Stamped last, so a stamp only ever describes a fully built schema.
      if (plan !== 'none') conn.execute(`PRAGMA user_version = ${schemaFingerprint(schema, nativeShredSpec)};`);
    },

    async upsert(rows: readonly Row[], opts?: { chunk?: number }): Promise<WriteResult> {
      if (!rows.length) return { changes: NO_CHANGES, rows: 0 };
      const size = opts?.chunk ?? DEFAULT_UPSERT_CHUNK;
      const chunks = chunkList(rows, size);
      let changes = NO_CHANGES as WriteResult['changes'];
      for (let index = 0; index < chunks.length; index += 1) {
        // eslint-disable-next-line no-await-in-loop -- sequential by design: one transaction per chunk
        const chunk = await serialized(() => stageAndApply('merge', {}, chunks[index]));
        changes = unionChanges(changes, chunk.changes);
        // eslint-disable-next-line no-await-in-loop -- release the JS thread between chunks
        if (index < chunks.length - 1) await yieldToEventLoop();
      }
      presence.afterInsert();
      return { changes, rows: rows.length };
    },

    overwrite(where: Partial<Row>, replacing: readonly ReplaceRow<Row>[]): WriteResult {
      const rows = stampPartition(where, replacing);
      if (__DEV__) assertRowsMatchWhere(schema.table, where, rows);
      if (partitionIsEmpty(where)) {
        runBatch(conn, replaceDirectly(where, rows));
        presence.afterDelete(where);
        return { changes: entityIdsOf(rows), rows: rows.length };
      }
      const writeId = nextWriteId();
      runBatch(conn, [...syncDiff.ensure, syncDiff.clear, ...syncDiff.stageRows(rows), ...syncDiff.diff('replace', where, writeId)]);
      const result = readBack(syncDiff, writeId);
      presence.afterDelete(where);
      return result;
    },

    async shred(
      where: Partial<Row>,
      rawJson: string,
      parseRows: (rawJson: string) => ReplaceRow<Row>[],
      partition?: object,
      opts?: { inJs?: boolean },
    ): Promise<WriteResult> {
      // Deferral outside the queue, so overlapping ingests into an empty table share one drop and one rebuild while
      // their writes take turns inside it.
      return withDeferredIndexes(() => serialized(() => shredOrParse(where, rawJson, parseRows, partition ?? where, !!opts?.inJs)));
    },

    getOne(where: Partial<Row>): Row | undefined {
      noteTableRead();
      const { sql, params } = whereClause(where);
      return readRows<Row>(conn, `SELECT * FROM ${schema.table}${sql} LIMIT 1;`, params)[0];
    },

    find(where: Partial<Row>, opts?: FindOpts<Row>): Row[] {
      noteTableRead();
      const out = selectRows(where);
      if (opts?.orderBy) out.sort(comparator<Row>(opts.orderBy));
      return out;
    },

    findIn(where: Partial<Row>, column: keyof Row & string, values: readonly string[], opts?: { chunk?: number }): Row[] {
      noteTableRead();
      if (!values.length) return [];
      const rowFilter = whereClause(where);
      const prefix = rowFilter.sql ? `${rowFilter.sql} AND ` : ' WHERE ';
      const out: Row[] = [];
      for (const chunk of chunkList(values, opts?.chunk ?? DEFAULT_IN_CHUNK)) {
        const placeholders = bindList(chunk.length);
        const rows = readRows<Row>(conn, `SELECT * FROM ${schema.table}${prefix}${column} IN (${placeholders});`, [...rowFilter.params, ...chunk]);
        for (const row of rows) out.push(row);
      }
      return out;
    },

    has(where: Partial<Row>): boolean {
      noteTableRead();
      const cached = presence.get(where);
      if (cached !== undefined) return cached;
      const { sql, params } = whereClause(where);
      const row = readRows<{ one?: number }>(conn, `SELECT 1 AS one FROM ${schema.table}${sql} LIMIT 1;`, params)[0];
      presence.observe(where, !!row);
      return !!row;
    },

    entityIdsWhere(where: Partial<Row>): string[] {
      noteTableRead();
      const { sql, params } = whereClause(where);
      return readRows<{ entity_id: SqlValue }>(conn, `SELECT DISTINCT ${schema.entityId} AS entity_id FROM ${schema.table}${sql};`, params).map((row) => String(row.entity_id));
    },

    getMeta(where: Partial<Row>): string | undefined {
      const meta = schema.meta;
      if (!meta) return undefined;
      ensureMetaLoaded(meta);
      return metaCache.get(metaKey(where));
    },

    getMetaRecord(where: Partial<Row>): string | undefined {
      const meta = schema.meta;
      if (!meta?.recordColumn) return undefined;
      ensureMetaLoaded(meta);
      return recordCache.get(metaKey(where));
    },

    setMeta(where: Partial<Row>, value: string | undefined, record?: string): void {
      const meta = schema.meta;
      if (!meta) return;
      const key = metaKey(where);
      ensureMetaLoaded(meta);
      const kept = meta.recordColumn ? (record ?? recordCache.get(key)) : undefined;
      if (value === undefined && metaCache.get(key) === undefined && kept === recordCache.get(key)) return;
      const keyCols = meta.keyColumns;
      const keyParams: SqlValue[] = keyCols.map((column) => where[column as keyof Row] as SqlValue);
      // Fire-and-forget: a synchronous write would block the JS thread on SQLite's writer lock.
      metaCache.set(key, value);
      if (kept !== undefined) recordCache.set(key, kept);
      let sql: string;
      let params: SqlValue[];
      if (value === undefined && kept === undefined) {
        sql = `DELETE FROM ${meta.table} WHERE ${keyCols.map((column) => `${column} = ?`).join(' AND ')};`;
        params = keyParams;
      } else {
        const allCols = [...keyCols, meta.column, ...(meta.recordColumn ? [meta.recordColumn] : [])];
        sql = `INSERT OR REPLACE INTO ${meta.table} (${allCols.join(', ')}) VALUES (${bindList(allCols.length)});`;
        params = [...keyParams, value ?? null, ...(meta.recordColumn ? [kept ?? null] : [])];
      }
      if (conn.executeAsync) {
        conn.executeAsync(sql, params).catch(() => {
          /* the in-session caches already hold the values */
        });
      } else {
        conn.execute(sql, params);
      }
    },
  };
}

// Exported so the built declaration files keep these names in scope for the doc links above; an import that only a
// doc comment uses is dropped from them.
export type { RowTable, ShredSpec, defineSqliteStore };
