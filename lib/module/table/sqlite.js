"use strict";

/** The row table on SQLite: rows live in the database, and become JS objects at the moment a read materializes them. */

import { cacheKeyOf } from "../args_key.js";
import { chunkList } from "../collections.js";
import { createPresence, whereMapKey } from "./presence.js";
import { noteTableRead } from "./read_coverage.js";
import { columnNames } from "./types.js";
import { assertRowsMatchWhere, assertEntityIdColumn, comparator, whereClause } from "./query.js";
import { ALL_ENTITIES, NO_CHANGES, unionChanges } from "./change_set.js";
import { ELEMENT_JSON_COLUMN, stageNames, entityDiffSql } from "./entity_diff_sql.js";
import { sharedRowsSql, sharedTableNames } from "./shared_rows_sql.js";
import { addColumnSql, addedColumns, createIndexSql, createMetaTableSql, createTableSql, dropIndexSql, planSchemaMigration, readLiveSchema, reportPushFedRebuild, schemaFingerprint, schemaStructureStamp } from "./schema.js";
import { partitionedShredSpec, PARTITION_KEY_COLUMN } from "./partitioned.js";
import { readRows, runBatch, runBatchAsync } from "./connection.js";
import { reportStoreDegradation } from "../diagnostics/telemetry.js";
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

/** A step timed on the JS thread. */

/** A step timed by SQLite, between two of a batch's clock marks. */

/**
 * Times one write's steps in `Date.now()` time. SQLite's `julianday('now')` reads the same wall clock, so the marks a
 * batch records and the laps taken around it subtract from each other.
 */
export function stepTimer(calledAt) {
  const ms = {
    queuedMs: 0,
    shredMs: 0,
    applyMs: 0,
    dispatchMs: 0,
    resumeMs: 0,
    readBackMs: 0
  };
  let last = calledAt;
  let timed = true;
  return {
    /** Charges the time since the last lap to `step`. */
    lap(step) {
      const at = Date.now();
      ms[step] += at - last;
      last = at;
    },
    /**
     * Charges a batch that has just resolved: each native step the time between its two marks, and the rest to handing
     * the batch over and to picking its result back up. A batch whose marks did not all come back leaves the write
     * untimed.
     */
    batch(resumedAt, marks, native) {
      if (marks.length !== native.length + 1) timed = false;else {
        ms.dispatchMs += Math.max(0, marks[0] - last);
        native.forEach((step, index) => {
          ms[step] += Math.max(0, marks[index + 1] - marks[index]);
        });
        ms.resumeMs += Math.max(0, resumedAt - marks[native.length]);
      }
      last = resumedAt;
    },
    steps(path) {
      if (!timed) return undefined;
      const {
        round
      } = Math;
      return {
        path,
        queuedMs: round(ms.queuedMs),
        shredMs: round(ms.shredMs),
        applyMs: round(ms.applyMs),
        dispatchMs: round(ms.dispatchMs),
        resumeMs: round(ms.resumeMs),
        readBackMs: round(ms.readBackMs)
      };
    }
  };
}
/** A write's result with its steps, which a write whose batch lost its clock marks goes without. */
function withSteps(result, timer, path) {
  const steps = timer.steps(path);
  return steps ? {
    ...result,
    steps
  } : result;
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
    reportStoreDegradation({
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

/**
 * A shared-rows table's live schema as its view presents it: `partition_key`, the rows table's columns and the
 * membership table's own, without the row ids that join them.
 */
function readSharedLiveSchema(conn, table) {
  const {
    rows,
    members
  } = sharedTableNames(table);
  const live = readLiveSchema(conn, rows);
  if (!live.columns.length) return {
    ...live,
    inMembers: new Set()
  };
  const internal = new Set(['rid', PARTITION_KEY_COLUMN]);
  const own = columns => columns.filter(column => !internal.has(column.name));
  const inMembers = own(readLiveSchema(conn, members).columns);
  return {
    ...live,
    columns: [{
      name: PARTITION_KEY_COLUMN,
      type: 'TEXT',
      notnull: 1
    }, ...own(live.columns), ...inMembers],
    inMembers: new Set(inMembers.map(column => column.name))
  };
}

/** Refuses a `perPartition` column the membership table can't hold, or that a row's identity or index depends on. */
function assertPerPartition(schema) {
  const scoped = schema.perPartition ?? [];
  const indexed = new Set((schema.indexes ?? []).flatMap(index => index.columns));
  for (const column of scoped) {
    const why = !(column in schema.columns) ? 'is not one of its columns' : schema.primaryKey.includes(column) ? 'is part of `uniqueBy`' : column === schema.entityId || column === schema.newerBy ? 'is its `entityId` or `newerBy`' : indexed.has(column) ? 'is in an index' : schema.columns[column].notNull ? 'is `NOT NULL`, which a partition the row is new to has no value for' : undefined;
    if (why) throw new Error(`row_table: \`${schema.table}\` can't keep \`${column}\` per partition: it ${why}.`);
  }
}

/** The temp schema's page size, in bytes, for a shared-rows store's stage. */
const TEMP_PAGE_SIZE = 16384;

/** Options for {@linkcode createSqliteRowTable}. */

/**
 * Creates a {@linkcode RowTable} backed by a SQLite table. Rows stay in SQLite, and only the ones a read selects become
 * JS objects. {@linkcode defineSqliteStore} creates one when a store is bound. Call its
 * {@linkcode RowTable.init | init} before anything else, which creates the table or rebuilds an outdated one.
 */
export function createSqliteRowTable(schema, conn, storeShredSpec, options = {}) {
  if (__DEV__) assertEntityIdColumn(schema);
  const cols = columnNames(schema);
  const nativeShredSpec = schema.partitioned && storeShredSpec ? partitionedShredSpec(storeShredSpec) : storeShredSpec;

  /** Fills in each row's `partition_key` from the replace's `where`: the rows are the caller's to hand over. */
  const stampPartition = (where, rows) => {
    if (!schema.partitioned) return rows;
    const key = where[PARTITION_KEY_COLUMN];
    if (key == null) return rows;
    for (const row of rows) row[PARTITION_KEY_COLUMN] = key;
    return rows;
  };
  const stageFingerprint = schemaFingerprint(schema);
  const asyncStage = stageNames(schema.table, stageFingerprint, 'async');
  const syncStage = stageNames(schema.table, stageFingerprint, 'sync');
  const asyncDiff = entityDiffSql(schema, asyncStage, MAX_BIND_VARIABLES);
  const syncDiff = entityDiffSql(schema, syncStage, MAX_BIND_VARIABLES);
  if (schema.partitioned && schema.primaryKey.length <= 1) {
    throw new Error(`row_table: \`${schema.table}\` needs \`uniqueBy\`: the columns that make a row unique across the store's partitions.`);
  }
  if (schema.partitioned) assertPerPartition(schema);
  const shared = schema.partitioned ? {
    async: sharedRowsSql(schema, asyncStage, 'async'),
    sync: sharedRowsSql(schema, syncStage, 'sync')
  } : undefined;
  let elsewhereListener;
  const ensureFor = (diff, sharedSql) => [...diff.ensure, ...(sharedSql?.ensure ?? [])];
  const diffFor = (diff, sharedSql, mode, where, writeId, absentSets, nativeFills) => sharedSql ? sharedSql.diff(mode, where, writeId, absentSets, nativeFills) : diff.diff(mode, where, writeId);

  /**
   * Async writes run one at a time. A write reads back what its batch changed, and when, only once the JS thread picks
   * up its result, so a second write's batch landing in between would empty the stage, the change log and the clock
   * it is about to read. SQLite serializes writes on the one writer handle anyway, so this costs nothing.
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
  function readBack(sql, writeId, sharedSql) {
    if (sharedSql) noteElsewhere(sharedSql, writeId);
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
        changes: ALL_ENTITIES,
        rows: 0
      };
    }
    return {
      changes: changed.size ? changed : NO_CHANGES,
      rows: count
    };
  }

  /** Hands the listener the entities one write changed in partitions other than its own. */
  function noteElsewhere(sharedSql, writeId) {
    const [statement, params] = sharedSql.readElsewhere(writeId);
    const result = conn.execute(statement, params);
    const rows = result.rows?._array ?? [];
    result.dispose?.();
    if (!rows.length || !elsewhereListener) return;
    const byPartition = new Map();
    for (const row of rows) {
      let entities = byPartition.get(row.partition_key);
      if (!entities) byPartition.set(row.partition_key, entities = new Set());
      entities.add(String(row.entity_id));
    }
    elsewhereListener(byPartition);
  }
  const presence = createPresence();

  // `setMeta` is the only writer, so once loaded these caches answer every etag and description read on their own.
  const metaCache = new Map();
  const recordCache = new Map();
  let metaLoaded = false;
  const metaKey = where => schema.meta ? cacheKeyOf(schema.meta.keyColumns.map(column => String(where[column] ?? ''))) : '';
  function ensureMetaLoaded(meta) {
    if (metaLoaded) return;
    const cols = [...meta.keyColumns, meta.column, ...(meta.recordColumn ? [meta.recordColumn] : [])];
    const rows = readRows(conn, `SELECT ${cols.join(', ')} FROM ${meta.table};`);
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
    const present = readRows(conn, `PRAGMA table_info(${meta.table});`).some(column => column.name === meta.recordColumn);
    if (!present) conn.execute(`ALTER TABLE ${meta.table} ADD COLUMN ${meta.recordColumn} TEXT;`);
  }

  /**
   * Writes the membership table's planner stats when they are missing or differ, and reloads them on both handles,
   * which each loaded the schema already.
   */
  function ensurePlanStats(sharedSql) {
    const {
      members
    } = sharedTableNames(schema.table);
    const hasStatTable = readRows(conn, `SELECT 1 FROM sqlite_master WHERE name = 'sqlite_stat1';`).length > 0;
    const stored = hasStatTable ? readRows(conn, `SELECT idx, stat FROM sqlite_stat1 WHERE tbl = ? ORDER BY idx;`, [members]) : [];
    const wanted = [...sharedSql.planStats].sort((left, right) => left.idx < right.idx ? -1 : 1);
    if (stored.length === wanted.length && stored.every((row, index) => row.idx === wanted[index].idx && row.stat === wanted[index].stat)) return;
    // Creates `sqlite_stat1` if missing and reloads it. SQLite skips its own tables, so this analyzes nothing.
    const reload = 'ANALYZE sqlite_schema;';
    if (!hasStatTable) conn.execute(reload);
    conn.execute(`DELETE FROM sqlite_stat1 WHERE tbl = ?;`, [members]);
    for (const {
      idx,
      stat
    } of wanted) conn.execute(`INSERT INTO sqlite_stat1 (tbl, idx, stat) VALUES (?, ?, ?);`, [members, idx, stat]);
    conn.execute(reload);
    conn.reader?.execute(reload);
  }
  const indexTable = shared ? sharedTableNames(schema.table).rows : schema.table;
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
    const defer = !!conn.reader && secondaryIndexes.length > 0 && (deferrals > 0 || readRows(conn, `SELECT 1 FROM ${schema.table} LIMIT 1;`).length === 0);
    if (!defer) return write();
    deferrals += 1;
    // The DDL takes its turn in the write queue: SQLite refuses it as `database table is locked` while another
    // statement is writing to the table. Swallowed: the rebuild below is `IF NOT EXISTS`, so it restores whatever did
    // drop.
    if (deferrals === 1) await serialized(() => runIndexDdl(dropIndexSql)).catch(() => {});
    try {
      return await write();
    } finally {
      deferrals -= 1;
      if (deferrals === 0) await serialized(() => runIndexDdl(idx => createIndexSql(indexTable, idx)));
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
    if (!staged) {
      // Shared rows also stage each element's JSON, which says which columns the element leaves absent.
      const element = shared ? {
        columns: [...spec.columns, ELEMENT_JSON_COLUMN],
        ops: [...spec.ops, {
          op: 'rawJson'
        }]
      } : {};
      stageSpecs.set(variant, staged = {
        ...spec,
        ...element,
        table: asyncStage.stage
      });
    }
    return staged;
  };
  const absentReads = new Map();
  const absentFromElementsFor = (sharedSql, variant, spec) => {
    let read = absentReads.get(variant);
    if (!read) absentReads.set(variant, read = sharedSql.absentFromElements(spec));
    return read;
  };

  /**
   * Where a timed batch records SQLite's clock. Each table has its own, since writes to different tables can share a
   * connection, and a write empties it before marking it.
   */
  const clockTable = `temp.${schema.table}__write_clock`;
  const clockStart = [[`CREATE TABLE IF NOT EXISTS ${clockTable} (step INTEGER PRIMARY KEY, at REAL NOT NULL);`, []], [`DELETE FROM ${clockTable};`, []]];
  /** Records SQLite's clock, in ms since the epoch like `Date.now()`, as the batch's `step`th mark. */
  const clockMark = step => [`INSERT INTO ${clockTable} (step, at) VALUES (?, (julianday('now') - 2440587.5) * 86400000.0);`, [step]];
  /** Reads back the marks of the batch that has just resolved and charges it to `timer`. Whether every mark came back. */
  const chargeBatch = (timer, native) => {
    const resumedAt = Date.now();
    const result = conn.execute(`SELECT at FROM ${clockTable} ORDER BY step;`);
    const marks = (result.rows?._array ?? []).map(row => row.at);
    result.dispose?.();
    timer.batch(resumedAt, marks, native);
    return marks.length === native.length + 1;
  };

  /** Stages `rows` and applies them in one transaction, then reads back what changed. */
  async function stageAndApply(mode, where, rows, timer) {
    const writeId = nextWriteId();
    const apply = [...ensureFor(asyncDiff, shared?.async), asyncDiff.clear, ...asyncDiff.stageRows(rows), ...diffFor(asyncDiff, shared?.async, mode, where, writeId, asyncDiff.absentSets(rows))];
    if (!timer) {
      await runBatchAsync(conn, apply);
      return readBack(asyncDiff, writeId, shared?.async);
    }
    timer.lap('shredMs');
    await runBatchAsync(conn, [...clockStart, clockMark(0), ...apply, clockMark(1)]);
    chargeBatch(timer, ['applyMs']);
    const result = readBack(asyncDiff, writeId, shared?.async);
    timer.lap('readBackMs');
    return result;
  }

  /**
   * Whether the partition holds no rows, asked of the writer so it sees every write before it. An empty partition has
   * nothing to compare against, so its write skips the stage and lands straight in the table: every entity it brings is
   * new. That is a first load — a cold start, a new week — and it is the one write where staging would double the cost.
   */
  const partitionIsEmpty = where => {
    // A view can't be written directly, and its rows may be another partition's.
    if (shared) return false;
    const {
      sql,
      params
    } = whereClause(where);
    const result = conn.execute(`SELECT 1 AS one FROM ${schema.table}${sql} LIMIT 1;`, params);
    const empty = !(result.rows?._array ?? []).length;
    result.dispose?.();
    return empty;
  };
  const entityIdsOf = rows => rows.length ? new Set(rows.map(row => String(row[schema.entityId]))) : NO_CHANGES;

  /**
   * The entities a direct write landed, read back from the table, since the native shred's rows never reach JS. `ran`
   * is whether the write's batch is known to have run; one that did not, or a read that failed silently, says every
   * entity changed rather than none.
   */
  const entitiesLanded = (where, ran) => {
    const {
      sql,
      params
    } = whereClause(where);
    const result = conn.execute(`SELECT ${schema.entityId} AS entity_id, COUNT(*) AS n FROM ${schema.table}${sql} GROUP BY ${schema.entityId};`, params);
    const landed = result.rows?._array ?? [];
    result.dispose?.();
    const rows = landed.reduce((total, row) => total + row.n, 0);
    if (!ran) {
      diffLost();
      return {
        changes: ALL_ENTITIES,
        rows
      };
    }
    return {
      changes: landed.length ? new Set(landed.map(row => String(row.entity_id))) : NO_CHANGES,
      rows
    };
  };

  /** A whole-partition replace written straight into the table, the way every write worked before change sets. */
  const replaceDirectly = (where, rows) => {
    const {
      sql,
      params
    } = whereClause(where);
    return [[`DELETE FROM ${schema.table}${sql};`, params], ...syncDiff.insertInto(schema.table, rows)];
  };
  async function shredOrParse(where, rawJson, parseRows, partition, inJs, timer) {
    timer.lap('queuedMs');
    const direct = partitionIsEmpty(where);
    let nativeError;
    if (!inJs && conn.shredBatchAsync && nativeShredSpec) {
      try {
        const variant = nativeShredSpec.variant(partition);
        const spec = nativeShredSpec.specs[variant];
        // A partition with no spec entry is one this store shreds in JS; the catch below is that fallback.
        if (!spec) throw new Error(`row_table: shred variant '${variant}' is not in the spec table`);
        if (__DEV__) assertDeleteWhereMatches(schema.table, variant, spec, where);
        const storeBinds = nativeShredSpec.binds(partition);
        const binds = schema.partitioned ? [where[PARTITION_KEY_COLUMN], ...storeBinds] : storeBinds;
        let result;
        if (direct) {
          await conn.shredBatchAsync([...clockStart, clockMark(0), {
            shred: spec,
            rawJson,
            binds
          }, clockMark(1)]);
          result = entitiesLanded(where, chargeBatch(timer, ['shredMs']));
        } else {
          // The diff runs in the shred's own batch, against the stage that shred filled.
          const writeId = nextWriteId();
          const fills = shared ? absentFromElementsFor(shared.async, variant, spec) : [];
          await conn.shredBatchAsync([...clockStart, clockMark(0), ...ensureFor(asyncDiff, shared?.async), asyncDiff.clear, {
            shred: stageSpecFor(variant, spec),
            rawJson,
            binds
          }, clockMark(1), ...diffFor(asyncDiff, shared?.async, 'replace', where, writeId, [], fills), clockMark(2)]);
          chargeBatch(timer, ['shredMs', 'applyMs']);
          result = readBack(asyncDiff, writeId, shared?.async);
        }
        timer.lap('readBackMs');
        presence.afterDelete(where);
        return withSteps(result, timer, direct ? 'native-direct' : 'native');
      } catch (error) {
        if (error instanceof ShredSpecMisconfigured) throw error;
        nativeError = error;
      }
    }
    let parsed;
    try {
      parsed = parseRows(rawJson);
    } catch (error) {
      reportStoreDegradation({
        scope: `row_table.unparseable_body.${schema.table}`,
        group: 'row_table.unparseable_body',
        context: 'a fetched body is not valid JSON, most often one cut short in transit; the fetch fails and is retried',
        error,
        // A `SyntaxError` is the body; anything else is the store's `toRows`.
        severity: error instanceof SyntaxError ? 'info' : 'error',
        extra: {
          table: schema.table,
          where: whereMapKey(where),
          rawLength: rawJson.length
        }
      });
      throw error;
    }
    // Only a body JS can parse makes the native failure worth reporting.
    const rows = stampPartition(where, parsed);
    if (nativeError) {
      reportStoreDegradation({
        scope: `row_table.native_shred.${schema.table}`,
        group: 'row_table.native_shred',
        context: 'native shred failed; fell back to the JS parse path, which builds the transient object graph the shred exists to avoid',
        error: nativeError,
        extra: {
          table: schema.table,
          where: whereMapKey(where),
          rawLength: rawJson.length
        }
      });
    }
    if (__DEV__) assertRowsMatchWhere(schema.table, where, rows);
    let result;
    if (direct) {
      const replace = replaceDirectly(where, rows);
      timer.lap('shredMs');
      await runBatchAsync(conn, [...clockStart, clockMark(0), ...replace, clockMark(1)]);
      chargeBatch(timer, ['applyMs']);
      result = {
        changes: entityIdsOf(rows),
        rows: rows.length
      };
    } else {
      result = await stageAndApply('replace', where, rows, timer);
    }
    presence.afterDelete(where);
    return withSteps(result, timer, direct ? 'js-direct' : 'js');
  }
  function selectRows(where) {
    const {
      sql,
      params
    } = whereClause(where);
    return readRows(conn, `SELECT * FROM ${schema.table}${sql};`, params);
  }
  return {
    primaryKey: schema.primaryKey,
    entityId: schema.entityId,
    init() {
      // A staged row carries its element's JSON beside a few hundred columns, more than a 4KB page holds, and a record
      // that overflows its page is read through the overflow chain by every statement that reads it. The temp schema
      // the stage lives in takes the larger page only while it is still empty, so this runs before anything is staged.
      if (shared) conn.execute(`PRAGMA temp.page_size = ${TEMP_PAGE_SIZE};`);
      const create = temporary => {
        if (shared) shared.async.create(temporary).forEach(sql => conn.execute(sql));else conn.execute(createTableSql(schema, temporary));
      };
      if (options.temporary) {
        create(true);
        for (const idx of secondaryIndexes) conn.execute(createIndexSql(indexTable, idx));
        if (schema.meta) conn.execute(createMetaTableSql(schema.meta, true));
        return;
      }
      const kind = readRows(conn, `SELECT type FROM sqlite_master WHERE name = ?;`, [schema.table])[0]?.type;
      const live = shared && kind === 'view' ? readSharedLiveSchema(conn, schema.table) : readLiveSchema(conn, schema.table);
      const layoutMoved = kind !== undefined && kind === 'view' !== !!shared;
      const scoped = new Set(schema.perPartition ?? []);
      const inMembers = 'inMembers' in live ? live.inMembers : new Set();
      // A column stored per partition that is now shared, or the other way round, has no `ALTER TABLE` to move it.
      const scopeMoved = live.columns.some(column => column.name !== PARTITION_KEY_COLUMN && scoped.has(column.name) !== inMembers.has(column.name));
      const plan = layoutMoved || shared && kind === 'view' && scopeMoved ? 'rebuild' : planSchemaMigration(schema, live, nativeShredSpec);
      if (plan === 'rebuild') {
        if (schema.pushFed) reportPushFedRebuild(schema.table);
        // Drops the table's indexes with it, which is how an index change gets applied.
        if (kind === 'view') sharedRowsSql(schema, asyncStage, 'async').drop.forEach(sql => conn.execute(sql));else conn.execute(`DROP TABLE IF EXISTS ${schema.table};`);
        // The etags describe the dropped rows, so keeping them would 304 the refetch away.
        if (schema.meta) conn.execute(`DROP TABLE IF EXISTS ${schema.meta.table};`);
      }
      // A widening keeps every row, so this is the one migration that costs a user nothing.
      if (plan === 'extend') {
        const tableOf = column => shared && scoped.has(column) ? sharedTableNames(schema.table).members : indexTable;
        for (const column of addedColumns(schema, live.columns) ?? []) conn.execute(addColumnSql({
          ...schema,
          table: tableOf(column)
        }, column));
        // The view names its columns, so it is rebuilt over the widened rows.
        if (shared) conn.execute(`DROP VIEW IF EXISTS ${schema.table};`);
      }
      create(false);
      for (const idx of secondaryIndexes) conn.execute(createIndexSql(indexTable, idx));
      if (shared) ensurePlanStats(shared.async);
      if (schema.meta) {
        conn.execute(createMetaTableSql(schema.meta));
        ensureRecordColumn(schema.meta);
      }
      // The columns a widening just added are NULL in every row that predates them, and a kept etag would answer the
      // fetch that fills them with a 304. Cleared rather than dropping the table, so the rows stay.
      if (plan === 'extend' && schema.meta) {
        conn.execute(schema.meta.recordColumn ? `UPDATE ${schema.meta.table} SET ${schema.meta.column} = NULL;` : `DELETE FROM ${schema.meta.table};`);
      }
      // Stamped even where the plan is `none`, so a database built before this stamp existed acquires one on the next
      // launch, and its next widening is an `ALTER TABLE` rather than a rebuild. `PRAGMA` takes no bind parameter.
      const structure = schemaStructureStamp(schema, nativeShredSpec);
      if (live.structure !== structure) conn.execute(`PRAGMA application_id = ${structure};`);
      // Stamped last, so a stamp only ever describes a fully built schema.
      if (plan !== 'none') conn.execute(`PRAGMA user_version = ${schemaFingerprint(schema, nativeShredSpec)};`);
    },
    async upsert(rows, opts) {
      if (!rows.length) return {
        changes: NO_CHANGES,
        rows: 0
      };
      const size = opts?.chunk ?? DEFAULT_UPSERT_CHUNK;
      const chunks = chunkList(rows, size);
      let changes = NO_CHANGES;
      for (let index = 0; index < chunks.length; index += 1) {
        // eslint-disable-next-line no-await-in-loop -- sequential by design: one transaction per chunk
        const chunk = await serialized(() => stageAndApply('merge', {}, chunks[index]));
        changes = unionChanges(changes, chunk.changes);
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
      if (__DEV__) assertRowsMatchWhere(schema.table, where, rows);
      if (partitionIsEmpty(where)) {
        runBatch(conn, replaceDirectly(where, rows));
        presence.afterDelete(where);
        return {
          changes: entityIdsOf(rows),
          rows: rows.length
        };
      }
      const writeId = nextWriteId();
      runBatch(conn, [...ensureFor(syncDiff, shared?.sync), syncDiff.clear, ...syncDiff.stageRows(rows), ...diffFor(syncDiff, shared?.sync, 'replace', where, writeId, syncDiff.absentSets(rows))]);
      const result = readBack(syncDiff, writeId, shared?.sync);
      presence.afterDelete(where);
      return result;
    },
    async shred(where, rawJson, parseRows, partition, inJs = false) {
      // Deferral outside the queue, so overlapping ingests into an empty table share one drop and one rebuild while
      // their writes take turns inside it.
      const timer = stepTimer(Date.now());
      return withDeferredIndexes(() => serialized(() => shredOrParse(where, rawJson, parseRows, partition ?? where, inJs, timer)));
    },
    onChangesElsewhere(listener) {
      elsewhereListener = listener;
    },
    getOne(where) {
      noteTableRead();
      const {
        sql,
        params
      } = whereClause(where);
      return readRows(conn, `SELECT * FROM ${schema.table}${sql} LIMIT 1;`, params)[0];
    },
    find(where, opts) {
      noteTableRead();
      const out = selectRows(where);
      if (opts?.orderBy) out.sort(comparator(opts.orderBy));
      return out;
    },
    findIn(where, column, values, opts) {
      noteTableRead();
      if (!values.length) return [];
      const rowFilter = whereClause(where);
      const prefix = rowFilter.sql ? `${rowFilter.sql} AND ` : ' WHERE ';
      const out = [];
      for (const chunk of chunkList(values, opts?.chunk ?? DEFAULT_IN_CHUNK)) {
        const placeholders = bindList(chunk.length);
        const rows = readRows(conn, `SELECT * FROM ${schema.table}${prefix}${column} IN (${placeholders});`, [...rowFilter.params, ...chunk]);
        for (const row of rows) out.push(row);
      }
      return out;
    },
    has(where) {
      noteTableRead();
      const cached = presence.get(where);
      if (cached !== undefined) return cached;
      const {
        sql,
        params
      } = whereClause(where);
      const row = readRows(conn, `SELECT 1 AS one FROM ${schema.table}${sql} LIMIT 1;`, params)[0];
      presence.observe(where, !!row);
      return !!row;
    },
    entityIdsWhere(where) {
      noteTableRead();
      const {
        sql,
        params
      } = whereClause(where);
      return readRows(conn, `SELECT DISTINCT ${schema.entityId} AS entity_id FROM ${schema.table}${sql};`, params).map(row => String(row.entity_id));
    },
    oneRowPerEntity(where) {
      noteTableRead();
      const {
        sql,
        params
      } = whereClause(where);
      const row = readRows(conn, `SELECT count(*) = count(DISTINCT ${schema.entityId}) AS one FROM ${schema.table}${sql};`, params)[0];
      return !!row?.one;
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