"use strict";

/**
 * The format of a native shred spec. "Shredding" is turning a JSON response body into table rows. A store can do it
 * in JS (`JSON.parse` the body, then build each row with the columns' {@linkcode ShredColumn.js | js} functions), or
 * natively: our fork of `react-native-nitro-sqlite` has a C++ shredder that parses the body and inserts the rows
 * straight into SQLite, so no JS object is ever created for them. For a large body, such as every player in a sport,
 * that avoids building tens of thousands of short-lived objects on the JS heap, which is most of the time and memory a
 * JS ingest spends.
 *
 * The C++ shredder has no store code to run, so a store describes each row as data instead: a {@linkcode ShredSpec} per
 * table, listing each column and the {@linkcode ShredOp} that computes it from one element of the body. The functions
 * below ({@linkcode evalShredElement}, {@linkcode evalShredSpec}) run a spec in JS exactly as the C++ does; a parity
 * test compares the two, so a new op has to be added on both sides.
 */

/**
 * One piece of a `concat` op's text. A `concat` op computes a column by reading several values from the element and
 * joining them with a separator, such as `sport`, `season` and `player_id` joined into one id; each piece is one of
 * those values.
 */

/** What an op that reads one path can add. */

/**
 * An op: one column's instruction to the native shredder, saying how to compute that column's value from one element of
 * the response body. The C++ shredder reads the body, and for each element (each item of the JSON array, or each value
 * of the JSON object) runs every column's op to produce that row's value for the column.
 *
 * A path is dot-separated and starts at the element: `metadata.gender` reads `element.metadata.gender`. A value is
 * "missing" when the path leads nowhere or to `null`.
 *
 * A path that leads nowhere, to a key the element doesn't have or through a value that isn't an object, also makes the
 * column absent: the row doesn't state it, and a write keeps the stored row's value for it, where an explicit `null`
 * clears it. So a body that leaves a field out, such as a list endpoint that sends a subset of a detail endpoint's
 * fields, never erases what another body stored. A `bind`, a `concat`, a `real0`, and a `coalesceText` with a fallback
 * always state their column. An op's {@linkcode PathOpOptions.complete | complete} names an object whose missing keys
 * mean null instead.
 *
 * Each column also has a {@linkcode ShredColumn.js | js} function, used when rows are built in JS (on web, in tests,
 * and whenever the native shred can't run). The op has to produce exactly what that function returns, including for a
 * missing field, so pick the op that matches: for example `real` and `real0` differ only in whether a missing value
 * becomes null or 0. A parity test runs both on the same elements.
 */

/**
 * One condition of the `DELETE` a native shred runs before inserting its rows, which removes the partition's old rows
 * so the new ones replace them. It matches rows whose {@linkcode ShredDeleteClause.column | column} equals the write's
 * `binds[bindIndex]`. A spec's conditions together must name exactly the columns of the partition's
 * {@linkcode PartitionKeySpec.where | where} (checked in dev), so the native and JS paths replace the same rows.
 */

/**
 * A native shred spec for one table: everything the C++ shredder needs to turn a JSON response body into rows. For
 * each element of the body it skips the element if {@linkcode ShredSpec.whereGuard | whereGuard} says to, then computes
 * one row, filling `columns[i]` with the result of `ops[i]`. Before inserting, it deletes the partition's old rows
 * ({@linkcode ShredSpec.deleteWhere | deleteWhere}), so the body replaces the partition.
 *
 * Build {@linkcode ShredSpec.columns | columns} and {@linkcode ShredSpec.ops | ops} with {@linkcode defineShredColumns}
 * rather than by hand, so the two lists stay aligned with the table's columns and with the JS row builder.
 */

/**
 * A store's native shred specs, passed to {@linkcode defineSqliteStore} as
 * {@linkcode SqliteStoreConfig.nativeShredSpec | nativeShredSpec}. With it, a partition fetch on a device writes the
 * body with the C++ shredder instead of `JSON.parse` and the JS row builders, so no JS object is built per row. Worth
 * it for a large body; a small one can skip it. Web and tests always use the JS path.
 *
 * A store can have several specs, one per variant, when different partitions need different columns (stats for
 * different sports fill different stat columns). For each write, {@linkcode NativeShredSpec.variant | variant} picks
 * the spec and {@linkcode NativeShredSpec.binds | binds} supplies the values its `bind` ops and
 * {@linkcode ShredSpec.deleteWhere | deleteWhere} conditions use. When {@linkcode NativeShredSpec.variant | variant}
 * returns a name that isn't in {@linkcode NativeShredSpec.specs | specs}, or the native shred fails, that partition is
 * written through the JS path instead.
 */

function getPath(element, path) {
  let cur = element;
  for (const key of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[key];
  }
  return cur;
}
function isPresent(value) {
  return value != null;
}
function toConcatString(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  return String(value);
}
function toReal(value, absent) {
  if (value == null) return absent;
  const num = Number(value);
  return Number.isFinite(num) ? num : absent;
}
function coalesce(element, paths) {
  for (const path of paths) {
    const value = getPath(element, path);
    if (isPresent(value)) return value;
  }
  return undefined;
}

/** A path op's value for a field its element doesn't have: absent, unless the op's `complete` object is there. */
const missingField = (op, missing) => op.complete === undefined ? undefined : missing;

/**
 * What one op computes for one element, exactly as the C++ shredder does, with `undefined` for a column the element
 * leaves absent: the C++ stores NULL there, and Cellar reads the absence from the element's JSON. It is also how a
 * column that declares an op and no {@linkcode ShredColumn.js | js} builder is built in JS, so the two paths can't
 * disagree about that column.
 */
export function evalShredOp(op, element, binds) {
  if ('complete' in op && op.complete !== undefined && getPath(element, op.complete) === undefined) return undefined;
  switch (op.op) {
    case 'bind':
      return binds[op.index] ?? null;
    case 'text':
      {
        const value = getPath(element, op.path);
        if (value === undefined) return missingField(op, null);
        return typeof value === 'string' ? value : null;
      }
    case 'int':
      {
        const value = getPath(element, op.path);
        if (value === undefined) return missingField(op, null);
        return typeof value === 'number' ? value : null;
      }
    case 'real':
      {
        const value = getPath(element, op.path);
        if (value === undefined) return missingField(op, null);
        return toReal(value, null);
      }
    case 'boolInt':
      {
        const value = getPath(element, op.path);
        if (value === undefined) return missingField(op, null);
        return value === null ? null : value ? 1 : 0;
      }
    case 'metaText':
      {
        const value = getPath(element, op.path);
        if (value === undefined) return missingField(op, null);
        return value === null ? null : typeof value === 'string' ? value : String(value);
      }
    case 'real0':
      {
        const value = getPath(element, op.path);
        return toReal(value, 0);
      }
    case 'coalesceText':
      {
        const value = coalesce(element, op.paths);
        if (isPresent(value)) return typeof value === 'string' ? value : String(value);
        if (op.fallbackBindIndex != null) return binds[op.fallbackBindIndex] ?? null;
        if (op.emptyDefault) return '';
        return op.paths.every(path => getPath(element, path) === undefined) ? undefined : null;
      }
    case 'concat':
      return op.parts.map(part => toConcatString(coalesce(element, part.paths))).join(op.sep);
    case 'rawJsonField':
      {
        const value = getPath(element, op.path);
        if (value === undefined) return missingField(op, null);
        // Bytes differ from the native shredder, which slices the source document; both parse to the same value.
        return value === null ? null : JSON.stringify(value);
      }
    case 'rawJson':
      return JSON.stringify(element);
    default:
      {
        const _exhaustive = op;
        return _exhaustive;
      }
  }
}
function passesGuard(spec, element) {
  if (!spec.whereGuard) return true;
  const value = coalesce(element, spec.whereGuard.paths);
  if (value == null) return false;
  return String(value) !== '';
}

/**
 * Runs a native shred spec on one element of a response body, in JS, and returns the row the C++ shredder produces
 * for it: an object from each of the spec's {@linkcode ShredSpec.columns | columns} to the value its op computes.
 * Returns `undefined` when the spec's {@linkcode ShredSpec.whereGuard | whereGuard} skips the element. A store's
 * parity test compares this row with the one its {@linkcode ShredColumn.js | js} functions build, so the native and JS
 * paths are known to write the same rows.
 */
export function evalShredElement(spec, element, binds) {
  if (!passesGuard(spec, element)) return undefined;
  const row = {};
  for (let index = 0; index < spec.columns.length; index += 1) {
    row[spec.columns[index]] = evalShredOp(spec.ops[index], element, binds);
  }
  return row;
}

/**
 * Runs a native shred spec on every element of a response body, in JS, and returns the rows the C++ shredder
 * produces, skipping the elements its {@linkcode ShredSpec.whereGuard | whereGuard} rejects. Pass the elements, not the
 * body: the parsed array, or `Object.values(body)` for an `objectValues` spec.
 */
export function evalShredSpec(spec, elements, binds) {
  const out = [];
  for (const element of elements) {
    const row = evalShredElement(spec, element, binds);
    if (row) out.push(row);
  }
  return out;
}

// Exported so the built declaration files keep these names in scope for the doc links above; an import that only a
// doc comment uses is dropped from them.
//# sourceMappingURL=shred_spec.js.map