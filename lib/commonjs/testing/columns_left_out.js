"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.columnsLeftOut = columnsLeftOut;
/**
 * The columns a store's fetches disagree about: for the same row, by the schema's `uniqueBy`, one fetch states the
 * column and another leaves it absent, which a write answers by keeping the stored value. Each needs a decision.
 * Keeping is right for a field that doesn't change; a field that does needs `complete: true`, or the value one fetch
 * brought stays until that fetch runs again.
 *
 * Hand it the rows each fetch builds from a recorded body (its `toRows`), keyed by any name, with bodies that share
 * rows, and assert the result against the columns the store keeps on purpose, so a new fetch or column fails the test
 * until someone decides.
 */
function columnsLeftOut(schema, rowsByFetch) {
  const statedByRow = new Map();
  const leftOutByRow = new Map();
  const add = (byRow, row, column) => {
    let columns = byRow.get(row);
    if (!columns) byRow.set(row, columns = new Set());
    columns.add(column);
  };
  for (const rows of Object.values(rowsByFetch)) {
    for (const row of rows) {
      const identity = JSON.stringify(schema.uniqueBy.map(column => row[column] ?? null));
      for (const [column, value] of Object.entries(row)) add(value === undefined ? leftOutByRow : statedByRow, identity, column);
    }
  }
  const disputed = new Set();
  for (const [identity, leftOut] of leftOutByRow) {
    const stated = statedByRow.get(identity);
    for (const column of leftOut) if (stated?.has(column)) disputed.add(column);
  }
  return [...disputed].sort();
}
//# sourceMappingURL=columns_left_out.js.map