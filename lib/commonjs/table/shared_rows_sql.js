"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.sharedRowsSql = sharedRowsSql;
exports.sharedTableNames = sharedTableNames;
var _types = require("./types.js");
var _entity_diff_sql = require("./entity_diff_sql.js");
var _partitioned = require("./partitioned.js");
/**
 * The SQL for a store's shared rows: each row stored once by its `uniqueBy` columns, however many partitions hold it. A
 * membership table lists each partition's row ids, and the store's table is a view joining the two.
 *
 * A write stages its rows, then in one transaction: fills each column a staged row leaves absent from the stored row,
 * or with NULL for a new one, keeps a stored row that is newer by `newerBy`, updates changed rows in place, replaces
 * the partition's membership, deletes rows no partition holds, and records the changed rows other partitions hold.
 * Identities match with `IS`, so a null key column still names one row.
 */

/** The tables under a store's view, named for it. */
function sharedTableNames(table) {
  return {
    rows: `${table}__rows`,
    members: `${table}__members`
  };
}
function sharedRowsSql(schema, names, path) {
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
  const all = (0, _types.columnNames)(schema).filter(column => column !== _partitioned.PARTITION_KEY_COLUMN);
  const identity = schema.primaryKey.filter(column => column !== _partitioned.PARTITION_KEY_COLUMN);
  const rest = all.filter(column => !identity.includes(column));
  const ids = identity.join(', ');
  const newerBy = schema.newerBy;
  const on = (left, right) => identity.map(column => `${left}.${column} IS ${right}.${column}`).join(' AND ');
  const tuple = (alias, columns) => `(${columns.map(column => `${alias}.${column}`).join(', ')})`;
  const moved = rest.length ? `${tuple('r', rest)} IS NOT ${tuple('s', rest)}` : '0';
  const from = (alias, columns) => columns.map(column => `${alias}.${column}`).join(', ');
  const create = temporary => {
    const temp = temporary ? 'TEMP ' : '';
    const cols = all.map(column => {
      const def = schema.columns[column];
      return `${column} ${def.type}${def.notNull ? ' NOT NULL' : ''}`;
    });
    return [`CREATE ${temp}TABLE IF NOT EXISTS ${R} (rid INTEGER PRIMARY KEY, ${cols.join(', ')});`, `CREATE INDEX IF NOT EXISTS ${table}__rows_identity ON ${R} (${ids});`, `CREATE ${temp}TABLE IF NOT EXISTS ${M} (${_partitioned.PARTITION_KEY_COLUMN} TEXT NOT NULL, rid INTEGER NOT NULL, PRIMARY KEY (${_partitioned.PARTITION_KEY_COLUMN}, rid)) WITHOUT ROWID;`, `CREATE INDEX IF NOT EXISTS ${table}__members_rid ON ${M} (rid);`, `CREATE ${temp}VIEW IF NOT EXISTS ${table} AS SELECT m.${_partitioned.PARTITION_KEY_COLUMN} AS ${_partitioned.PARTITION_KEY_COLUMN}, ${all.map(c => `r.${c} AS ${c}`).join(', ')} ` + `FROM ${M} m JOIN ${R} r ON r.rid = m.rid;`];
  };

  /** SQL true when the element JSON has nothing at `path`, which `json_type` tells apart from a JSON `null`. */
  const nothingAt = path => {
    const jsonPath = `$.${path.split('.').map(key => JSON.stringify(key)).join('.')}`;
    return `json_type(${_entity_diff_sql.ELEMENT_JSON_COLUMN}, '${jsonPath.replace(/'/g, "''")}') IS NULL`;
  };
  /** When `column` is absent for `op`, as SQL over the staged row, mirroring `evalShredOp`; undefined for never. */
  const absentWhen = (column, op) => {
    if ('complete' in op && op.complete === true) return undefined;
    const complete = 'complete' in op && typeof op.complete === 'string' ? nothingAt(op.complete) : undefined;
    switch (op.op) {
      case 'text':
      case 'int':
      case 'real':
      case 'boolInt':
      case 'metaText':
      case 'rawJsonField':
        return complete ?? `${column} IS NULL AND ${nothingAt(op.path)}`;
      case 'real0':
        return complete;
      case 'coalesceText':
        if (op.fallbackBindIndex != null || op.emptyDefault) return undefined;
        return `${column} IS NULL AND ${op.paths.map(nothingAt).join(' AND ')}`;
      default:
        return undefined;
    }
  };
  function absentFromElements(spec) {
    // Grouped by condition: a stats map's columns share one, so a row tests it once rather than once per stat.
    const byCondition = new Map();
    spec.ops.forEach((op, index) => {
      const column = spec.columns[index];
      if (!rest.includes(column)) return;
      const when = absentWhen(column, op);
      if (when) byCondition.set(when, [...(byCondition.get(when) ?? []), column]);
    });
    const listed = [...byCondition].map(([when, columns]) => `CASE WHEN ${when} THEN '${columns.join(',')},' ELSE '' END`);
    const absent = listed.length ? `NULLIF(',' || ${listed.join(' || ')}, ',')` : 'NULL';
    return [`UPDATE ${stage} SET ${_entity_diff_sql.ABSENT_COLUMN} = ${absent}, ${_entity_diff_sql.ELEMENT_JSON_COLUMN} = NULL WHERE ${_entity_diff_sql.ELEMENT_JSON_COLUMN} IS NOT NULL;`, []];
  }
  function diff(mode, where, id, absentSets) {
    const key = where[_partitioned.PARTITION_KEY_COLUMN] ?? null;
    const stored = (columns, also = '') => `(SELECT ${from('r', columns)} FROM ${R} r WHERE ${on('r', stageTable)}${also} LIMIT 1)`;
    const commands = [[`INSERT INTO ${changes} (write_id, rows) SELECT ?, count(*) FROM ${stage};`, [id]]];
    // One statement per set of absent columns, copying just those: a new row's subquery finds nothing, which is NULL.
    for (const absent of absentSets) {
      const columns = absent.split(',').filter(column => rest.includes(column));
      if (columns.length) commands.push([`UPDATE ${stage} SET (${columns.join(', ')}) = ${stored(columns)} WHERE ${_entity_diff_sql.ABSENT_COLUMN} = ?;`, [absent]]);
    }
    if (newerBy && rest.length) {
      const older = ` AND r.${newerBy} > ${stageTable}.${newerBy}`;
      commands.push([`UPDATE ${stage} SET (${rest.join(', ')}) = ${stored(rest, older)} WHERE EXISTS ${stored(rest, older)};`, []]);
    }
    commands.push(
    // New, or moved.
    [`INSERT INTO ${changes} (write_id, entity_id) SELECT DISTINCT ?, s.${entityId} FROM ${stage} s LEFT JOIN ${R} r ON ${on('r', 's')} WHERE r.rid IS NULL OR ${moved};`, [id]],
    // Stored for another partition, and joining this one.
    [`INSERT INTO ${changes} (write_id, entity_id) SELECT DISTINCT ?, s.${entityId} FROM ${stage} s JOIN ${R} r ON ${on('r', 's')} ` + `WHERE NOT EXISTS (SELECT 1 FROM ${M} m WHERE m.${_partitioned.PARTITION_KEY_COLUMN} = s.${_partitioned.PARTITION_KEY_COLUMN} AND m.rid = r.rid);`, [id]]);
    if (rest.length) {
      commands.push([`INSERT INTO ${elsewhere} (write_id, partition_key, entity_id) SELECT DISTINCT ?, m.${_partitioned.PARTITION_KEY_COLUMN}, s.${entityId} ` + `FROM ${stage} s JOIN ${R} r ON ${on('r', 's')} JOIN ${M} m ON m.rid = r.rid WHERE m.${_partitioned.PARTITION_KEY_COLUMN} <> s.${_partitioned.PARTITION_KEY_COLUMN} AND ${moved};`, [id]]);
    }
    if (mode === 'replace') {
      commands.push([`DELETE FROM ${removed};`, []], [`INSERT INTO ${removed} (rid) SELECT m.rid FROM ${M} m WHERE m.${_partitioned.PARTITION_KEY_COLUMN} = ? ` + `AND NOT EXISTS (SELECT 1 FROM ${R} r JOIN ${stage} s ON ${on('r', 's')} WHERE r.rid = m.rid);`, [key]], [`INSERT INTO ${changes} (write_id, entity_id) SELECT DISTINCT ?, r.${entityId} FROM ${removed} x JOIN ${R} r ON r.rid = x.rid;`, [id]]);
    }
    if (rest.length) {
      commands.push([`UPDATE ${R} SET (${rest.join(', ')}) = (SELECT ${from('s', rest)} FROM ${stage} s WHERE ${on('s', R)} LIMIT 1) ` + `WHERE rid IN (SELECT r.rid FROM ${stage} s JOIN ${R} r ON ${on('r', 's')} WHERE ${moved});`, []]);
    }
    commands.push([`INSERT INTO ${R} (${all.join(', ')}) SELECT ${from('s', all)} FROM ${stage} s ` + `WHERE NOT EXISTS (SELECT 1 FROM ${R} r WHERE ${on('r', 's')}) GROUP BY ${from('s', identity)};`, []]);
    if (mode === 'replace') {
      commands.push([`DELETE FROM ${M} WHERE ${_partitioned.PARTITION_KEY_COLUMN} = ? AND rid IN (SELECT rid FROM ${removed});`, [key]], [`DELETE FROM ${R} WHERE rid IN (SELECT rid FROM ${removed}) AND NOT EXISTS (SELECT 1 FROM ${M} m WHERE m.rid = ${R}.rid);`, []], [`DELETE FROM ${removed};`, []]);
    }
    commands.push([`INSERT OR IGNORE INTO ${M} (${_partitioned.PARTITION_KEY_COLUMN}, rid) SELECT s.${_partitioned.PARTITION_KEY_COLUMN}, r.rid FROM ${stage} s JOIN ${R} r ON ${on('r', 's')};`, []], [`DELETE FROM ${stage};`, []]);
    return commands;
  }
  return {
    create,
    absentFromElements,
    absentSets: `SELECT DISTINCT ${_entity_diff_sql.ABSENT_COLUMN} AS absent FROM ${stage} WHERE ${_entity_diff_sql.ABSENT_COLUMN} IS NOT NULL;`,
    drop: [`DROP VIEW IF EXISTS ${table};`, `DROP TABLE IF EXISTS ${M};`, `DROP TABLE IF EXISTS ${R};`],
    ensure: [
    // Leaving rows are found by identity, which the stage's primary key doesn't lead with.
    [`CREATE INDEX IF NOT EXISTS temp.${stageTable}_identity ON ${stageTable} (${ids});`, []], [`CREATE TABLE IF NOT EXISTS ${elsewhere} (write_id INTEGER NOT NULL, partition_key TEXT, entity_id);`, []], [`CREATE TABLE IF NOT EXISTS ${removed} (rid INTEGER);`, []]],
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