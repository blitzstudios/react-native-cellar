"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.columnNames = columnNames;
/**
 * The row table: the interface a store reads and writes its rows through. A store keeps its data as rows in one SQLite
 * table, and every row table works the same way over any SQLite connection (the device's, or sql.js on web and in
 * tests).
 */

/** A value one SQLite column can hold in a row table: a string, a number, or null. Booleans are stored as 0 or 1. */

/**
 * One row of a row table, as an object from column name to value. A column set to `undefined` is written as null, so a
 * row builder can leave a column out, such as a column one category of stat never fills.
 */

/**
 * The SQLite type of a column in a row table. These three cover everything a row holds: text is `TEXT`, whole numbers
 * and booleans (as 0 or 1) are `INTEGER`, other numbers are `REAL`, and anything structured, such as a list, is `TEXT`
 * holding its JSON.
 */

/** The declaration of one column of a row table: its SQLite type, and whether it may hold null. */

/**
 * A secondary index on a row table: a SQLite index over some of its columns, which lets a read that filters on those
 * columns find its rows without scanning the whole table. Declare one for each column combination reads filter on
 * that the primary key doesn't already start with, such as `['league', 'team']` for reading a team's players.
 */

/**
 * Where a row table keeps each partition's ETag: a small side table with one row per partition. A partition is the set
 * of rows one fetch returns and replaces. When a fetch's response carries an ETag, it is stored here, and the next
 * fetch of that partition sends it as `If-None-Match`; if the server answers 304 Not Modified, the partition's rows are
 * kept as they are and nothing is parsed or written.
 */

/**
 * The declaration of a row table: the SQLite table a store keeps its rows in, its columns, its primary key, the column
 * its changes are tracked by ({@linkcode RowTableSchema.entityId | entityId}), its indexes, and where it keeps ETags.
 *
 * The table is created from this on the first launch, and each launch compares it with the table on disk. A change
 * that only adds nullable columns adds them in place and keeps the rows. Any other change (a column removed, retyped
 * or made `NOT NULL`, or a different key, index or ETag table) drops the table and builds it again empty, so the store
 * fetches its rows again.
 */

/**
 * A row a partition replace ({@linkcode RowTable.overwrite}, {@linkcode RowTable.shred}) takes: its `partition_key`
 * may be left out, since the replace fills it in.
 */

/** Options for {@linkcode RowTable.find} beyond which rows to read. */

/**
 * A store's rows in one SQLite table, and the only way the store reads and writes them. The table is divided into
 * partitions: a partition is the set of rows one fetch returns and replaces, picked out by column values (a
 * {@linkcode PartitionKeySpec.where | where}, such as `{ league: 'nfl' }`). A partition holds the rows of many
 * entities: an entity is the thing a row belongs to, such as one player, named by the schema's
 * {@linkcode RowTableSchema.entityId | entityId} column.
 *
 * Every write compares its rows with the stored ones and returns its change set: the entity id of each row that was
 * added, changed or removed. A write whose rows match what the table holds returns an empty set. The table doesn't
 * notify readers itself: the code that calls the write bumps the partition's version with the change set, which is what
 * re-renders the readers of those entities.
 *
 * In a store's table, a write states only the columns a row has. A column the row leaves `undefined`, or a native
 * shred's element leaves out, keeps the stored row's value, or is NULL for a new row, while an explicit `null` clears
 * it. The `uniqueBy` columns are always stated.
 */

/** A schema's column names in the order they are declared, which is the column order of every `INSERT`. */
function columnNames(schema) {
  return Object.keys(schema.columns);
}

// Exported so the built declaration files keep these names in scope for the doc links above; an import that only a
// doc comment uses is dropped from them.
//# sourceMappingURL=types.js.map