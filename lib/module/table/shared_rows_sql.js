"use strict";

/**
 * How a store's rows are stored: once each, however many partitions hold them. A row's identity is its primary key, and
 * a partition is the set of rows its fetch returned, kept in a membership table by row id. The table a store reads by
 * name is a view joining the two, so every read, and every store's own SQL, still filters on `partition_key`.
 *
 * Writes stage their rows the way every write does, and then one transaction compares the stage with the stored rows by
 * identity: the columns a fetch doesn't carry are copied into the stage first, so a fetch of fewer columns never blanks
 * the rest; a staged copy older than the stored one by `newerBy` takes the stored values; the rows that differ are
 * updated in place, so their ids hold; the partition's membership becomes the stage's rows; and a row no partition
 * holds anymore is deleted. A row that changed and that other partitions also hold is recorded per partition, so
 * their readers are woken too.
 *
 * Identities are matched with `IS`, so a key column that is null for some rows, such as the week of a season total,
 * still names one row.
 */

import { columnNames } from "./types.js";
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
  const all = columnNames(schema).filter(column => column !== PARTITION_KEY_COLUMN);
  const identity = schema.primaryKey.filter(column => column !== PARTITION_KEY_COLUMN);
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
    return [`CREATE ${temp}TABLE IF NOT EXISTS ${R} (rid INTEGER PRIMARY KEY, ${cols.join(', ')});`, `CREATE INDEX IF NOT EXISTS ${table}__rows_identity ON ${R} (${ids});`, `CREATE ${temp}TABLE IF NOT EXISTS ${M} (${PARTITION_KEY_COLUMN} TEXT NOT NULL, rid INTEGER NOT NULL, PRIMARY KEY (${PARTITION_KEY_COLUMN}, rid)) WITHOUT ROWID;`, `CREATE INDEX IF NOT EXISTS ${table}__members_rid ON ${M} (rid);`, `CREATE ${temp}VIEW IF NOT EXISTS ${table} AS SELECT m.${PARTITION_KEY_COLUMN} AS ${PARTITION_KEY_COLUMN}, ${all.map(c => `r.${c} AS ${c}`).join(', ')} ` + `FROM ${M} m JOIN ${R} r ON r.rid = m.rid;`];
  };
  const indexes = (schema.indexes ?? []).flatMap(index => {
    const columns = index.columns.filter(column => column !== PARTITION_KEY_COLUMN);
    return columns.length ? [{
      name: index.name,
      columns
    }] : [];
  });
  function diff(mode, where, id, carries) {
    const key = where[PARTITION_KEY_COLUMN] ?? null;
    const kept = carries ? rest.filter(column => !carries.includes(column)) : [];
    const stored = (columns, also = '') => `(SELECT ${from('r', columns)} FROM ${R} r WHERE ${on('r', stageTable)}${also} LIMIT 1)`;
    const commands = [[`INSERT INTO ${changes} (write_id, rows) SELECT ?, count(*) FROM ${stage};`, [id]]];
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
    // Stored already, for another partition, and joining this one.
    [`INSERT INTO ${changes} (write_id, entity_id) SELECT DISTINCT ?, s.${entityId} FROM ${stage} s JOIN ${R} r ON ${on('r', 's')} ` + `WHERE NOT EXISTS (SELECT 1 FROM ${M} m WHERE m.${PARTITION_KEY_COLUMN} = s.${PARTITION_KEY_COLUMN} AND m.rid = r.rid);`, [id]]);
    if (rest.length) {
      commands.push([`INSERT INTO ${elsewhere} (write_id, partition_key, entity_id) SELECT DISTINCT ?, m.${PARTITION_KEY_COLUMN}, s.${entityId} ` + `FROM ${stage} s JOIN ${R} r ON ${on('r', 's')} JOIN ${M} m ON m.rid = r.rid WHERE m.${PARTITION_KEY_COLUMN} <> s.${PARTITION_KEY_COLUMN} AND ${moved};`, [id]]);
    }
    if (mode === 'replace') {
      commands.push([`DELETE FROM ${removed};`, []], [`INSERT INTO ${removed} (rid) SELECT m.rid FROM ${M} m WHERE m.${PARTITION_KEY_COLUMN} = ? ` + `AND NOT EXISTS (SELECT 1 FROM ${R} r JOIN ${stage} s ON ${on('r', 's')} WHERE r.rid = m.rid);`, [key]], [`INSERT INTO ${changes} (write_id, entity_id) SELECT DISTINCT ?, r.${entityId} FROM ${removed} x JOIN ${R} r ON r.rid = x.rid;`, [id]]);
    }
    if (rest.length) {
      commands.push([`UPDATE ${R} SET (${rest.join(', ')}) = (SELECT ${from('s', rest)} FROM ${stage} s WHERE ${on('s', R)} LIMIT 1) ` + `WHERE rid IN (SELECT r.rid FROM ${stage} s JOIN ${R} r ON ${on('r', 's')} WHERE ${moved});`, []]);
    }
    commands.push([`INSERT INTO ${R} (${all.join(', ')}) SELECT ${from('s', all)} FROM ${stage} s ` + `WHERE NOT EXISTS (SELECT 1 FROM ${R} r WHERE ${on('r', 's')}) GROUP BY ${from('s', identity)};`, []]);
    if (mode === 'replace') {
      commands.push([`DELETE FROM ${M} WHERE ${PARTITION_KEY_COLUMN} = ? AND rid IN (SELECT rid FROM ${removed});`, [key]], [`DELETE FROM ${R} WHERE rid IN (SELECT rid FROM ${removed}) AND NOT EXISTS (SELECT 1 FROM ${M} m WHERE m.rid = ${R}.rid);`, []], [`DELETE FROM ${removed};`, []]);
    }
    commands.push([`INSERT OR IGNORE INTO ${M} (${PARTITION_KEY_COLUMN}, rid) SELECT s.${PARTITION_KEY_COLUMN}, r.rid FROM ${stage} s JOIN ${R} r ON ${on('r', 's')};`, []], [`DELETE FROM ${stage};`, []]);
    return commands;
  }
  return {
    create,
    drop: [`DROP VIEW IF EXISTS ${table};`, `DROP TABLE IF EXISTS ${M};`, `DROP TABLE IF EXISTS ${R};`],
    indexes,
    ensure: [
    // Rows leaving the partition are found by probing the stage by identity, which its primary key does not lead with.
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