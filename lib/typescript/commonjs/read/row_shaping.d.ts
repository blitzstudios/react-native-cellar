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
import { FindOpts, RowShape, RowTable } from '../table/types';
import type { ReadDef } from './surface';
import type { byEntity } from './derived_values';
/** Columns whose value is always a string, so they can key a `Map` or `Record` directly. */
type StringColumn<Row> = {
    [K in keyof Row]-?: Row[K] extends string ? K : never;
}[keyof Row] & string;
/** The rows a query returned, with methods that turn them into a read's value. */
export interface RowSet<Row extends RowShape> {
    /** The rows as the query returned them, for a value none of the shapes covers. */
    readonly rows: readonly Row[];
    /**
     * Maps each row with `toVm` into a list, leaving out rows it returns a falsy value (such as `undefined`) for, in the
     * query's order (pass an {@linkcode FindOpts.orderBy | orderBy} to the query to sort). Returns `empty` when the list
     * would be empty.
     */
    map<T>(toVm: (row: Row) => T | undefined, empty: T[]): T[];
    /** The rows grouped by their value in `column`, as a map from value to rows, each group in the query's order. */
    groupBy(column: StringColumn<Row>): Map<string, Row[]>;
}
/**
 * The rows an {@linkcode RowReader.in | in} query returned (rows whose column is one of a list of values, such as some
 * player ids), with extra shapes that use that list.
 */
export interface IdRowSet<Row extends RowShape> extends RowSet<Row> {
    /**
     * A list with one entry per value the query was given, in that order (SQL `IN` returns rows in storage order
     * instead): the value's row mapped with `toVm` (the last row, if several share the value). A value with no row, or
     * whose row `toVm` returns a falsy value for, is left out. Returns `empty` when the list would be empty.
     */
    ordered<T>(toVm: (row: Row) => T | undefined, empty: T[]): T[];
    /**
     * Maps each row with `toVm` into a record keyed by its value in the query's column, leaving out rows `toVm` returns a
     * falsy value for. When two rows have the same value, the later one wins. Returns `empty` when the record would be
     * empty.
     */
    indexed<T>(toVm: (row: Row) => T | undefined, empty: Record<string, T>): Record<string, T>;
    /**
     * The rows grouped by their value in the query's column, as a map from value to rows, each group in the query's
     * order.
     */
    grouped(): Map<string, Row[]>;
}
/**
 * Queries one table and returns the rows with methods to shape them, as {@linkcode rowsOf} creates it. A read whose
 * {@linkcode ReadDef.select | select} uses it depends on the whole partition, since it reads the table directly.
 */
export interface RowReader<Row extends RowShape> {
    /**
     * The rows whose columns equal the values in `filter`, in storage order unless
     * {@linkcode FindOpts.orderBy | opts.orderBy} names a column to sort by.
     */
    where(filter: Partial<Row>, opts?: FindOpts<Row>): RowSet<Row>;
    /**
     * The rows whose columns equal the values in `filter` and whose `column` is one of `values`, such as the rows for a
     * list of player ids. The result can be put in the order of `values` ({@linkcode IdRowSet.ordered | ordered}) or
     * keyed by `column` ({@linkcode IdRowSet.indexed | indexed}).
     */
    in(filter: Partial<Row>, column: StringColumn<Row>, values: readonly string[]): IdRowSet<Row>;
    /** Wraps rows that came from somewhere else, such as a SQL query, so they have the same shape methods. */
    given(rows: readonly Row[]): RowSet<Row>;
}
/**
 * Creates a {@linkcode RowReader} for a table: query methods that return the rows with methods to shape them. A store's
 * read code uses it in place of the table's own {@linkcode RowTable.find | find} and
 * {@linkcode RowTable.findIn | findIn}.
 */
export declare function rowsOf<Row extends RowShape>(table: RowTable<Row>): RowReader<Row>;
export type { FindOpts, ReadDef, RowTable, byEntity };
//# sourceMappingURL=row_shaping.d.ts.map