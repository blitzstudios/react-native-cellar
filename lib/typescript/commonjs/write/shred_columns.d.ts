/**
 * A table's columns, declared once as a list and turned into everything else that has to agree with them. A store
 * needs its columns in three places: the table's schema (names and SQLite types), the JS row builder (how each value is
 * computed from a response element), and the native shred program (the same computation, as an op the C++ shredder
 * runs). Declaring each column once, with all three, keeps them from drifting apart.
 */
import { ColumnDef, ColumnType, SqlValue } from '../table/types';
import { ShredOp } from './shred_spec';
import type { RowTableSchema } from '../table/types';
import type { PartitionFetchSpec } from '../define_partitions';
import type { ShredSpec } from './shred_spec';
/**
 * One column of a store's table, declared with everything needed to fill it: its name and SQLite type, and how to
 * compute its value from one element of a response body, both in JS ({@linkcode ShredColumn.js | js}) and for the
 * native C++ shredder ({@linkcode ShredColumn.op | op}). An element is one item of the response: one player in a
 * players response, one stat line in a stats response.
 */
export interface ShredColumn<Src, Ctx = void> {
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
     * Computes this column's value for one element of a response body, in JS. `src` is the element (such as one
     * player), and `ctx` is whatever the store passes for the whole write (such as the league being fetched). The
     * returned value is what's stored.
     *
     * Rows are built with these functions on web, in tests, and on a device whenever the native shredder can't be used.
     * The TypeScript row type comes from their return types, so each should declare one.
     */
    js: (src: Src, ctx: Ctx) => SqlValue;
    /**
     * The same computation as {@linkcode ShredColumn.js | js}, written as an instruction for the native C++ shredder,
     * which can't run JS. An op names one of a fixed set of extractions and where in the element to read from: `{ op:
     * 'text', path: 'team' }` stores `element.team` if it's a string, and null otherwise. The shredder runs every
     * column's op on every element to build each row without creating JS objects.
     *
     * It must produce exactly what {@linkcode ShredColumn.js | js} returns for the same element, including when a field
     * is missing; a parity test runs both on sample elements. Only needed for a store that shreds natively; the native
     * ops ({@linkcode NativeShredColumns.namedOps | namedOps}, {@linkcode NativeShredColumns.ops | ops}) exist only when
     * every column has one.
     */
    op?: ShredOp;
}
/**
 * The type a column resolves to when its {@linkcode ShredColumn.js | js} builder returns `any`, which would switch off
 * checking for it.
 */
type AnnotateTheBuilder = 'this column`s js builder returns any: give it an explicit return type';
/**
 * The TypeScript type of one row built from a column list: an object with one field per column, named by the column's
 * {@linkcode ShredColumn.name | name} and typed by what its {@linkcode ShredColumn.js | js} function returns. A column
 * whose {@linkcode ShredColumn.js | js} returns `any` gets an error string as its type instead, so the missing return
 * type gets noticed.
 */
export type RowOf<Columns extends readonly ShredColumn<never, never>[]> = {
    [Column in Columns[number] as Column['name']]: 0 extends 1 & ReturnType<Column['js']> ? AnnotateTheBuilder : ReturnType<Column['js']>;
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
    /** The column list as it was declared, for building a native shred program from these columns plus others. */
    columns: Columns;
    /**
     * The column names, in declared order. Use it as a native shred program's
     * {@linkcode ShredColumnsBase.columns | columns}, alongside {@linkcode NativeShredColumns.ops | ops}, which comes
     * from the same list in the same order, so `ops[i]` always computes `names[i]`.
     */
    names: string[];
    /**
     * The columns' SQLite declarations (type, and `NOT NULL` where set), as a map by name: the
     * {@linkcode ShredColumnsBase.columns | columns} of the table's {@linkcode RowTableSchema}. The table's columns then
     * come from the same list as the row builder and the shred program.
     */
    columnDefs: ColumnDefsOf<Columns>;
    /**
     * Builds one table row from one element of a response body, in JS: runs every column's
     * {@linkcode ShredColumn.js | js} function on the element and `ctx`, and returns an object with each column's value.
     * A store's {@linkcode PartitionFetchSpec.toRows | toRows} uses it for every element, which is how rows are built on
     * web, in tests, and on a device when the native shred can't run.
     */
    row: (src: Src, ctx: Ctx) => RowOf<Columns>;
}
/**
 * The parts of a native shred program generated from a column list; present only when every column has an
 * {@linkcode ShredColumn.op | op}.
 */
export interface NativeShredColumns {
    /**
     * Each column's name and op, in declared order. Use it to build a program from these columns plus others, then split
     * the combined list into the program's {@linkcode ShredSpec.columns | columns} and
     * {@linkcode NativeShredColumns.ops | ops}.
     */
    namedOps: {
        name: string;
        op: ShredOp;
    }[];
    /**
     * Each column's op, in declared order: a native shred program's {@linkcode NativeShredColumns.ops | ops}, used with
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
type EveryColumnShreds<Columns extends readonly ShredColumn<never, never>[]> = Columns[number] extends {
    op: ShredOp;
} ? true : false;
/**
 * Everything {@linkcode defineShredColumns} generates from one column list: the table's column declarations
 * ({@linkcode ShredColumnsBase.columnDefs | columnDefs}), the column names
 * ({@linkcode ShredColumnsBase.names | names}), the JS row builder ({@linkcode ShredColumnsBase.row | row}), and, when
 * every column has an {@linkcode ShredColumn.op | op}, the ops for a native shred program
 * ({@linkcode NativeShredColumns.ops | ops}, {@linkcode NativeShredColumns.namedOps | namedOps}).
 */
export type ShredColumns<Columns extends readonly ShredColumn<never, never>[], Src, Ctx> = ShredColumnsBase<Columns, Src, Ctx> & (EveryColumnShreds<Columns> extends true ? NativeShredColumns : unknown);
/**
 * Generates everything that has to agree with a table's columns from one list of {@linkcode ShredColumn}s: the schema's
 * column declarations, the JS row builder, and the native shred program's names and ops. Call it with the element type
 * (one item of the response) and the context type (what the store passes per write) first, then the column list:
 *
 * ```ts
 * const itemShred = defineShredColumns<Item, ItemShredCtx>()(ITEM_SHRED_COLUMNS);
 * ```
 */
export declare function defineShredColumns<Src, Ctx = void>(): <const Columns extends readonly ShredColumn<Src, Ctx>[]>(columns: Columns) => ShredColumns<Columns, Src, Ctx>;
export type { PartitionFetchSpec, RowTableSchema, ShredSpec };
//# sourceMappingURL=shred_columns.d.ts.map