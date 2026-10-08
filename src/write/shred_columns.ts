/**
 * A table's columns, declared once as a list and turned into everything else that has to agree with them. A store
 * needs its columns in three places: the table's schema (names and SQLite types), the JS row builder (how each value is
 * computed from a response element), and the native shred spec (the same computation, as an op the C++ shredder
 * runs). Declaring each column once, with all three, keeps them from drifting apart.
 */

import { ColumnDef, ColumnType, SqlValue } from '../table/types';
import { evalShredOp, ShredOp } from './shred_spec';
import type { RowTableSchema } from '../table/types';
import type { PartitionFetch } from '../define_partitions';
import type { ShredSpec } from './shred_spec';

/**
 * The ops a column can declare without a {@linkcode ShredColumn.js | js} builder: every op that reads only the element.
 * `bind`, and a `coalesceText` that falls back to a bind, read a value only the native write is handed.
 */
export type ElementShredOp =
  | Exclude<ShredOp, { op: 'bind' } | { op: 'coalesceText' }>
  | (Extract<ShredOp, { op: 'coalesceText' }> & { fallbackBindIndex?: undefined });

/** What every column declares, however its value is computed. */
interface ShredColumnBase {
  /** The column's name in the SQLite table, and the field's name on the row object. */
  name: string;
  /**
   * The column's SQLite type: `TEXT` for strings and JSON, `INTEGER` for whole numbers and booleans (0 or 1), `REAL`
   * for other numbers.
   */
  type: ColumnType;
  /**
   * Declares the column `NOT NULL`, so SQLite rejects any write of a row that leaves it null, and the write fails. The
   * same check runs in tests, so a row builder that misses the column fails in a test the way it would on a device.
   */
  notNull?: boolean;
  /**
   * How {@linkcode ShredColumnsBase.decode | decode} reads this column's stored value back, where the op's own reading
   * is not what a caller wants: a JSON array validated into a list of strings, say. It is handed the value as stored,
   * `null` included, and a `null` it returns reads as the caller's absent value.
   */
  decode?(stored: SqlValue): unknown;
}

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
export type ShredColumn<Src, Ctx = void> =
  | (ShredColumnBase & {
      /**
       * Computes this column's value for one element of a response body, in JS. `src` is the element (such as one
       * player), and `ctx` is whatever the store passes for the whole write (such as the league being fetched). The
       * returned value is what's stored.
       *
       * Rows are built in JS on web, in tests, and on a device whenever the native shredder can't be used. The
       * TypeScript row type comes from the return type, so the builder should declare one.
       */
      js: (src: Src, ctx: Ctx) => SqlValue;
      /**
       * The builder's computation as an instruction for the native C++ shredder, which can't run JS. An op names one
       * of a fixed set of extractions and where in the element to read from: `{ op: 'text', path: 'team' }` stores
       * `element.team` if it's a string, and null otherwise.
       *
       * It must produce exactly what {@linkcode ShredColumn.js | js} returns for the same element, including when a
       * field is missing. Only needed for a store that shreds natively; the native ops
       * ({@linkcode NativeShredColumns.namedOps | namedOps}, {@linkcode NativeShredColumns.ops | ops}) exist only
       * when every column has one.
       */
      op?: ShredOp;
    })
  | (ShredColumnBase & {
      js?: undefined;
      /**
       * How this column's value is read from one element, run by the native C++ shredder and, in JS, by the row
       * builder: `{ op: 'text', path: 'team' }` stores `element.team` if it's a string, and null otherwise. The row
       * type comes from the op: `text` is `string | null`, `real0` is `number`.
       */
      op: ElementShredOp;
    });

/**
 * The type a column resolves to when its {@linkcode ShredColumn.js | js} builder returns `any`, which would switch off
 * checking for it.
 */
type AnnotateTheBuilder = 'this column`s js builder returns any: give it an explicit return type';

/** What an op stores, as the row type spells it. */
type OpValue<Op> = Op extends { op: 'text' | 'metaText' | 'rawJsonField' | 'rawJson' }
  ? string | null
  : Op extends { op: 'int' | 'real' }
    ? number | null
    : Op extends { op: 'real0' }
      ? number
      : Op extends { op: 'boolInt' }
        ? 0 | 1 | null
        : Op extends { op: 'concat' }
          ? string
          : Op extends { op: 'coalesceText'; emptyDefault: true }
            ? string
            : Op extends { op: 'coalesceText' }
              ? string | null
              : SqlValue;

/** A column's field type: its builder's return type, or for a column without one, what its op stores. */
type ColumnValue<Column> = Column extends { js: (...args: never[]) => infer Value }
  ? 0 extends 1 & Value
    ? AnnotateTheBuilder
    : Value
  : Column extends { op: infer Op }
    ? OpValue<Op>
    : never;

/**
 * The TypeScript type of one row built from a column list: an object with one field per column, named by the column's
 * {@linkcode ShredColumn.name | name} and typed by what its {@linkcode ShredColumn.js | js} function returns, or for a
 * column without one, by what its {@linkcode ShredColumn.op | op} stores. A column whose
 * {@linkcode ShredColumn.js | js} returns `any` gets an error string as its type instead, so the missing return type
 * gets noticed.
 */
export type RowOf<Columns extends readonly ShredColumn<never, never>[]> = {
  [Column in Columns[number] as Column['name']]: ColumnValue<Column>;
};

/** A stored value with its `null` read as `Absent` instead. */
type ReadAs<Value, Absent> = null extends Value ? Exclude<Value, null> | Absent : Value;

/** What {@linkcode ShredColumnsBase.decode | decode} reads a column back as, given what a NULL reads as. */
type DecodedValue<Column, Absent> = Column extends { decode(stored: never): infer Value }
  ? ReadAs<Value, Absent>
  : Column extends { op: { op: 'boolInt' } }
    ? boolean | Absent
    : Column extends { op: { op: 'rawJsonField' } }
      ? unknown
      : ReadAs<ColumnValue<Column>, Absent>;

/**
 * The named columns of a row as {@linkcode ShredColumnsBase.decode | decode} reads them back: each typed by what its op
 * stores, a `boolInt` as a boolean, a column with its own {@linkcode ShredColumn.decode | decode} by what that
 * returns, and a NULL as `Absent`.
 */
export type DecodedRow<Columns extends readonly ShredColumn<never, never>[], Names extends Columns[number]['name'], Absent = undefined> = {
  [Column in Columns[number] as Column['name'] extends Names ? Column['name'] : never]: DecodedValue<Column, Absent>;
};

/** The `RowTableSchema['columns']` map a column table describes. */
type ColumnDefsOf<Columns extends readonly ShredColumn<never, never>[]> = {
  [Column in Columns[number] as Column['name']]: ColumnDef;
};

/**
 * What {@linkcode defineShredColumns} generates from a column list, whether or not every column has an
 * {@linkcode ShredColumn.op | op}.
 */
export interface ShredColumnsBase<Columns extends readonly ShredColumn<never, never>[], Src, Ctx> {
  /** The column list as it was declared, for building a native shred spec from these columns plus others. */
  columns: Columns;
  /**
   * The column names, in declared order. Use it as a native shred spec's
   * {@linkcode ShredColumnsBase.columns | columns}, alongside {@linkcode NativeShredColumns.ops | ops}, which comes
   * from the same list in the same order, so `ops[i]` always computes `names[i]`.
   */
  names: string[];
  /**
   * The columns' SQLite declarations (type, and `NOT NULL` where set), as a map by name: the
   * {@linkcode ShredColumnsBase.columns | columns} of the table's {@linkcode RowTableSchema}. The table's columns then
   * come from the same list as the row builder and the shred spec.
   */
  columnDefs: ColumnDefsOf<Columns>;
  /**
   * Builds one table row from one element of a response body, in JS: runs every column's
   * {@linkcode ShredColumn.js | js} function on the element and `ctx`, or for a column without one its
   * {@linkcode ShredColumn.op | op}, and returns an object with each column's value. A column the element leaves
   * absent is `undefined`, and a write keeps the stored value for it.
   * A store's {@linkcode PartitionFetch.toRows | toRows} uses it for every element, which is how rows are built on
   * web, in tests, and on a device when the native shred can't run.
   */
  row: (src: Src, ctx: Ctx) => RowOf<Columns>;
  /**
   * Reads the named columns of a stored row back into JS values, which is most of what building a view model from a
   * row is: each column as its {@linkcode ShredColumn.op | op} stores it, except that a `boolInt` reads as a boolean, a
   * `rawJsonField` is parsed, and a column that declares its own {@linkcode ShredColumn.decode | decode} reads through
   * it. A NULL reads as `options.absent`, which is `undefined` unless the caller says `null`, and so does JSON that does
   * not parse.
   *
   * ```ts
   * const vm = { ...itemShred.decode(row, ['item_id', 'name', 'rank']), label: row.name ?? 'Unnamed' };
   * ```
   */
  decode<Names extends Columns[number]['name'], Absent extends null | undefined = undefined>(
    row: { readonly [Name in Names]?: SqlValue },
    names: readonly Names[],
    options?: { absent: Absent },
  ): DecodedRow<Columns, Names, Absent>;
}

/**
 * The parts of a native shred spec generated from a column list; present only when every column has an
 * {@linkcode ShredColumn.op | op}.
 */
export interface NativeShredColumns {
  /**
   * Each column's name and op, in declared order. Use it to build a spec from these columns plus others, then split
   * the combined list into the spec's {@linkcode ShredSpec.columns | columns} and
   * {@linkcode NativeShredColumns.ops | ops}.
   */
  namedOps: { name: string; op: ShredOp }[];
  /**
   * Each column's op, in declared order: a native shred spec's {@linkcode NativeShredColumns.ops | ops}, used with
   * {@linkcode ShredColumnsBase.names | names} as its {@linkcode ShredSpec.columns | columns}, so `ops[i]` computes
   * `names[i]`.
   */
  ops: ShredOp[];
}

/**
 * Whether every column carries an {@linkcode ShredColumn.op | op}. A table one column short of a native shred cannot
 * produce a bind order that matches its columns, so it offers neither member rather than throwing when something
 * reaches for one — which means a store whose payload is small enough to shred in JS never declares an
 * {@linkcode ShredColumn.op | op} it has no use for.
 */
type EveryColumnShreds<Columns extends readonly ShredColumn<never, never>[]> = Columns[number] extends { op: ShredOp } ? true : false;

/**
 * Everything {@linkcode defineShredColumns} generates from one column list: the table's column declarations
 * ({@linkcode ShredColumnsBase.columnDefs | columnDefs}), the column names
 * ({@linkcode ShredColumnsBase.names | names}), the JS row builder ({@linkcode ShredColumnsBase.row | row}), and, when
 * every column has an {@linkcode ShredColumn.op | op}, the ops for a native shred spec
 * ({@linkcode NativeShredColumns.ops | ops}, {@linkcode NativeShredColumns.namedOps | namedOps}).
 */
export type ShredColumns<Columns extends readonly ShredColumn<never, never>[], Src, Ctx> = ShredColumnsBase<Columns, Src, Ctx> &
  (EveryColumnShreds<Columns> extends true ? NativeShredColumns : unknown);

const NO_BINDS: readonly SqlValue[] = [];

/**
 * The value one column computes for one element, in JS: its {@linkcode ShredColumn.js | js} builder's, or for a column
 * without one, its {@linkcode ShredColumn.op | op}'s, run as the native shredder runs it. For building part of a row,
 * when some column's value is already to hand; {@linkcode ShredColumnsBase.row | row} builds all of them.
 */
export function shredColumnValue<Src, Ctx>(column: ShredColumn<Src, Ctx>, src: Src, ctx: Ctx): SqlValue | undefined {
  return column.js ? column.js(src, ctx) : evalShredOp(column.op, src, NO_BINDS);
}

type Decoder = (stored: SqlValue) => unknown;

const AS_STORED: Decoder = (stored) => stored;
const AS_FLAG: Decoder = (stored) => (stored == null ? null : stored === 1);
const AS_JSON: Decoder = (stored) => {
  if (typeof stored !== 'string') return null;
  try {
    return JSON.parse(stored) as unknown;
  } catch {
    return null;
  }
};

/** How `decode` reads one column back: through the column's own `decode`, or as its op says what it stored. */
function decoderOf(column: ShredColumn<never, never>): Decoder {
  if (column.decode) return (stored) => column.decode!(stored);
  if (column.op?.op === 'boolInt') return AS_FLAG;
  if (column.op?.op === 'rawJsonField') return AS_JSON;
  return AS_STORED;
}

/** Whether an op reads only the element, so the JS row builder can run it without the native write's binds. */
function readsOnlyTheElement(op: ShredOp | undefined): boolean {
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
export function defineShredColumns<Src, Ctx = void>() {
  return <const Columns extends readonly ShredColumn<Src, Ctx>[]>(columns: Columns): ShredColumns<Columns, Src, Ctx> => {
    const defs: Record<string, ColumnDef> = {};
    const decoders: Record<string, Decoder> = {};
    for (const column of columns) {
      defs[column.name] = column.notNull ? { type: column.type, notNull: true } : { type: column.type };
      decoders[column.name] = decoderOf(column as ShredColumn<never, never>);
      // Unreachable from TypeScript, which requires a builder unless the op reads only the element; this catches a JS caller.
      if (!column.js && !readsOnlyTheElement(column.op)) {
        throw new Error(`shred_columns: column ${JSON.stringify(column.name)} needs a js builder: its op reads a value only the native write has`);
      }
    }

    // Derived on first read and kept: the ops are the expensive pair, and a spec built per category asks for them
    // again.
    let named: { name: string; op: ShredOp }[] | undefined;
    const namedOps = (): { name: string; op: ShredOp }[] =>
      (named ??= columns.map((column) => {
        // Unreachable from TypeScript, which withholds both members from a table missing one; this catches a JS caller.
        if (!column.op) throw new Error(`shred_columns: column ${JSON.stringify(column.name)} has no native-shred op`);
        return { name: column.name, op: column.op };
      }));

    return {
      columns,
      names: columns.map((column) => column.name),
      columnDefs: defs as ColumnDefsOf<Columns>,
      get namedOps() {
        return namedOps();
      },
      get ops() {
        return namedOps().map((column) => column.op);
      },
      row: (src, ctx) => {
        const row: Record<string, SqlValue | undefined> = {};
        for (const column of columns) row[column.name] = shredColumnValue(column, src, ctx);
        return row as RowOf<Columns>;
      },
      decode: ((row: Readonly<Record<string, SqlValue | undefined>>, names: readonly string[], options?: { absent: null | undefined }) => {
        const absent = options ? options.absent : undefined;
        const out: Record<string, unknown> = {};
        for (const name of names) {
          // Unreachable from TypeScript, which types `names` by the table's columns; this catches a JS caller.
          const decoder = decoders[name];
          if (!decoder) throw new Error(`shred_columns: ${JSON.stringify(name)} is not a column of this table`);
          const value = decoder(row[name] ?? null);
          out[name] = value == null ? absent : value;
        }
        return out;
      }) as ShredColumnsBase<Columns, Src, Ctx>['decode'],
    } as ShredColumns<Columns, Src, Ctx>;
  };
}

// Exported so the built declaration files keep these names in scope for the doc links above; an import that only a
// doc comment uses is dropped from them.
export type { PartitionFetch, RowTableSchema, ShredSpec };
