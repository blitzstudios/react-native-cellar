/**
 * The format of a native shred program. "Shredding" is turning a JSON response body into table rows. A store can do it
 * in JS (`JSON.parse` the body, then build each row with the columns' {@linkcode ShredColumn.js | js} functions), or
 * natively: our fork of `react-native-nitro-sqlite` has a C++ shredder that parses the body and inserts the rows
 * straight into SQLite, so no JS object is ever created for them. For a large body, such as every player in a sport,
 * that avoids building tens of thousands of short-lived objects on the JS heap, which is most of the time and memory a
 * JS ingest spends.
 *
 * The C++ shredder has no store code to run, so a store describes each row as data instead: a {@linkcode ShredSpec} per
 * table, listing each column and the {@linkcode ShredOp} that computes it from one element of the body. The functions
 * below ({@linkcode evalShredElement}, {@linkcode evalShredSpec}) run a program in JS exactly as the C++ does; a parity
 * test compares the two, so a new op has to be added on both sides.
 */
import { SqlValue } from '../table/types';
import type { ShredColumn, defineShredColumns } from './shred_columns';
import type { PartitionKeySpec } from '../define_partitions';
import type { SqliteStoreConfig, defineSqliteStore } from '../define_sqlite_store';
/**
 * One piece of a `concat` op's text. A `concat` op computes a column by reading several values from the element and
 * joining them with a separator, such as `sport`, `season` and `player_id` joined into one id; each piece is one of
 * those values.
 */
export interface ConcatPart {
    /**
     * Where to read this piece from: dot-separated paths into the element (`player.player_id` reads
     * `element.player.player_id`), tried in order. The first one whose value isn't null or missing is used, converted to
     * a string; if none has a value, the piece is the empty string.
     */
    paths: string[];
}
/**
 * An op: one column's instruction to the native shredder, saying how to compute that column's value from one element of
 * the response body. The C++ shredder reads the body, and for each element (each item of the JSON array, or each value
 * of the JSON object) runs every column's op to produce that row's value for the column.
 *
 * A path is dot-separated and starts at the element: `metadata.gender` reads `element.metadata.gender`. A value is
 * "missing" when the path leads nowhere or to `null`.
 *
 * Each column also has a {@linkcode ShredColumn.js | js} function, used when rows are built in JS (on web, in tests,
 * and whenever the native shred can't run). The op has to produce exactly what that function returns, including for a
 * missing field, so pick the op that matches: for example `real` and `real0` differ only in whether a missing value
 * becomes null or 0. A parity test runs both on the same elements.
 */
export type ShredOp = {
    /**
     * Uses a value supplied for the whole write rather than read from the element, the same for every row: the
     * `index`th value of the program's {@linkcode NativeShredSpec.binds | binds}. It fills the columns that say which
     * partition a row belongs to, such as `league` in a table of players fetched one league at a time, since the
     * elements themselves don't carry it.
     */
    op: 'bind';
    /**
     * Which of the write's bind values to use, counting from 0. The bind values are the list
     * {@linkcode NativeShredSpec.binds} returns for the partition being written.
     */
    index: number;
} | {
    /**
     * Reads a string: the value at `path` if it is a JSON string, otherwise null. A number or boolean at `path` also
     * gives null; use `metaText` to convert those to text instead.
     */
    op: 'text';
    /** Where to read the value: a dot-separated path starting at the element, such as `metadata.gender`. */
    path: string;
} | {
    /**
     * Reads a number: the value at `path` if it is a JSON number, stored as it is (not rounded), otherwise null. A
     * numeric string such as `"12"` also gives null; use `real` to convert strings.
     */
    op: 'int';
    /** Where to read the value: a dot-separated path starting at the element, such as `years_exp`. */
    path: string;
} | {
    /**
     * Reads a number, converting other values: the value at `path` converted as JS `Number()` does, so `12.5` and
     * `"12.5"` both give 12.5. Null if the value is missing or doesn't convert to a finite number.
     */
    op: 'real';
    /** Where to read the value: a dot-separated path starting at the element, such as `stats.pts_ppr`. */
    path: string;
} | {
    /**
     * Reads a flag as 1 or 0: 1 if the value at `path` is truthy (`true`, a non-zero number, a non-empty string), 0
     * if it is falsy, and null if it is missing. SQLite has no boolean type, so flags are stored this way.
     */
    op: 'boolInt';
    /** Where to read the value: a dot-separated path starting at the element, such as `active`. */
    path: string;
} | {
    /**
     * Reads any value as text: a string as it is, and a number or boolean converted to a string (`12` gives
     * `"12"`). Null if the value is missing. Use it for a field the server sends sometimes as a string and sometimes
     * as a number, such as an id.
     */
    op: 'metaText';
    /** Where to read the value: a dot-separated path starting at the element, such as `game_id`. */
    path: string;
} | {
    /**
     * Reads a number the way `real` does, but gives 0 instead of null when the value is missing or isn't a number.
     * For a stat where "not reported" means zero, so the column can be summed without null checks.
     */
    op: 'real0';
    /** Where to read the value: a dot-separated path starting at the element, such as `stats.rec`. */
    path: string;
} | {
    /**
     * Reads the first of several paths that has a value, as text. "Coalesce" means take the first non-null value, as
     * SQL's `COALESCE` does. The paths are tried in order, and the first whose value isn't null or missing is used,
     * converted to a string (a number `12` gives `"12"`). If none has a value, the column gets
     * `binds[fallbackBindIndex]` when that is set, otherwise `''` when `emptyDefault` is set, and otherwise null.
     *
     * For a field that isn't always in the same place: `paths: ['player_id', 'player.player_id']` reads the
     * element's own `player_id`, or the nested `player.player_id` when the element doesn't have one.
     */
    op: 'coalesceText';
    /** The places to look, in order: dot-separated paths starting at the element, such as `player.player_id`. */
    paths: string[];
    /**
     * When none of `paths` has a value, store `''` instead of null (unless `fallbackBindIndex` is set, which wins).
     * For a `NOT NULL` column.
     */
    emptyDefault?: boolean;
    /**
     * When none of `paths` has a value, store the `fallbackBindIndex`th value of the write's
     * {@linkcode NativeShredSpec.binds | binds} instead, such as the partition's league for a player that has no
     * `sport` of its own. Takes precedence over `emptyDefault`.
     */
    fallbackBindIndex?: number;
} | {
    /**
     * Builds text from several values: reads each part (the first of its paths that has a value, as a string, or `''`
     * if none does) and joins them in order with `sep` between them. For a column that has to combine fields, such as
     * a unique id made of a stat's sport, season, game and player: `"nfl_2025_123_4046"`.
     */
    op: 'concat';
    /** The values to join, in order; each is read from the first of its paths that has a value. */
    parts: ConcatPart[];
    /** The text placed between consecutive parts, such as `'_'`. */
    sep: string;
} | {
    /**
     * Stores the value at `path` as JSON text, whatever its type, so a list or object can live in a `TEXT` column:
     * `["QB","RB"]` stays `'["QB","RB"]'`. Null if the value is missing. The C++ copies the JSON as written in the
     * body, so its spacing can differ from JS's `JSON.stringify`, but both parse to the same value.
     */
    op: 'rawJsonField';
    /** Where to read the value: a dot-separated path starting at the element, such as `fantasy_positions`. */
    path: string;
};
/**
 * One condition of the `DELETE` a native shred runs before inserting its rows, which removes the partition's old rows
 * so the new ones replace them. It matches rows whose {@linkcode ShredDeleteClause.column | column} equals the write's
 * `binds[bindIndex]`. A program's conditions together must name exactly the columns of the partition's
 * {@linkcode PartitionKeySpec.where | where} (checked in dev), so the native and JS paths replace the same rows.
 */
export interface ShredDeleteClause {
    /** The column to match, such as `league`. */
    column: string;
    /**
     * Which of the write's bind values the column must equal, counting from 0. The bind values are the list
     * {@linkcode NativeShredSpec.binds} returns for the partition being written.
     */
    bindIndex: number;
}
/**
 * A native shred program for one table: everything the C++ shredder needs to turn a JSON response body into rows. For
 * each element of the body it skips the element if {@linkcode ShredSpec.whereGuard | whereGuard} says to, then computes
 * one row, filling `columns[i]` with the result of `ops[i]`. Before inserting, it deletes the partition's old rows
 * ({@linkcode ShredSpec.deleteWhere | deleteWhere}), so the body replaces the partition.
 *
 * Build {@linkcode ShredSpec.columns | columns} and {@linkcode ShredSpec.ops | ops} with {@linkcode defineShredColumns}
 * rather than by hand, so the two lists stay aligned with the table's columns and with the JS row builder.
 */
export interface ShredSpec {
    /** The version of the program format; always 1. */
    version: 1;
    /**
     * The table the rows are written to: the row table's name. When the partition already holds rows, Cellar points
     * the program at a staging table instead, so it can compare the new rows with the old ones before applying them.
     */
    table: string;
    /**
     * The verb of the `INSERT` statement each row is written with. Use `INSERT OR REPLACE` for a table with a primary
     * key: when two elements have the same key, the later one replaces the earlier, where plain `INSERT` would fail the
     * whole write. Use `INSERT` for a table without a primary key, which keeps every row, repeats included.
     */
    insertVerb: 'INSERT OR REPLACE' | 'INSERT';
    /** The columns to fill, in insert order; `ops[i]` computes `columns[i]`. */
    columns: string[];
    /**
     * How to compute each column from one element: `ops[i]` computes `columns[i]`, so the two lists have the same length.
     */
    ops: ShredOp[];
    /**
     * Where the elements are in the body. `array` (the default): the body is a JSON array, and each item is an element.
     * `objectValues`: the body is a JSON object, and each of its values is an element, as in a `{ [player_id]: Player }`
     * map.
     */
    source?: 'array' | 'objectValues';
    /**
     * The conditions of the `DELETE` run before inserting, which remove the partition's old rows: each matches rows whose
     * column equals one of the write's {@linkcode NativeShredSpec.binds | binds}. They must name exactly the columns of
     * the write's `where`. A store's spec leaves them out: {@linkcode defineSqliteStore} deletes by `partition_key`.
     */
    deleteWhere?: ShredDeleteClause[];
    /**
     * Skips elements that shouldn't become rows. It reads `paths` in order, as `coalesceText` does, and skips the
     * element when none of them has a value, or the first value found is an empty string. For a body that can include
     * placeholder entries, such as a player map with an entry that has no `player_id`.
     */
    whereGuard?: {
        /** The places to look, in order: dot-separated paths starting at the element, such as `player.player_id`. */
        paths: string[];
    };
}
/**
 * A store's native shred programs, passed to {@linkcode defineSqliteStore} as
 * {@linkcode SqliteStoreConfig.nativeShredSpec | nativeShredSpec}. With it, a partition fetch on a device writes the
 * body with the C++ shredder instead of `JSON.parse` and the JS row builders, so no JS object is built per row. Worth
 * it for a large body; a small one can skip it. Web and tests always use the JS path.
 *
 * A store can have several programs, one per variant, when different partitions need different columns (stats for
 * different sports fill different stat columns). For each write, {@linkcode NativeShredSpec.variant | variant} picks
 * the program and {@linkcode NativeShredSpec.binds | binds} supplies the values its `bind` ops and
 * {@linkcode ShredSpec.deleteWhere | deleteWhere} conditions use. When {@linkcode NativeShredSpec.variant | variant}
 * returns a name that isn't in {@linkcode NativeShredSpec.specs | specs}, or the native shred fails, that partition is
 * written through the JS path instead.
 */
export interface NativeShredSpec<Partition extends object = Readonly<Record<string, unknown>>> {
    /** The programs, by variant name, such as `{ all: {...} }` for a store with a single program. */
    specs: Readonly<Record<string, ShredSpec>>;
    /**
     * Picks the program for the partition being written, given its description (such as `{ sport: 'nfl' }`): returns a
     * key of {@linkcode NativeShredSpec.specs | specs}. A name not in {@linkcode NativeShredSpec.specs | specs} sends
     * that partition through the JS path.
     */
    variant: (partition: Partition) => string;
    /**
     * The values the program's `bind` ops refer to by index, given the partition's description. In a store, bind 0 is
     * the partition's key, which Cellar supplies, and these fill bind 1 onward: for `{ sport: 'nfl' }` this is typically
     * `['nfl']`, so a `bind` op with index 1 fills a row's `league` column. A spec with no `bind` ops of its own returns
     * `[]`.
     */
    binds: (partition: Partition) => SqlValue[];
}
/**
 * Runs a native shred program on one element of a response body, in JS, and returns the row the C++ shredder produces
 * for it: an object from each of the program's {@linkcode ShredSpec.columns | columns} to the value its op computes.
 * Returns `undefined` when the program's {@linkcode ShredSpec.whereGuard | whereGuard} skips the element. A store's
 * parity test compares this row with the one its {@linkcode ShredColumn.js | js} functions build, so the native and JS
 * paths are known to write the same rows.
 */
export declare function evalShredElement(spec: ShredSpec, element: unknown, binds: readonly SqlValue[]): Record<string, SqlValue> | undefined;
/**
 * Runs a native shred program on every element of a response body, in JS, and returns the rows the C++ shredder
 * produces, skipping the elements its {@linkcode ShredSpec.whereGuard | whereGuard} rejects. Pass the elements, not the
 * body: the parsed array, or `Object.values(body)` for an `objectValues` program.
 */
export declare function evalShredSpec(spec: ShredSpec, elements: readonly unknown[], binds: readonly SqlValue[]): Record<string, SqlValue>[];
export type { PartitionKeySpec, ShredColumn, SqliteStoreConfig, defineShredColumns, defineSqliteStore };
//# sourceMappingURL=shred_spec.d.ts.map