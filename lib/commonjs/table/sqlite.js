"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.createSqliteRowTable = createSqliteRowTable;
var _args_key = require("../args_key.js");
var _collections = require("../collections.js");
var _presence = require("./presence.js");
var _read_coverage = require("./read_coverage.js");
var _types = require("./types.js");
var _query = require("./query.js");
var _change_set = require("./change_set.js");
var _entity_diff_sql = require("./entity_diff_sql.js");
var _schema = require("./schema.js");
var _partitioned = require("./partitioned.js");
var _connection = require("./connection.js");
var _telemetry = require("../diagnostics/telemetry.js");
/** The row table on SQLite: rows live in the database, and become JS objects at the moment a read materializes them. */

const MAX_BIND_VARIABLES = 999; // SQLite's pre-3.32 default
const DEFAULT_IN_CHUNK = 900;
const DEFAULT_UPSERT_CHUNK = 250; // rows per transaction, sized to stay sub-frame

function bindList(count) {
  return new Array(count).fill('?').join(', ');
}
function yieldToEventLoop() {
  return new Promise(resolve => {
    setTimeout(resolve, 0);
  });
}

/** A shred spec whose wiring is wrong: a bug, and the one shred failure that propagates past the fallback. */
class ShredSpecMisconfigured extends Error {}

/**
 * Files a write whose diff never ran, once per table: the first says the connection is failing, and the rest say the
 * same.
 */
function createDiffLostReporter(table) {
  let reported = false;
  return () => {
    if (reported) return;
    reported = true;
    (0, _telemetry.reportStoreDegradation)({
      scope: `row_table.diff_lost.${table}`,
      group: 'row_table.diff_lost',
      context: 'a write found no record of its own diff, so it reported every entity changed; readers repaint rather than show stale rows',
      extra: {
        table
      }
    });
  };
}

/**
 * Dev-only: {@linkcode ShredSpec.deleteWhere | deleteWhere} must name exactly the filter's columns, so the native and
 * JS paths replace the same rows.
 */
function assertDeleteWhereMatches(table, variant, spec, where) {
  const deleteColumns = new Set((spec.deleteWhere ?? []).map(clause => clause.column));
  const whereColumns = Object.keys(where);
  const missing = whereColumns.filter(column => !deleteColumns.has(column));
  const extra = [...deleteColumns].filter(column => !whereColumns.includes(column));
  if (!missing.length && !extra.length) return;
  const detail = [missing.length ? `does not cover ${missing.map(column => `\`${column}\``).join(', ')} — the replace would leave the previous rows behind and the insert would append to them` : '', extra.length ? `covers ${extra.map(column => `\`${column}\``).join(', ')}, which the filter does not — the replace would reach outside the partition being written` : ''].filter(Boolean).join('; and it ');
  throw new ShredSpecMisconfigured(`row_table: the '${variant}' shred spec for \`${table}\` ${detail}. ` + `\`deleteWhere\` must name exactly the columns of the filter passed to \`shred\` (${whereColumns.map(column => `\`${column}\``).join(', ') || 'none'}), ` + `so the native and JS ingest paths replace the same rows.`);
}

/** Options for {@linkcode createSqliteRowTable}. */

/**
 * Creates a {@linkcode RowTable} backed by a SQLite table. Rows stay in SQLite, and only the ones a read selects become
 * JS objects. {@linkcode defineSqliteStore} creates one when a store is bound. Call its
 * {@linkcode RowTable.init | init} before anything else, which creates the table or rebuilds an outdated one.
 */
function createSqliteRowTable(schema, conn, storeShredSpec, options = {}) {
  if (__DEV__) (0, _query.assertEntityIdColumn)(schema);
  const cols = (0, _types.columnNames)(schema);
  const nativeShredSpec = schema.partitioned && storeShredSpec ? (0, _partitioned.partitionedShredSpec)(storeShredSpec) : storeShredSpec;

  /** Fills in each row's `partition_key` from the replace's `where`: the rows are the caller's to hand over. */
  const stampPartition = (where, rows) => {
    if (!schema.partitioned) return rows;
    const key = where[_partitioned.PARTITION_KEY_COLUMN];
    if (key == null) return rows;
    for (const row of rows) row[_partitioned.PARTITION_KEY_COLUMN] = key;
    return rows;
  };
  const stageFingerprint = (0, _schema.schemaFingerprint)(schema);
  const asyncStage = (0, _entity_diff_sql.stageNames)(schema.table, stageFingerprint, 'async');
  const asyncDiff = (0, _entity_diff_sql.entityDiffSql)(schema, asyncStage, MAX_BIND_VARIABLES);
  const syncDiff = (0, _entity_diff_sql.entityDiffSql)(schema, (0, _entity_diff_sql.stageNames)(schema.table, stageFingerprint, 'sync'), MAX_BIND_VARIABLES);

  /**
   * Async writes run one at a time. Each stages its rows and then diffs the stage in a second step, and the native
   * shred cannot join the diff's transaction, so a second write starting in between would empty or refill the stage
   * the first one is about to diff. SQLite serializes writes on the one writer handle anyway, so this costs nothing.
   */
  /** Settles with nothing, so the queue does not keep the last write's result, a whole partition's change set, alive. */
  let writeTail = Promise.resolve();
  function serialized(write) {
    const run = writeTail.then(write, write);
    writeTail = run.then(() => undefined, () => undefined);
    return run;
  }
  let lastWriteId = 0;
  const nextWriteId = () => {
    lastWriteId += 1;
    return lastWriteId;
  };
  const diffLost = createDiffLostReporter(schema.table);

  /**
   * Reads back what one write changed. The summary row is always written, so finding none means the transaction never
   * ran — a guarded connection in release answers a failed statement with silence — and the write reports every entity
   * rather than none: a reader woken for nothing costs a render, and one left asleep shows stale data.
   */
  function readBack(sql, writeId) {
    const [statement, params] = sql.readBack(writeId);
    const result = conn.execute(statement, params);
    const rows = result.rows?._array ?? [];
    result.dispose?.();
    let count;
    const changed = new Set();
    for (const row of rows) {
      if (row.rows != null) count = row.rows;else if (row.entity_id != null) changed.add(String(row.entity_id));
    }
    if (count === undefined) {
      diffLost();
      return {
        changes: _change_set.ALL_ENTITIES,
        rows: 0
      };
    }
    return {
      changes: changed.size ? changed : _change_set.NO_CHANGES,
      rows: count
    };
  }
  const presence = (0, _presence.createPresence)();

  // `setMeta` is the only writer, so once loaded these caches answer every etag and description read on their own.
  const metaCache = new Map();
  const recordCache = new Map();
  let metaLoaded = false;
  const metaKey = where => schema.meta ? (0, _args_key.cacheKeyOf)(schema.meta.keyColumns.map(column => String(where[column] ?? ''))) : '';
  function ensureMetaLoaded(meta) {
    if (metaLoaded) return;
    const cols = [...meta.keyColumns, meta.column, ...(meta.recordColumn ? [meta.recordColumn] : [])];
    const rows = (0, _connection.readRows)(conn, `SELECT ${cols.join(', ')} FROM ${meta.table};`);
    for (const row of rows) {
      const key = metaKey(row);
      metaCache.set(key, row[meta.column] ?? undefined);
      const record = meta.recordColumn ? row[meta.recordColumn] : undefined;
      if (record != null) recordCache.set(key, record);
    }
    metaLoaded = true;
  }

  /** Adds the description column to an ETag table built before it existed; a new one is created with it. */
  function ensureRecordColumn(meta) {
    if (!meta.recordColumn) return;
    const present = (0, _connection.readRows)(conn, `PRAGMA table_info(${meta.table});`).some(column => column.name === meta.recordColumn);
    if (!present) conn.execute(`ALTER TABLE ${meta.table} ADD COLUMN ${meta.recordColumn} TEXT;`);
  }
  const secondaryIndexes = schema.indexes ?? [];
  const runIndexDdl = async sql => {
    for (const idx of secondaryIndexes) {
      // eslint-disable-next-line no-await-in-loop -- DDL must not interleave
      if (conn.executeAsync) await conn.executeAsync(sql(idx));else conn.execute(sql(idx));
    }
  };
  let deferrals = 0;

  /** Bulk-writes with the secondary indexes dropped and rebuilt after: one sort beats maintaining them row by row. */
  async function withDeferredIndexes(write) {
    // Never without a dedicated reader. Dropping and recreating indexes around the write turns one statement into
    // several, and every one of them is a window in which a read that needs a transaction — the ranker's `TEMP`
    // tables, which fall back to this handle when there is no reader — can land inside the write and be refused as a
    // nested transaction. That refusal degrades the store, which costs far more than the indexes save.
    const defer = !!conn.reader && secondaryIndexes.length > 0 && (deferrals > 0 || (0, _connection.readRows)(conn, `SELECT 1 FROM ${schema.table} LIMIT 1;`).length === 0);
    if (!defer) return write();
    deferrals += 1;
    // The DDL takes its turn in the write queue: SQLite refuses it as `database table is locked` while another
    // statement is writing to the table. Swallowed: the rebuild below is `IF NOT EXISTS`, so it restores whatever did
    // drop.
    if (deferrals === 1) await serialized(() => runIndexDdl(_schema.dropIndexSql)).catch(() => {});
    try {
      return await write();
    } finally {
      deferrals -= 1;
      if (deferrals === 0) await serialized(() => runIndexDdl(idx => (0, _schema.createIndexSql)(schema.table, idx)));
    }
  }

  /**
   * The declared spec pointed at the stage, one copy per variant. The declared spec is never edited: its table name is
   * part of the schema stamps, and changing it would rebuild every installed database. Held by identity, since the
   * native adapter caches a spec's serialization by the object.
   */
  const stageSpecs = new Map();
  const stageSpecFor = (variant, spec) => {
    let staged = stageSpecs.get(variant);
    if (!staged) stageSpecs.set(variant, staged = {
      ...spec,
      table: asyncStage.stage
    });
    return staged;
  };

  /** Stages `rows` and applies them in one transaction, then reads back what changed. */
  async function stageAndApply(mode, where, rows) {
    const writeId = nextWriteId();
    await (0, _connection.runBatchAsync)(conn, [...asyncDiff.ensure, asyncDiff.clear, ...asyncDiff.stageRows(rows), ...asyncDiff.diff(mode, where, writeId)]);
    return readBack(asyncDiff, writeId);
  }

  /**
   * Whether the partition holds no rows, asked of the writer so it sees every write before it. An empty partition has
   * nothing to compare against, so its write skips the stage and lands straight in the table: every entity it brings is
   * new. That is a first load — a cold start, a new week — and it is the one write where staging would double the cost.
   */
  const partitionIsEmpty = where => {
    const {
      sql,
      params
    } = (0, _query.whereClause)(where);
    const result = conn.execute(`SELECT 1 AS one FROM ${schema.table}${sql} LIMIT 1;`, params);
    const empty = !(result.rows?._array ?? []).length;
    result.dispose?.();
    return empty;
  };
  const entityIdsOf = rows => rows.length ? new Set(rows.map(row => String(row[schema.entityId]))) : _change_set.NO_CHANGES;

  /** The entities a direct write landed, read back from the table, since the native shred's rows never reach JS. */
  const entitiesLanded = (where, rows) => {
    const {
      sql,
      params
    } = (0, _query.whereClause)(where);
    const result = conn.execute(`SELECT DISTINCT ${schema.entityId} AS entity_id FROM ${schema.table}${sql};`, params);
    const entityIds = new Set((result.rows?._array ?? []).map(row => String(row.entity_id)));
    result.dispose?.();
    // Rows landed but none can be found: the read failed silently, so say everything changed rather than nothing.
    if (rows > 0 && !entityIds.size) {
      diffLost();
      return {
        changes: _change_set.ALL_ENTITIES,
        rows
      };
    }
    return {
      changes: entityIds.size ? entityIds : _change_set.NO_CHANGES,
      rows
    };
  };

  /** A whole-partition replace written straight into the table, the way every write worked before change sets. */
  const replaceDirectly = (where, rows) => {
    const {
      sql,
      params
    } = (0, _query.whereClause)(where);
    return [[`DELETE FROM ${schema.table}${sql};`, params], ...syncDiff.insertInto(schema.table, rows)];
  };
  async function shredOrParse(where, rawJson, parseRows, partition, inJs) {
    const direct = partitionIsEmpty(where);
    let nativeError;
    if (!inJs && conn.shredJsonArrayAsync && nativeShredSpec) {
      try {
        const variant = nativeShredSpec.variant(partition);
        const spec = nativeShredSpec.specs[variant];
        // A partition with no spec entry is one this store shreds in JS; the catch below is that fallback.
        if (!spec) throw new Error(`row_table: shred variant '${variant}' is not in the spec table`);
        if (__DEV__) assertDeleteWhereMatches(schema.table, variant, spec, where);
        const storeBinds = nativeShredSpec.binds(partition);
        const binds = schema.partitioned ? [where[_partitioned.PARTITION_KEY_COLUMN], ...storeBinds] : storeBinds;
        let result;
        if (direct) {
          const landed = await conn.shredJsonArrayAsync(spec, rawJson, binds);
          result = entitiesLanded(where, landed);
        } else {
          await (0, _connection.runBatchAsync)(conn, [...asyncDiff.ensure, asyncDiff.clear]);
          await conn.shredJsonArrayAsync(stageSpecFor(variant, spec), rawJson, binds);
          const writeId = nextWriteId();
          await (0, _connection.runBatchAsync)(conn, asyncDiff.diff('replace', where, writeId));
          result = readBack(asyncDiff, writeId);
        }
        presence.afterDelete(where);
        return result;
      } catch (error) {
        if (error instanceof ShredSpecMisconfigured) throw error;
        nativeError = error;
      }
    }
    let parsed;
    try {
      parsed = parseRows(rawJson);
    } catch (error) {
      (0, _telemetry.reportStoreDegradation)({
        scope: `row_table.unparseable_body.${schema.table}`,
        group: 'row_table.unparseable_body',
        context: 'a fetched body is not valid JSON, most often one cut short in transit; the fetch fails and is retried',
        error,
        // A `SyntaxError` is the body; anything else is the store's `toRows`.
        severity: error instanceof SyntaxError ? 'info' : 'error',
        extra: {
          table: schema.table,
          where: (0, _presence.whereMapKey)(where),
          rawLength: rawJson.length
        }
      });
      throw error;
    }
    // Only a body JS can parse makes the native failure worth reporting.
    const rows = stampPartition(where, parsed);
    if (nativeError) {
      (0, _telemetry.reportStoreDegradation)({
        scope: `row_table.native_shred.${schema.table}`,
        group: 'row_table.native_shred',
        context: 'native shred failed; fell back to the JS parse path, which builds the transient object graph the shred exists to avoid',
        error: nativeError,
        extra: {
          table: schema.table,
          where: (0, _presence.whereMapKey)(where),
          rawLength: rawJson.length
        }
      });
    }
    if (__DEV__) (0, _query.assertRowsMatchWhere)(schema.table, where, rows);
    let result;
    if (direct) {
      await (0, _connection.runBatchAsync)(conn, replaceDirectly(where, rows));
      result = {
        changes: entityIdsOf(rows),
        rows: rows.length
      };
    } else {
      result = await stageAndApply('replace', where, rows);
    }
    presence.afterDelete(where);
    return result;
  }
  function selectRows(where) {
    const {
      sql,
      params
    } = (0, _query.whereClause)(where);
    return (0, _connection.readRows)(conn, `SELECT * FROM ${schema.table}${sql};`, params);
  }
  return {
    primaryKey: schema.primaryKey,
    entityId: schema.entityId,
    init() {
      if (options.temporary) {
        conn.execute((0, _schema.createTableSql)(schema, true));
        for (const idx of secondaryIndexes) conn.execute((0, _schema.createIndexSql)(schema.table, idx));
        if (schema.meta) conn.execute((0, _schema.createMetaTableSql)(schema.meta, true));
        return;
      }
      const live = (0, _schema.readLiveSchema)(conn, schema.table);
      const plan = (0, _schema.planSchemaMigration)(schema, live, nativeShredSpec);
      if (plan === 'rebuild') {
        if (schema.pushFed) (0, _schema.reportPushFedRebuild)(schema.table);
        // Drops the table's indexes with it, which is how an index change gets applied.
        conn.execute(`DROP TABLE IF EXISTS ${schema.table};`);
        // The etags describe the dropped rows, so keeping them would 304 the refetch away.
        if (schema.meta) conn.execute(`DROP TABLE IF EXISTS ${schema.meta.table};`);
      }
      // A widening keeps every row, so this is the one migration that costs a user nothing.
      if (plan === 'extend') for (const column of (0, _schema.addedColumns)(schema, live.columns) ?? []) conn.execute((0, _schema.addColumnSql)(schema, column));
      conn.execute((0, _schema.createTableSql)(schema));
      for (const idx of secondaryIndexes) conn.execute((0, _schema.createIndexSql)(schema.table, idx));
      if (schema.meta) {
        conn.execute((0, _schema.createMetaTableSql)(schema.meta));
        ensureRecordColumn(schema.meta);
      }
      // The columns a widening just added are NULL in every row that predates them, and a kept etag would answer the
      // fetch that fills them with a 304. Cleared rather than dropping the table, so the rows stay.
      if (plan === 'extend' && schema.meta) {
        conn.execute(schema.meta.recordColumn ? `UPDATE ${schema.meta.table} SET ${schema.meta.column} = NULL;` : `DELETE FROM ${schema.meta.table};`);
      }
      // Stamped even where the plan is `none`, so a database built before this stamp existed acquires one on the next
      // launch, and its next widening is an `ALTER TABLE` rather than a rebuild. `PRAGMA` takes no bind parameter.
      const structure = (0, _schema.schemaStructureStamp)(schema, nativeShredSpec);
      if (live.structure !== structure) conn.execute(`PRAGMA application_id = ${structure};`);
      // Stamped last, so a stamp only ever describes a fully built schema.
      if (plan !== 'none') conn.execute(`PRAGMA user_version = ${(0, _schema.schemaFingerprint)(schema, nativeShredSpec)};`);
    },
    async upsert(rows, opts) {
      if (!rows.length) return {
        changes: _change_set.NO_CHANGES,
        rows: 0
      };
      const size = opts?.chunk ?? DEFAULT_UPSERT_CHUNK;
      const chunks = (0, _collections.chunkList)(rows, size);
      let changes = _change_set.NO_CHANGES;
      for (let index = 0; index < chunks.length; index += 1) {
        // eslint-disable-next-line no-await-in-loop -- sequential by design: one transaction per chunk
        const chunk = await serialized(() => stageAndApply('merge', {}, chunks[index]));
        changes = (0, _change_set.unionChanges)(changes, chunk.changes);
        // eslint-disable-next-line no-await-in-loop -- release the JS thread between chunks
        if (index < chunks.length - 1) await yieldToEventLoop();
      }
      presence.afterInsert();
      return {
        changes,
        rows: rows.length
      };
    },
    overwrite(where, replacing) {
      const rows = stampPartition(where, replacing);
      if (__DEV__) (0, _query.assertRowsMatchWhere)(schema.table, where, rows);
      if (partitionIsEmpty(where)) {
        (0, _connection.runBatch)(conn, replaceDirectly(where, rows));
        presence.afterDelete(where);
        return {
          changes: entityIdsOf(rows),
          rows: rows.length
        };
      }
      const writeId = nextWriteId();
      (0, _connection.runBatch)(conn, [...syncDiff.ensure, syncDiff.clear, ...syncDiff.stageRows(rows), ...syncDiff.diff('replace', where, writeId)]);
      const result = readBack(syncDiff, writeId);
      presence.afterDelete(where);
      return result;
    },
    async shred(where, rawJson, parseRows, partition, inJs = false) {
      // Deferral outside the queue, so overlapping ingests into an empty table share one drop and one rebuild while
      // their writes take turns inside it.
      return withDeferredIndexes(() => serialized(() => shredOrParse(where, rawJson, parseRows, partition ?? where, inJs)));
    },
    getOne(where) {
      (0, _read_coverage.noteTableRead)();
      const {
        sql,
        params
      } = (0, _query.whereClause)(where);
      return (0, _connection.readRows)(conn, `SELECT * FROM ${schema.table}${sql} LIMIT 1;`, params)[0];
    },
    find(where, opts) {
      (0, _read_coverage.noteTableRead)();
      const out = selectRows(where);
      if (opts?.orderBy) out.sort((0, _query.comparator)(opts.orderBy));
      return out;
    },
    findIn(where, column, values, opts) {
      (0, _read_coverage.noteTableRead)();
      if (!values.length) return [];
      const rowFilter = (0, _query.whereClause)(where);
      const prefix = rowFilter.sql ? `${rowFilter.sql} AND ` : ' WHERE ';
      const out = [];
      for (const chunk of (0, _collections.chunkList)(values, opts?.chunk ?? DEFAULT_IN_CHUNK)) {
        const placeholders = bindList(chunk.length);
        const rows = (0, _connection.readRows)(conn, `SELECT * FROM ${schema.table}${prefix}${column} IN (${placeholders});`, [...rowFilter.params, ...chunk]);
        for (const row of rows) out.push(row);
      }
      return out;
    },
    has(where) {
      (0, _read_coverage.noteTableRead)();
      const cached = presence.get(where);
      if (cached !== undefined) return cached;
      const {
        sql,
        params
      } = (0, _query.whereClause)(where);
      const row = (0, _connection.readRows)(conn, `SELECT 1 AS one FROM ${schema.table}${sql} LIMIT 1;`, params)[0];
      presence.observe(where, !!row);
      return !!row;
    },
    entityIdsWhere(where) {
      (0, _read_coverage.noteTableRead)();
      const {
        sql,
        params
      } = (0, _query.whereClause)(where);
      return (0, _connection.readRows)(conn, `SELECT DISTINCT ${schema.entityId} AS entity_id FROM ${schema.table}${sql};`, params).map(row => String(row.entity_id));
    },
    getMeta(where) {
      const meta = schema.meta;
      if (!meta) return undefined;
      ensureMetaLoaded(meta);
      return metaCache.get(metaKey(where));
    },
    getMetaRecord(where) {
      const meta = schema.meta;
      if (!meta?.recordColumn) return undefined;
      ensureMetaLoaded(meta);
      return recordCache.get(metaKey(where));
    },
    setMeta(where, value, record) {
      const meta = schema.meta;
      if (!meta) return;
      const key = metaKey(where);
      ensureMetaLoaded(meta);
      const kept = meta.recordColumn ? record ?? recordCache.get(key) : undefined;
      if (value === undefined && metaCache.get(key) === undefined && kept === recordCache.get(key)) return;
      const keyCols = meta.keyColumns;
      const keyParams = keyCols.map(column => where[column]);
      // Fire-and-forget: a synchronous write would block the JS thread on SQLite's writer lock.
      metaCache.set(key, value);
      if (kept !== undefined) recordCache.set(key, kept);
      let sql;
      let params;
      if (value === undefined && kept === undefined) {
        sql = `DELETE FROM ${meta.table} WHERE ${keyCols.map(column => `${column} = ?`).join(' AND ')};`;
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
    }
  };
}

// Exported so the built declaration files keep these names in scope for the doc links above; an import that only a
// doc comment uses is dropped from them.
//# sourceMappingURL=sqlite.js.map