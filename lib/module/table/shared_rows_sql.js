"use strict";

/**
 * The SQL for a store's shared rows: each row stored once by its `uniqueBy` columns, however many partitions hold it. A
 * membership table lists each partition's row ids, and the store's table is a view joining the two.
 *
 * A write stages its rows, then in one transaction: fills each column a staged row leaves absent from the stored row,
 * or with NULL for a new one, keeps a stored row that is newer by `newerBy`, updates changed rows in place, replaces
 * the partition's membership, deletes rows no partition holds, and records the changed rows other partitions hold.
 * Identities match with `IS`, so a null key column still names one row.
 */

import { columnNames } from "./types.js";
import { ABSENT_COLUMN, ELEMENT_JSON_COLUMN } from "./entity_diff_sql.js";
import { PARTITION_KEY_COLUMN } from "./partitioned.js";
/** The tables under a store's view, named for it. */
export function sharedTableNames(table) {
  return {
    rows: `${table}__rows`,
    members: `${table}__members`
  };
}
export function sharedRowsSql(schema, names, path) {
  const {
    table,
    entityId
  } = schema;
  const {
    rows: R,
    members: M
  } = sharedTableNames(table);
  const stage = names.stage;
  const stageTable = stage.replace(/^temp\./, '');
  const changes = names.changes;
  const elsewhere = `temp.${table}__elsewhere`;
  const removed = `temp.${table}__${path}_removed`;
  const movedRows = `temp.${table}__${path}_moved`;
  const rowIds = `temp.${table}__${path}_rids`;
  const all = columnNames(schema).filter(column => column !== PARTITION_KEY_COLUMN);
  const identity = schema.primaryKey.filter(column => column !== PARTITION_KEY_COLUMN);
  const scoped = schema.perPartition ?? [];
  const stored = all.filter(column => !scoped.includes(column));
  const rest = stored.filter(column => !identity.includes(column));
  const ids = identity.join(', ');
  const newerBy = schema.newerBy;
  const on = (left, right) => identity.map(column => `${left}.${column} IS ${right}.${column}`).join(' AND ');
  const tuple = (alias, columns) => `(${columns.map(column => `${alias}.${column}`).join(', ')})`;
  const moved = rest.length ? `${tuple('r', rest)} IS NOT ${tuple('s', rest)}` : '0';
  const from = (alias, columns) => columns.map(column => `${alias}.${column}`).join(', ');
  const create = temporary => {
    const temp = temporary ? 'TEMP ' : '';
    const defs = columns => columns.map(column => {
      const def = schema.columns[column];
      return `, ${column} ${def.type}${def.notNull ? ' NOT NULL' : ''}`;
    });
    return [`CREATE ${temp}TABLE IF NOT EXISTS ${R} (rid INTEGER PRIMARY KEY${defs(stored).join('')});`, `CREATE INDEX IF NOT EXISTS ${table}__rows_identity ON ${R} (${ids});`, `CREATE ${temp}TABLE IF NOT EXISTS ${M} (${PARTITION_KEY_COLUMN} TEXT NOT NULL, rid INTEGER NOT NULL${defs(scoped).join('')}, ` + `PRIMARY KEY (${PARTITION_KEY_COLUMN}, rid)) WITHOUT ROWID;`, `CREATE INDEX IF NOT EXISTS ${table}__members_rid ON ${M} (rid);`, `CREATE ${temp}VIEW IF NOT EXISTS ${table} AS SELECT m.${PARTITION_KEY_COLUMN} AS ${PARTITION_KEY_COLUMN}, ` + `${all.map(c => `${scoped.includes(c) ? 'm' : 'r'}.${c} AS ${c}`).join(', ')} FROM ${M} m JOIN ${R} r ON r.rid = m.rid;`];
  };

  /** SQL true when the staged element JSON has nothing at `path`, which `json_type` tells apart from a JSON `null`. */
  const nothingAt = path => {
    const jsonPath = `$.${path.split('.').map(key => JSON.stringify(key)).join('.')}`;
    return `json_type(${stageTable}.${ELEMENT_JSON_COLUMN}, '${jsonPath.replace(/'/g, "''")}') IS NULL`;
  };
  /** When `column` is absent for `op`, as SQL over the staged row, mirroring `evalShredOp`; undefined for never. */
  const absentWhen = (column, op) => {
    const staged = `${stageTable}.${column}`;
    const complete = 'complete' in op && op.complete !== undefined ? nothingAt(op.complete) : undefined;
    switch (op.op) {
      case 'text':
      case 'int':
      case 'real':
      case 'boolInt':
      case 'metaText':
      case 'rawJsonField':
        return complete ?? `${staged} IS NULL AND ${nothingAt(op.path)}`;
      case 'real0':
        return complete;
      case 'coalesceText':
        if (op.fallbackBindIndex != null || op.emptyDefault) return undefined;
        return `${staged} IS NULL AND ${op.paths.map(nothingAt).join(' AND ')}`;
      default:
        return undefined;
    }
  };

  // Each staged row's stored row, found once by identity: every later statement joins on the row ids instead.
  const rowSource = `FROM ${rowIds} x JOIN ${R} r ON r.rid = x.rid WHERE x.srowid = ${stageTable}.rowid`;
  const membershipSource = `FROM ${rowIds} x JOIN ${M} m ON m.rid = x.rid WHERE x.srowid = ${stageTable}.rowid AND m.${PARTITION_KEY_COLUMN} = ${stageTable}.${PARTITION_KEY_COLUMN}`;
  const storedRow = (columns, also = '') => `(SELECT ${from('r', columns)} ${rowSource}${also} LIMIT 1)`;
  const membership = columns => `(SELECT ${from('m', columns)} ${membershipSource} LIMIT 1)`;
  /** Fills `columns`, absent where `when` holds, from the stored row or, scoped, this partition's membership. */
  const fill = (columns, when) => {
    const fromRow = columns.filter(column => rest.includes(column));
    const fromMembership = columns.filter(column => scoped.includes(column));
    return [...(fromRow.length ? [[`UPDATE ${stage} SET (${fromRow.join(', ')}) = ${storedRow(fromRow)} WHERE ${when};`, []]] : []), ...(fromMembership.length ? [[`UPDATE ${stage} SET (${fromMembership.join(', ')}) = ${membership(fromMembership)} WHERE ${when};`, []]] : [])];
  };

  /**
   * Fills each of `columns` that is absent on its own, in one statement per table, touching only the staged rows whose
   * stored copy has a value there to keep: a field no copy ever had costs a lookup per row, and no rewrite.
   */
  const fillEach = (columns, whenOf) => {
    const statement = (list, alias, source) => {
      const keep = c => `${alias}.${c} IS NOT NULL AND ${whenOf(c)}`;
      const pick = list.map(c => `CASE WHEN ${keep(c)} THEN ${alias}.${c} ELSE ${stageTable}.${c} END`).join(', ');
      return [`UPDATE ${stage} SET (${list.join(', ')}) = (SELECT ${pick} ${source} LIMIT 1) WHERE EXISTS (SELECT 1 ${source} AND (${list.map(c => `(${keep(c)})`).join(' OR ')}));`, []];
    };
    const fromRow = columns.filter(column => rest.includes(column));
    const fromMembership = columns.filter(column => scoped.includes(column));
    return [...(fromRow.length ? [statement(fromRow, 'r', rowSource)] : []), ...(fromMembership.length ? [statement(fromMembership, 'm', membershipSource)] : [])];
  };
  function absentFromElements(spec) {
    const ops = new Map(spec.columns.map((column, index) => [column, spec.ops[index]]));
    // Grouped by condition: a stats map's columns share one, so a row tests it once rather than once per stat.
    const byCondition = new Map();
    for (const [column, op] of ops) {
      if (identity.includes(column) || !all.includes(column)) continue;
      const when = absentWhen(column, op);
      if (when) byCondition.set(when, [...(byCondition.get(when) ?? []), column]);
    }
    const singles = [...byCondition.values()].filter(columns => columns.length === 1).map(([column]) => column);
    const whenOf = new Map([...byCondition].flatMap(([when, columns]) => columns.map(column => [column, when])));
    // A group is absent together, which only a row whose group columns are all NULL can be. A column reading the
    // group's whole object says so in one test; otherwise a few of its columns stand in, before the JSON is read.
    const groupFills = [...byCondition].filter(([, columns]) => columns.length > 1).flatMap(([when, columns]) => {
      const object = ops.get(columns[0]).complete;
      const whole = [...ops].find(([, op]) => op.op === 'rawJsonField' && op.path === object)?.[0];
      const nullable = columns.filter(column => ops.get(column)?.op !== 'real0').slice(0, 8);
      const necessary = whole ? [whole] : nullable;
      const precheck = necessary.map(column => `${stageTable}.${column} IS NULL AND `).join('');
      return fill(columns, `${precheck}${when}`);
    });
    return [...fillEach(singles, column => whenOf.get(column)), ...groupFills];
  }
  function diff(mode, where, id, absentSets, nativeFills = []) {
    const key = where[PARTITION_KEY_COLUMN] ?? null;
    const isNew = `s.rowid NOT IN (SELECT srowid FROM ${rowIds})`;
    const staged = `FROM ${rowIds} x JOIN ${stage} s ON s.rowid = x.srowid`;
    const commands = [[`DELETE FROM ${rowIds};`, []], [`INSERT INTO ${rowIds} (srowid, rid) SELECT s.rowid, r.rid FROM ${stage} s JOIN ${R} r ON ${on('r', 's')};`, []], [`INSERT INTO ${changes} (write_id, rows) SELECT ?, count(*) FROM ${stage};`, [id]], ...nativeFills];
    // One statement per set of absent columns, copying just those: from the stored row, or for a scoped column from
    // this partition's membership. A new row or membership finds nothing, which is NULL.
    for (const absent of absentSets) {
      const quoted = `'${absent.replace(/'/g, "''")}'`;
      commands.push(...fill(absent.split(','), `${ABSENT_COLUMN} = ${quoted}`));
    }
    if (newerBy && rest.length) {
      const older = ` AND r.${newerBy} > ${stageTable}.${newerBy}`;
      commands.push([`UPDATE ${stage} SET (${rest.join(', ')}) = ${storedRow(rest, older)} WHERE EXISTS ${storedRow(rest, older)};`, []]);
    }
    commands.push(
    // The stored rows the stage moves, compared once: every column, which is most of a write's cost.
    [`DELETE FROM ${movedRows};`, []], [`INSERT INTO ${movedRows} (rid, srowid, entity_id, partition_key) SELECT x.rid, x.srowid, s.${entityId}, s.${PARTITION_KEY_COLUMN} ` + `${staged} JOIN ${R} r ON r.rid = x.rid WHERE ${moved};`, []],
    // New, or moved.
    [`INSERT INTO ${changes} (write_id, entity_id) SELECT DISTINCT ?, s.${entityId} FROM ${stage} s WHERE ${isNew};`, [id]], [`INSERT INTO ${changes} (write_id, entity_id) SELECT DISTINCT ?, entity_id FROM ${movedRows};`, [id]],
    // Stored for another partition, and joining this one.
    [`INSERT INTO ${changes} (write_id, entity_id) SELECT DISTINCT ?, s.${entityId} ${staged} ` + `WHERE NOT EXISTS (SELECT 1 FROM ${M} m WHERE m.${PARTITION_KEY_COLUMN} = s.${PARTITION_KEY_COLUMN} AND m.rid = x.rid);`, [id]]);
    if (scoped.length) {
      // Held here already, with this partition's own values moved.
      commands.push([`INSERT INTO ${changes} (write_id, entity_id) SELECT DISTINCT ?, s.${entityId} ${staged} ` + `JOIN ${M} m ON m.rid = x.rid AND m.${PARTITION_KEY_COLUMN} = s.${PARTITION_KEY_COLUMN} WHERE ${tuple('m', scoped)} IS NOT ${tuple('s', scoped)};`, [id]]);
    }
    if (rest.length) {
      commands.push([`INSERT INTO ${elsewhere} (write_id, partition_key, entity_id) SELECT DISTINCT ?, m.${PARTITION_KEY_COLUMN}, x.entity_id ` + `FROM ${movedRows} x JOIN ${M} m ON m.rid = x.rid WHERE m.${PARTITION_KEY_COLUMN} <> x.partition_key;`, [id]]);
    }
    if (mode === 'replace') {
      commands.push([`DELETE FROM ${removed};`, []], [`INSERT INTO ${removed} (rid) SELECT m.rid FROM ${M} m WHERE m.${PARTITION_KEY_COLUMN} = ? AND m.rid NOT IN (SELECT rid FROM ${rowIds});`, [key]], [`INSERT INTO ${changes} (write_id, entity_id) SELECT DISTINCT ?, r.${entityId} FROM ${removed} x JOIN ${R} r ON r.rid = x.rid;`, [id]]);
    }
    if (rest.length) {
      commands.push([`UPDATE ${R} SET (${rest.join(', ')}) = (SELECT ${from('s', rest)} FROM ${movedRows} x JOIN ${stage} s ON s.rowid = x.srowid WHERE x.rid = ${R}.rid LIMIT 1) ` + `WHERE rid IN (SELECT rid FROM ${movedRows});`, []]);
    }
    commands.push([`INSERT INTO ${R} (${stored.join(', ')}) SELECT ${from('s', stored)} FROM ${stage} s WHERE ${isNew} GROUP BY ${from('s', identity)};`, []], [`INSERT INTO ${rowIds} (srowid, rid) SELECT s.rowid, r.rid FROM ${stage} s JOIN ${R} r ON ${on('r', 's')} WHERE ${isNew};`, []]);
    if (mode === 'replace') {
      commands.push([`DELETE FROM ${M} WHERE ${PARTITION_KEY_COLUMN} = ? AND rid IN (SELECT rid FROM ${removed});`, [key]], [`DELETE FROM ${R} WHERE rid IN (SELECT rid FROM ${removed}) AND NOT EXISTS (SELECT 1 FROM ${M} m WHERE m.rid = ${R}.rid);`, []], [`DELETE FROM ${removed};`, []]);
    }
    commands.push(scoped.length ? [`INSERT INTO ${M} (${PARTITION_KEY_COLUMN}, rid, ${scoped.join(', ')}) SELECT s.${PARTITION_KEY_COLUMN}, x.rid, ${from('s', scoped)} ${staged} WHERE 1 ` + `ON CONFLICT (${PARTITION_KEY_COLUMN}, rid) DO UPDATE SET ${scoped.map(c => `${c} = excluded.${c}`).join(', ')} ` + `WHERE ${tuple(M, scoped)} IS NOT ${tuple('excluded', scoped)};`, []] : [`INSERT OR IGNORE INTO ${M} (${PARTITION_KEY_COLUMN}, rid) SELECT s.${PARTITION_KEY_COLUMN}, x.rid ${staged};`, []], [`DELETE FROM ${stage};`, []], [`DELETE FROM ${movedRows};`, []], [`DELETE FROM ${rowIds};`, []]);
    return commands;
  }
  return {
    create,
    absentFromElements,
    drop: [`DROP VIEW IF EXISTS ${table};`, `DROP TABLE IF EXISTS ${M};`, `DROP TABLE IF EXISTS ${R};`],
    ensure: [
    // Leaving rows are found by identity, which the stage's primary key doesn't lead with.
    [`CREATE INDEX IF NOT EXISTS temp.${stageTable}_identity ON ${stageTable} (${ids});`, []], [`CREATE TABLE IF NOT EXISTS ${elsewhere} (write_id INTEGER NOT NULL, partition_key TEXT, entity_id);`, []], [`CREATE TABLE IF NOT EXISTS ${removed} (rid INTEGER);`, []], [`CREATE TABLE IF NOT EXISTS ${movedRows} (rid INTEGER, srowid INTEGER, entity_id, partition_key TEXT);`, []], [`CREATE INDEX IF NOT EXISTS temp.${table}__${path}_moved_rid ON ${table}__${path}_moved (rid);`, []], [`CREATE TABLE IF NOT EXISTS ${rowIds} (srowid INTEGER PRIMARY KEY, rid INTEGER NOT NULL);`, []]],
    planStats: [{
      idx: M,
      stat: '1000000 10000 1'
    }, {
      idx: `${table}__members_rid`,
      stat: '1000000 2'
    }],
    diff,
    readElsewhere: id => [`DELETE FROM ${elsewhere} WHERE write_id = ? RETURNING partition_key, entity_id;`, [id]]
  };
}
//# sourceMappingURL=shared_rows_sql.js.map