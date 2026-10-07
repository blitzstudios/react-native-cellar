/**
 * Shared rows: one stored row per identity, whichever partitions hold it. A partition is the set of identities its
 * fetch returned, kept in a membership table, and the table a store reads by name is a view joining the two, so every
 * read and every store's own SQL still filters on `partition_key`.
 *
 * Writes stage their rows the way every write does, and then one transaction compares the stage with the stored rows by
 * identity: the columns a fetch doesn't carry are copied into the stage first, so a fetch of fewer columns never blanks
 * the rest; the rows that differ are rewritten; the partition's membership becomes the stage's identities; and a row no
 * partition holds anymore is deleted. A row that changed and that other partitions also hold is recorded per partition,
 * so their readers can be woken too.
 */

import { columnNames, IndexDef, RowShape, RowTableSchema } from './types';
import type { BatchCommand } from './connection';
import type { StageNames, WriteMode } from './entity_diff_sql';
import { PARTITION_KEY_COLUMN } from './partitioned';

/** The tables under a shared-rows view, named for the view. */
export function sharedTableNames(table: string): { rows: string; members: string } {
  return { rows: `${table}__rows`, members: `${table}__members` };
}

export interface SharedRowsSql {
  /** The identity columns: the declared primary key without `partition_key`. */
  identity: readonly string[];
  /** Creates the rows and membership tables, the membership index, and the view. */
  create: (temporary: boolean) => string[];
  /** Drops whatever a shared-rows table left: the view, and the two tables under it. */
  drop: string[];
  /** The declared secondary indexes, without `partition_key`, on the rows table. */
  indexes: Array<IndexDef<RowShape>>;
  /** Creates the TEMP tables a write records into. */
  ensure: BatchCommand[];
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
  const typeOf = (column: string): string => schema.columns[column as keyof Row].type;

  const on = (left: string, right: string): string => identity.map((column) => `${left}.${column} = ${right}.${column}`).join(' AND ');
  const tuple = (alias: string, columns: readonly string[]): string => `(${columns.map((column) => `${alias}.${column}`).join(', ')})`;
  const differs = rest.length ? `r.rowid IS NULL OR ${tuple('r', rest)} IS NOT ${tuple('s', rest)}` : 'r.rowid IS NULL';
  const ids = identity.join(', ');

  const create = (temporary: boolean): string[] => {
    const temp = temporary ? 'TEMP ' : '';
    const cols = all.map((column) => `${column} ${typeOf(column)}${schema.columns[column as keyof Row].notNull ? ' NOT NULL' : ''}`);
    return [
      `CREATE ${temp}TABLE IF NOT EXISTS ${R} (${cols.join(', ')}, PRIMARY KEY (${ids}));`,
      `CREATE ${temp}TABLE IF NOT EXISTS ${M} (${PARTITION_KEY_COLUMN} TEXT NOT NULL, ${identity.map((c) => `${c} ${typeOf(c)}`).join(', ')}, PRIMARY KEY (${PARTITION_KEY_COLUMN}, ${ids}));`,
      `CREATE INDEX IF NOT EXISTS ${table}__members_identity ON ${M} (${ids});`,
      `CREATE ${temp}VIEW IF NOT EXISTS ${table} AS SELECT m.${PARTITION_KEY_COLUMN} AS ${PARTITION_KEY_COLUMN}, ${all.map((c) => `r.${c} AS ${c}`).join(', ')} ` +
        `FROM ${M} m JOIN ${R} r ON ${on('r', 'm')};`,
    ];
  };

  const indexes = (schema.indexes ?? []).flatMap((index) => {
    const columns = (index.columns as readonly string[]).filter((column) => column !== PARTITION_KEY_COLUMN);
    return columns.length ? [{ name: index.name, columns }] : [];
  }) as Array<IndexDef<RowShape>>;

  function diff(mode: WriteMode, where: Partial<RowShape>, id: number, carries?: readonly string[]): BatchCommand[] {
    const key = where[PARTITION_KEY_COLUMN] ?? null;
    const kept = carries ? rest.filter((column) => !carries.includes(column)) : [];
    const commands: BatchCommand[] = [[`INSERT INTO ${changes} (write_id, rows) SELECT ?, count(*) FROM ${stage};`, [id]]];
    if (kept.length) {
      commands.push([
        `UPDATE ${stage} SET (${kept.join(', ')}) = (SELECT ${kept.map((c) => `r.${c}`).join(', ')} FROM ${R} r WHERE ${on('r', stageTable)}) ` +
          `WHERE EXISTS (SELECT 1 FROM ${R} r WHERE ${on('r', stageTable)});`,
        [],
      ]);
    }
    commands.push(
      // A row that is new or whose columns moved.
      [`INSERT INTO ${changes} (write_id, entity_id) SELECT DISTINCT ?, s.${entityId} FROM ${stage} s LEFT JOIN ${R} r ON ${on('r', 's')} WHERE ${differs};`, [id]],
      // A row another partition already held, now joining this one.
      [
        `INSERT INTO ${changes} (write_id, entity_id) SELECT DISTINCT ?, s.${entityId} FROM ${stage} s ` +
          `WHERE NOT EXISTS (SELECT 1 FROM ${M} m WHERE m.${PARTITION_KEY_COLUMN} = s.${PARTITION_KEY_COLUMN} AND ${on('m', 's')});`,
        [id],
      ],
    );
    if (rest.length) {
      commands.push([
        `INSERT INTO ${elsewhere} (write_id, partition_key, entity_id) SELECT DISTINCT ?, m.${PARTITION_KEY_COLUMN}, s.${entityId} ` +
          `FROM ${stage} s JOIN ${R} r ON ${on('r', 's')} JOIN ${M} m ON ${on('m', 'r')} ` +
          `WHERE m.${PARTITION_KEY_COLUMN} <> s.${PARTITION_KEY_COLUMN} AND ${tuple('r', rest)} IS NOT ${tuple('s', rest)};`,
        [id],
      ]);
    }
    if (mode === 'replace') {
      commands.push(
        [`DELETE FROM ${removed};`, []],
        [
          `INSERT INTO ${removed} (${ids}) SELECT ${identity.map((c) => `m.${c}`).join(', ')} FROM ${M} m ` +
            `WHERE m.${PARTITION_KEY_COLUMN} = ? AND NOT EXISTS (SELECT 1 FROM ${stage} s WHERE ${on('m', 's')});`,
          [key],
        ],
        [`INSERT INTO ${changes} (write_id, entity_id) SELECT DISTINCT ?, r.${entityId} FROM ${removed} x JOIN ${R} r ON ${on('r', 'x')};`, [id]],
      );
    }
    commands.push([`INSERT OR REPLACE INTO ${R} (${all.join(', ')}) SELECT ${all.map((c) => `s.${c}`).join(', ')} FROM ${stage} s LEFT JOIN ${R} r ON ${on('r', 's')} WHERE ${differs};`, []]);
    if (mode === 'replace') {
      commands.push(
        [`DELETE FROM ${M} WHERE ${PARTITION_KEY_COLUMN} = ? AND (${ids}) IN (SELECT ${ids} FROM ${removed});`, [key]],
        [`DELETE FROM ${R} WHERE (${ids}) IN (SELECT ${ids} FROM ${removed}) AND NOT EXISTS (SELECT 1 FROM ${M} m WHERE ${on('m', R)});`, []],
        [`DELETE FROM ${removed};`, []],
      );
    }
    commands.push(
      [`INSERT OR IGNORE INTO ${M} (${PARTITION_KEY_COLUMN}, ${ids}) SELECT ${PARTITION_KEY_COLUMN}, ${ids} FROM ${stage};`, []],
      [`DELETE FROM ${stage};`, []],
    );
    return commands;
  }

  return {
    identity,
    create,
    drop: [`DROP VIEW IF EXISTS ${table};`, `DROP TABLE IF EXISTS ${M};`, `DROP TABLE IF EXISTS ${R};`],
    indexes,
    ensure: [
      [`CREATE TABLE IF NOT EXISTS ${elsewhere} (write_id INTEGER NOT NULL, partition_key TEXT, entity_id);`, []],
      [`CREATE TABLE IF NOT EXISTS ${removed} (${identity.map((c) => `${c} ${typeOf(c)}`).join(', ')});`, []],
    ],
    diff,
    readElsewhere: (id) => [`DELETE FROM ${elsewhere} WHERE write_id = ? RETURNING partition_key, entity_id;`, [id]],
  };
}
