/**
 * The SQL for a store's shared rows: each row stored once by its primary key, however many partitions hold it. A
 * membership table lists each partition's row ids, and the store's table is a view joining the two.
 *
 * A write stages its rows, then in one transaction: fills the columns the fetch leaves out from the stored rows, keeps
 * a stored row that is newer by `newerBy`, updates changed rows in place, replaces the partition's membership, deletes
 * rows no partition holds, and records the changed rows other partitions hold. Identities match with `IS`, so a null
 * key column still names one row.
 */

import { columnNames, IndexDef, RowShape, RowTableSchema } from './types';
import type { BatchCommand } from './connection';
import type { StageNames, WriteMode } from './entity_diff_sql';
import { PARTITION_KEY_COLUMN } from './partitioned';

/** The tables under a store's view, named for it. */
export function sharedTableNames(table: string): { rows: string; members: string } {
  return { rows: `${table}__rows`, members: `${table}__members` };
}

export interface SharedRowsSql {
  /** Creates the rows and membership tables, their indexes, and the view. */
  create: (temporary: boolean) => string[];
  drop: string[];
  /** The declared secondary indexes, without `partition_key`, on the rows table. */
  indexes: Array<IndexDef<RowShape>>;
  /** Creates the TEMP tables and the stage index a write uses. */
  ensure: BatchCommand[];
  /**
   * The membership table's `sqlite_stat1` rows: a partition holds many rows, and a row few partitions. They let the
   * planner start a filtered read from the rows table's index.
   */
  planStats: ReadonlyArray<{ idx: string; stat: string }>;
  /** Compares the stage with the stored rows and applies it, recording the entities that changed here and elsewhere. */
  diff: (mode: WriteMode, where: Partial<RowShape>, writeId: number, carries?: readonly string[]) => BatchCommand[];
  /** Reads back and deletes one write's changes in other partitions. */
  readElsewhere: (writeId: number) => BatchCommand;
}

export function sharedRowsSql<Row extends RowShape>(schema: RowTableSchema<Row>, names: StageNames, path: 'async' | 'sync'): SharedRowsSql {
  const { table, entityId } = schema;
  const { rows: R, members: M } = sharedTableNames(table);
  const stage = names.stage;
  const stageTable = stage.replace(/^temp\./, '');
  const changes = names.changes;
  const elsewhere = `temp.${table}__elsewhere`;
  const removed = `temp.${table}__${path}_removed`;

  const all = columnNames(schema).filter((column) => column !== PARTITION_KEY_COLUMN);
  const identity = (schema.primaryKey as readonly string[]).filter((column) => column !== PARTITION_KEY_COLUMN);
  const rest = all.filter((column) => !identity.includes(column));
  const ids = identity.join(', ');
  const newerBy = schema.newerBy as string | undefined;

  const on = (left: string, right: string): string => identity.map((column) => `${left}.${column} IS ${right}.${column}`).join(' AND ');
  const tuple = (alias: string, columns: readonly string[]): string => `(${columns.map((column) => `${alias}.${column}`).join(', ')})`;
  const moved = rest.length ? `${tuple('r', rest)} IS NOT ${tuple('s', rest)}` : '0';
  const from = (alias: string, columns: readonly string[]): string => columns.map((column) => `${alias}.${column}`).join(', ');

  const create = (temporary: boolean): string[] => {
    const temp = temporary ? 'TEMP ' : '';
    const cols = all.map((column) => {
      const def = schema.columns[column as keyof Row];
      return `${column} ${def.type}${def.notNull ? ' NOT NULL' : ''}`;
    });
    return [
      `CREATE ${temp}TABLE IF NOT EXISTS ${R} (rid INTEGER PRIMARY KEY, ${cols.join(', ')});`,
      `CREATE INDEX IF NOT EXISTS ${table}__rows_identity ON ${R} (${ids});`,
      `CREATE ${temp}TABLE IF NOT EXISTS ${M} (${PARTITION_KEY_COLUMN} TEXT NOT NULL, rid INTEGER NOT NULL, PRIMARY KEY (${PARTITION_KEY_COLUMN}, rid)) WITHOUT ROWID;`,
      `CREATE INDEX IF NOT EXISTS ${table}__members_rid ON ${M} (rid);`,
      `CREATE ${temp}VIEW IF NOT EXISTS ${table} AS SELECT m.${PARTITION_KEY_COLUMN} AS ${PARTITION_KEY_COLUMN}, ${all.map((c) => `r.${c} AS ${c}`).join(', ')} ` +
        `FROM ${M} m JOIN ${R} r ON r.rid = m.rid;`,
    ];
  };

  const indexes = (schema.indexes ?? []).flatMap((index) => {
    const columns = (index.columns as readonly string[]).filter((column) => column !== PARTITION_KEY_COLUMN);
    return columns.length ? [{ name: index.name, columns }] : [];
  }) as Array<IndexDef<RowShape>>;

  function diff(mode: WriteMode, where: Partial<RowShape>, id: number, carries?: readonly string[]): BatchCommand[] {
    const key = where[PARTITION_KEY_COLUMN] ?? null;
    const kept = carries ? rest.filter((column) => !carries.includes(column)) : [];
    const stored = (columns: readonly string[], also = '') =>
      `(SELECT ${from('r', columns)} FROM ${R} r WHERE ${on('r', stageTable)}${also} LIMIT 1)`;
    const commands: BatchCommand[] = [[`INSERT INTO ${changes} (write_id, rows) SELECT ?, count(*) FROM ${stage};`, [id]]];
    if (kept.length) {
      commands.push([`UPDATE ${stage} SET (${kept.join(', ')}) = ${stored(kept)} WHERE EXISTS ${stored(kept)};`, []]);
    }
    if (newerBy && rest.length) {
      const older = ` AND r.${newerBy} > ${stageTable}.${newerBy}`;
      commands.push([`UPDATE ${stage} SET (${rest.join(', ')}) = ${stored(rest, older)} WHERE EXISTS ${stored(rest, older)};`, []]);
    }
    commands.push(
      // New, or moved.
      [`INSERT INTO ${changes} (write_id, entity_id) SELECT DISTINCT ?, s.${entityId} FROM ${stage} s LEFT JOIN ${R} r ON ${on('r', 's')} WHERE r.rid IS NULL OR ${moved};`, [id]],
      // Stored for another partition, and joining this one.
      [
        `INSERT INTO ${changes} (write_id, entity_id) SELECT DISTINCT ?, s.${entityId} FROM ${stage} s JOIN ${R} r ON ${on('r', 's')} ` +
          `WHERE NOT EXISTS (SELECT 1 FROM ${M} m WHERE m.${PARTITION_KEY_COLUMN} = s.${PARTITION_KEY_COLUMN} AND m.rid = r.rid);`,
        [id],
      ],
    );
    if (rest.length) {
      commands.push([
        `INSERT INTO ${elsewhere} (write_id, partition_key, entity_id) SELECT DISTINCT ?, m.${PARTITION_KEY_COLUMN}, s.${entityId} ` +
          `FROM ${stage} s JOIN ${R} r ON ${on('r', 's')} JOIN ${M} m ON m.rid = r.rid WHERE m.${PARTITION_KEY_COLUMN} <> s.${PARTITION_KEY_COLUMN} AND ${moved};`,
        [id],
      ]);
    }
    if (mode === 'replace') {
      commands.push(
        [`DELETE FROM ${removed};`, []],
        [
          `INSERT INTO ${removed} (rid) SELECT m.rid FROM ${M} m WHERE m.${PARTITION_KEY_COLUMN} = ? ` +
            `AND NOT EXISTS (SELECT 1 FROM ${R} r JOIN ${stage} s ON ${on('r', 's')} WHERE r.rid = m.rid);`,
          [key],
        ],
        [`INSERT INTO ${changes} (write_id, entity_id) SELECT DISTINCT ?, r.${entityId} FROM ${removed} x JOIN ${R} r ON r.rid = x.rid;`, [id]],
      );
    }
    if (rest.length) {
      commands.push([
        `UPDATE ${R} SET (${rest.join(', ')}) = (SELECT ${from('s', rest)} FROM ${stage} s WHERE ${on('s', R)} LIMIT 1) ` +
          `WHERE rid IN (SELECT r.rid FROM ${stage} s JOIN ${R} r ON ${on('r', 's')} WHERE ${moved});`,
        [],
      ]);
    }
    commands.push([
      `INSERT INTO ${R} (${all.join(', ')}) SELECT ${from('s', all)} FROM ${stage} s ` +
        `WHERE NOT EXISTS (SELECT 1 FROM ${R} r WHERE ${on('r', 's')}) GROUP BY ${from('s', identity)};`,
      [],
    ]);
    if (mode === 'replace') {
      commands.push(
        [`DELETE FROM ${M} WHERE ${PARTITION_KEY_COLUMN} = ? AND rid IN (SELECT rid FROM ${removed});`, [key]],
        [`DELETE FROM ${R} WHERE rid IN (SELECT rid FROM ${removed}) AND NOT EXISTS (SELECT 1 FROM ${M} m WHERE m.rid = ${R}.rid);`, []],
        [`DELETE FROM ${removed};`, []],
      );
    }
    commands.push(
      [`INSERT OR IGNORE INTO ${M} (${PARTITION_KEY_COLUMN}, rid) SELECT s.${PARTITION_KEY_COLUMN}, r.rid FROM ${stage} s JOIN ${R} r ON ${on('r', 's')};`, []],
      [`DELETE FROM ${stage};`, []],
    );
    return commands;
  }

  return {
    create,
    drop: [`DROP VIEW IF EXISTS ${table};`, `DROP TABLE IF EXISTS ${M};`, `DROP TABLE IF EXISTS ${R};`],
    indexes,
    ensure: [
      // Leaving rows are found by identity, which the stage's primary key doesn't lead with.
      [`CREATE INDEX IF NOT EXISTS temp.${stageTable}_identity ON ${stageTable} (${ids});`, []],
      [`CREATE TABLE IF NOT EXISTS ${elsewhere} (write_id INTEGER NOT NULL, partition_key TEXT, entity_id);`, []],
      [`CREATE TABLE IF NOT EXISTS ${removed} (rid INTEGER);`, []],
    ],
    planStats: [
      { idx: M, stat: '1000000 10000 1' },
      { idx: `${table}__members_rid`, stat: '1000000 2' },
    ],
    diff,
    readElsewhere: (id) => [`DELETE FROM ${elsewhere} WHERE write_id = ? RETURNING partition_key, entity_id;`, [id]],
  };
}
