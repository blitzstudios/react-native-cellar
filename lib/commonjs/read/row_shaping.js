"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.rowsOf = rowsOf;
/**
 * Queries a store's table and turns the rows into a read's value in one expression: a list, a list in the order of some
 * ids, a record keyed by id, or groups. The shapes are methods on the query's result, because the query already knows
 * what they need, such as which column holds the id and which ids were asked for. Each shape returns the caller's
 * `empty` when there are no rows, so an empty result is always the same object.
 *
 * These read the table directly, so a read whose {@linkcode ReadDef.select | select} uses them depends on the whole
 * partition (a partition is the set of rows one fetch returns and replaces) and recomputes after any write that changes
 * it. To depend on particular entities instead, use a {@linkcode byEntity} cache.
 */

/** Columns whose value is always a string, so they can key a `Map` or `Record` directly. */

/** The rows a query returned, with methods that turn them into a read's value. */

/**
 * The rows an {@linkcode RowReader.in | in} query returned (rows whose column is one of a list of values, such as some
 * player ids), with extra shapes that use that list.
 */

/**
 * Queries one table and returns the rows with methods to shape them, as {@linkcode rowsOf} creates it. A read whose
 * {@linkcode ReadDef.select | select} uses it depends on the whole partition, since it reads the table directly.
 */

function groupRows(rows, column) {
  const grouped = new Map();
  for (const row of rows) {
    const value = row[column];
    const list = grouped.get(value);
    if (list) list.push(row);else grouped.set(value, [row]);
  }
  return grouped;
}
function rowSet(rows) {
  return {
    rows,
    map(toVm, empty) {
      const out = [];
      for (const row of rows) {
        const vm = toVm(row);
        if (vm) out.push(vm);
      }
      return out.length ? out : empty;
    },
    groupBy: column => groupRows(rows, column)
  };
}
function idRowSet(rows, column, ids) {
  return {
    ...rowSet(rows),
    ordered(toVm, empty) {
      const byId = new Map();
      for (const row of rows) byId.set(row[column], row);
      const out = [];
      for (const id of ids) {
        const row = byId.get(id);
        const vm = row ? toVm(row) : undefined;
        if (vm) out.push(vm);
      }
      return out.length ? out : empty;
    },
    indexed(toVm, empty) {
      const out = {};
      let found = false;
      for (const row of rows) {
        const vm = toVm(row);
        if (vm) {
          out[row[column]] = vm;
          found = true;
        }
      }
      return found ? out : empty;
    },
    grouped: () => groupRows(rows, column)
  };
}

/**
 * Creates a {@linkcode RowReader} for a table: query methods that return the rows with methods to shape them. A store's
 * read code uses it in place of the table's own {@linkcode RowTable.find | find} and
 * {@linkcode RowTable.findIn | findIn}.
 */
function rowsOf(table) {
  return {
    where: (filter, opts) => rowSet(table.find(filter, opts)),
    in: (filter, column, values) => idRowSet(table.findIn(filter, column, values), column, values),
    given: rows => rowSet(rows)
  };
}

// Exported so the built declaration files keep these names in scope for the doc links above; an import that only a
// doc comment uses is dropped from them.
//# sourceMappingURL=row_shaping.js.map