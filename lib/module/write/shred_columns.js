"use strict";

/**
 * A table's columns, declared once as a list and turned into everything else that has to agree with them. A store
 * needs its columns in three places: the table's schema (names and SQLite types), the JS row builder (how each value is
 * computed from a response element), and the native shred spec (the same computation, as an op the C++ shredder
 * runs). Declaring each column once, with all three, keeps them from drifting apart.
 */

import { evalShredOp } from "./shred_spec.js";

/**
 * The ops a column can declare without a {@linkcode ShredColumn.js | js} builder: every op that reads only the element.
 * `bind`, and a `coalesceText` that falls back to a bind, read a value only the native write is handed.
 */

/** What every column declares, however its value is computed. */

/**
 * One column of a store's table, declared with everything needed to fill it: its name and SQLite type, and how to
 * compute its value from one element of a response body. An element is one item of the response: one player in a
 * players response, one stat line in a stats response.
 *
 * A column computes its value one of two ways:
 *
 * - With an {@linkcode ShredColumn.op | op} alone, when an op can say what the column is. The native C++ shredder runs
 *   the op, and so does the JS row builder, so the two paths store the same value by construction.
 * - With a {@linkcode ShredColumn.js | js} builder, when the value needs something no op can express: another field to
 *   fall back to, or what the store passes for the whole write. A store that shreds natively gives such a column an
 *   op as well, which has to produce what the builder returns; its parity test runs both on sample elements.
 */

/**
 * The type a column resolves to when its {@linkcode ShredColumn.js | js} builder returns `any`, which would switch off
 * checking for it.
 */

/** What an op stores, as the row type spells it. */

/** A column's field type: its builder's return type, or for a column without one, what its op stores. */

/**
 * The TypeScript type of one row built from a column list: an object with one field per column, named by the column's
 * {@linkcode ShredColumn.name | name} and typed by what its {@linkcode ShredColumn.js | js} function returns, or for a
 * column without one, by what its {@linkcode ShredColumn.op | op} stores. A column whose
 * {@linkcode ShredColumn.js | js} returns `any` gets an error string as its type instead, so the missing return type
 * gets noticed.
 */

/** A stored value with its `null` read as `Absent` instead. */

/** What {@linkcode ShredColumnsBase.decode | decode} reads a column back as, given what a NULL reads as. */

/**
 * The named columns of a row as {@linkcode ShredColumnsBase.decode | decode} reads them back: each typed by what its op
 * stores, a `boolInt` as a boolean, a column with its own {@linkcode ShredColumn.decode | decode} by what that
 * returns, and a NULL as `Absent`.
 */

/** The `RowTableSchema['columns']` map a column table describes. */

/**
 * What {@linkcode defineShredColumns} generates from a column list, whether or not every column has an
 * {@linkcode ShredColumn.op | op}.
 */

/**
 * The parts of a native shred spec generated from a column list; present only when every column has an
 * {@linkcode ShredColumn.op | op}.
 */

/**
 * Whether every column carries an {@linkcode ShredColumn.op | op}. A table one column short of a native shred cannot
 * produce a bind order that matches its columns, so it offers neither member rather than throwing when something
 * reaches for one — which means a store whose payload is small enough to shred in JS never declares an
 * {@linkcode ShredColumn.op | op} it has no use for.
 */

/**
 * Everything {@linkcode defineShredColumns} generates from one column list: the table's column declarations
 * ({@linkcode ShredColumnsBase.columnDefs | columnDefs}), the column names
 * ({@linkcode ShredColumnsBase.names | names}), the JS row builder ({@linkcode ShredColumnsBase.row | row}), and, when
 * every column has an {@linkcode ShredColumn.op | op}, the ops for a native shred spec
 * ({@linkcode NativeShredColumns.ops | ops}, {@linkcode NativeShredColumns.namedOps | namedOps}).
 */

const NO_BINDS = [];

/**
 * The value one column computes for one element, in JS: its {@linkcode ShredColumn.js | js} builder's, or for a column
 * without one, its {@linkcode ShredColumn.op | op}'s, run as the native shredder runs it. For building part of a row,
 * when some column's value is already to hand; {@linkcode ShredColumnsBase.row | row} builds all of them.
 */
export function shredColumnValue(column, src, ctx) {
  return column.js ? column.js(src, ctx) : evalShredOp(column.op, src, NO_BINDS);
}
const AS_STORED = stored => stored;
const AS_FLAG = stored => stored == null ? null : stored === 1;
const AS_JSON = stored => {
  if (typeof stored !== 'string') return null;
  try {
    return JSON.parse(stored);
  } catch {
    return null;
  }
};

/** How `decode` reads one column back: through the column's own `decode`, or as its op says what it stored. */
function decoderOf(column) {
  if (column.decode) return stored => column.decode(stored);
  if (column.op?.op === 'boolInt') return AS_FLAG;
  if (column.op?.op === 'rawJsonField') return AS_JSON;
  return AS_STORED;
}

/** Whether an op reads only the element, so the JS row builder can run it without the native write's binds. */
function readsOnlyTheElement(op) {
  if (!op || op.op === 'bind') return false;
  return !(op.op === 'coalesceText' && op.fallbackBindIndex != null);
}

/**
 * Generates everything that has to agree with a table's columns from one list of {@linkcode ShredColumn}s: the schema's
 * column declarations, the JS row builder, and the native shred spec's names and ops. Call it with the element type
 * (one item of the response) and the context type (what the store passes per write) first, then the column list:
 *
 * ```ts
 * const itemShred = defineShredColumns<Item, ItemShredCtx>()(ITEM_SHRED_COLUMNS);
 * ```
 */
export function defineShredColumns() {
  return columns => {
    const defs = {};
    const decoders = {};
    for (const column of columns) {
      defs[column.name] = column.notNull ? {
        type: column.type,
        notNull: true
      } : {
        type: column.type
      };
      decoders[column.name] = decoderOf(column);
      // Unreachable from TypeScript, which requires a builder unless the op reads only the element; this catches a JS caller.
      if (!column.js && !readsOnlyTheElement(column.op)) {
        throw new Error(`shred_columns: column ${JSON.stringify(column.name)} needs a js builder: its op reads a value only the native write has`);
      }
    }

    // Derived on first read and kept: the ops are the expensive pair, and a spec built per category asks for them
    // again.
    let named;
    const namedOps = () => named ??= columns.map(column => {
      // Unreachable from TypeScript, which withholds both members from a table missing one; this catches a JS caller.
      if (!column.op) throw new Error(`shred_columns: column ${JSON.stringify(column.name)} has no native-shred op`);
      return {
        name: column.name,
        op: column.op
      };
    });
    return {
      columns,
      names: columns.map(column => column.name),
      columnDefs: defs,
      get namedOps() {
        return namedOps();
      },
      get ops() {
        return namedOps().map(column => column.op);
      },
      row: (src, ctx) => {
        const row = {};
        for (const column of columns) row[column.name] = shredColumnValue(column, src, ctx);
        return row;
      },
      decode: (row, names, options) => {
        const absent = options ? options.absent : undefined;
        const out = {};
        for (const name of names) {
          // Unreachable from TypeScript, which types `names` by the table's columns; this catches a JS caller.
          const decoder = decoders[name];
          if (!decoder) throw new Error(`shred_columns: ${JSON.stringify(name)} is not a column of this table`);
          const value = decoder(row[name] ?? null);
          out[name] = value == null ? absent : value;
        }
        return out;
      }
    };
  };
}

// Exported so the built declaration files keep these names in scope for the doc links above; an import that only a
// doc comment uses is dropped from them.
//# sourceMappingURL=shred_columns.js.map