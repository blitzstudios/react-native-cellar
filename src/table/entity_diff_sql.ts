/**
 * How a SQLite write works out which entities it changed and rewrites only those.
 *
 * Every write lands its rows in a staging table first — the native shred included, pointed at the stage by table name —
 * and then one transaction compares the stage with the main table, records the entities that differ, rewrites exactly
 * those, and empties the stage. The comparison is every column, null-safe, and exact: `(m.a, m.b) IS NOT (s.a, s.b)`
 * for a table with a primary key, and a multiset comparison per entity for one without. It is SQL shared by every write
 * path, so the native shred, the JS parse fallback and a socket upsert cannot disagree about what changed.
 *
 * The changed entities are written to a changes table, keyed by a per-write id, and read back with one
 * `DELETE … RETURNING` after the transaction, since a batch hands back no rows. Every write also records its row count
 * there, so a read-back that finds nothing at all means the transaction never ran — which a guarded connection in
 * release reports as silence — and not that nothing changed.
 */

import { columnNames, RowShape, RowTableSchema, SqlValue } from './types';
import { whereClause } from './query';
import type { BatchCommand } from './connection';
import type { RowTable } from './types';

/**
 * Where a table's writes stage: TEMP tables on the writer, so they are invisible to the reader and to the schema
 * stamps.
 */
export interface StageNames {
  stage: string;
  changes: string;
}

/**
 * The staging tables for one row table. The sync path gets a stage of its own, since
 * {@linkcode RowTable.overwrite | overwrite} runs without waiting for the async write queue and must not empty a stage
 * an async write has filled.
 *
 * The stage is named for the schema's fingerprint, so a schema that changes within a session — a Fast Refresh — stages
 * into a table with its new columns rather than one left over with the old, and nothing ever has to be dropped.
 */
export function stageNames(table: string, fingerprint: number, path: 'async' | 'sync'): StageNames {
  // Unsigned, in base 36: a fingerprint is a signed 32-bit hash, and a `-` is not legal in a bare table name.
  return {
    stage: `temp.${table}__${path}_stage_${(fingerprint >>> 0).toString(36)}`,
    changes: `temp.${table}__entity_changes`,
  };
}

/** Whether replacing a partition or merging rows in: a fetch replaces, and a socket push merges by primary key. */
export type WriteMode = 'replace' | 'merge';

export interface EntityDiffSql {
  /** Creates the stage and the changes table if the connection does not have them yet: TEMP tables go with it. */
  ensure: BatchCommand[];
  /** Empties the stage, so a write that failed halfway cannot leave rows behind for the next one to apply. */
  clear: BatchCommand;
  /** Inserts rows into the stage, chunked to stay under the bind limit. */
  stageRows: (rows: readonly RowShape[]) => BatchCommand[];
  /** The same chunked insert into any table with these columns: the main table, for a write with nothing to diff. */
  insertInto: (target: string, rows: readonly RowShape[]) => BatchCommand[];
  /** Compares the stage with the main table, records the changed entities, rewrites them, and empties the stage. */
  diff: (mode: WriteMode, where: Partial<RowShape>, writeId: number) => BatchCommand[];
  /** Reads back and deletes one write's record: its entities, and its row count. */
  readBack: (writeId: number) => BatchCommand;
}

const bindList = (count: number): string => new Array(count).fill('?').join(', ');

/** The SQL for staging, diffing and applying writes to one table, built once per table. */
export function entityDiffSql<Row extends RowShape>(schema: RowTableSchema<Row>, names: StageNames, maxBinds: number): EntityDiffSql {
  const { table, primaryKey, entityId: idColumn } = schema;
  const { stage, changes } = names;
  const cols = columnNames(schema);
  const colList = cols.join(', ');
  const keyed = primaryKey.length > 0;
  const insertVerb = keyed ? 'INSERT OR REPLACE' : 'INSERT';

  const stageDdl = (): string => {
    const lines = cols.map((column) => `${column} ${schema.columns[column].type}`);
    if (keyed) lines.push(`PRIMARY KEY (${primaryKey.join(', ')})`);
    return `CREATE TABLE IF NOT EXISTS ${stage} (${lines.join(', ')});`;
  };
  // `entity` is left untyped so a value keeps the storage class it had in the row, and compares equal to it.
  const changesDdl = `CREATE TABLE IF NOT EXISTS ${changes} (write_id INTEGER NOT NULL, entity_id, rows INTEGER);`;

  const rowsPerInsert = Math.max(1, Math.floor(maxBinds / cols.length));
  const insertSql = (target: string, rowCount: number): string =>
    `${insertVerb} INTO ${target} (${colList}) VALUES ${new Array(rowCount).fill(`(${bindList(cols.length)})`).join(', ')};`;
  const insertInto = (target: string, rows: readonly RowShape[]): BatchCommand[] => {
    const out: BatchCommand[] = [];
    for (let start = 0; start < rows.length; start += rowsPerInsert) {
      const group = rows.slice(start, start + rowsPerInsert);
      const params: SqlValue[] = [];
      for (const row of group) for (const column of cols) params.push(row[column] ?? null);
      out.push([insertSql(target, group.length), params]);
    }
    return out;
  };

  const on = primaryKey.map((column) => `m.${column} = s.${column}`).join(' AND ');
  const differs = `m.rowid IS NULL OR (${cols.map((c) => `m.${c}`).join(', ')}) IS NOT (${cols.map((c) => `s.${c}`).join(', ')})`;
  const changedEntities = `(SELECT entity_id FROM ${changes} WHERE write_id = ? AND entity_id IS NOT NULL)`;
  const counted = `INSERT INTO ${changes} (write_id, rows) SELECT ?, count(*) FROM ${stage};`;

  function replaceKeyed(where: Partial<RowShape>, id: number): BatchCommand[] {
    const filter = whereClause(where);
    const inPartition = filter.sql ? `${filter.sql} AND` : ' WHERE';
    return [
      [counted, [id]],
      // Added or different: a staged row with no row at its key, or one whose columns are not all the same.
      [`INSERT INTO ${changes} (write_id, entity_id) SELECT DISTINCT ?, s.${idColumn} FROM ${stage} s LEFT JOIN ${table} m ON ${on} WHERE ${differs};`, [id]],
      // Removed: a row in the partition whose key the payload no longer has.
      [
        `INSERT INTO ${changes} (write_id, entity_id) SELECT DISTINCT ?, m.${idColumn} FROM ${table} m${inPartition} ` +
          `NOT EXISTS (SELECT 1 FROM ${stage} s WHERE ${on});`,
        [id, ...filter.params],
      ],
      [`DELETE FROM ${table}${inPartition} ${idColumn} IN ${changedEntities};`, [...filter.params, id]],
      [`${insertVerb} INTO ${table} (${colList}) SELECT ${colList} FROM ${stage} WHERE ${idColumn} IN ${changedEntities};`, [id]],
    ];
  }

  function replaceKeyless(where: Partial<RowShape>, id: number): BatchCommand[] {
    const filter = whereClause(where);
    const inPartition = filter.sql ? `${filter.sql} AND` : ' WHERE';
    // Grouped with a count, so an entity holding a duplicate row once more or once fewer still differs.
    const held = `SELECT ${colList}, count(*) AS copies FROM ${table}${filter.sql} GROUP BY ${colList}`;
    const staged = `SELECT ${colList}, count(*) AS copies FROM ${stage} GROUP BY ${colList}`;
    return [
      [counted, [id]],
      [
        `INSERT INTO ${changes} (write_id, entity_id) SELECT ?, ${idColumn} FROM (${held} EXCEPT ${staged}) ` +
          `UNION SELECT ?, ${idColumn} FROM (${staged} EXCEPT ${held});`,
        [id, ...filter.params, id, ...filter.params],
      ],
      [`DELETE FROM ${table}${inPartition} ${idColumn} IN ${changedEntities};`, [...filter.params, id]],
      [`INSERT INTO ${table} (${colList}) SELECT ${colList} FROM ${stage} WHERE ${idColumn} IN ${changedEntities};`, [id]],
    ];
  }

  function merge(id: number): BatchCommand[] {
    const moved = `FROM ${stage} s LEFT JOIN ${table} m ON ${on} WHERE ${differs}`;
    return [
      [counted, [id]],
      [`INSERT INTO ${changes} (write_id, entity_id) SELECT DISTINCT ?, s.${idColumn} ${moved};`, [id]],
      // Row by row rather than entity by entity: a merge leaves the rest of an entity's rows where they are.
      [`INSERT OR REPLACE INTO ${table} (${colList}) SELECT ${cols.map((c) => `s.${c}`).join(', ')} ${moved};`, []],
    ];
  }

  return {
    ensure: [
      [stageDdl(), []],
      [changesDdl, []],
    ],
    clear: [`DELETE FROM ${stage};`, []],
    stageRows: (rows) => insertInto(stage, rows),
    insertInto,
    diff: (mode, where, id) => {
      if (mode === 'merge' && !keyed) throw new Error(`row_table: \`${table}\` has no primary key, so a merge has nothing to match rows on.`);
      const body = mode === 'merge' ? merge(id) : keyed ? replaceKeyed(where, id) : replaceKeyless(where, id);
      return [...body, [`DELETE FROM ${stage};`, []]];
    },
    readBack: (id) => [`DELETE FROM ${changes} WHERE write_id = ? RETURNING entity_id, rows;`, [id]],
  };
}

// Exported so the built declaration files keep these names in scope for the doc links above; an import that only a
// doc comment uses is dropped from them.
export type { RowTable };
