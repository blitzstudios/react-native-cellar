/** The interface between the stores and the platform's SQLite driver. */
import { ShredSpec } from '../write/shred_spec';
/**
 * What a driver returns for one statement. Reading rows should go through {@linkcode readRows}, which unwraps the rows
 * and calls {@linkcode QueryExecResult.dispose | dispose}.
 */
export interface QueryExecResult {
    /** The result rows. */
    rows?: {
        /** The rows, as objects keyed by column. */
        _array?: unknown[];
    };
    /** Frees the result's native memory. */
    dispose?: () => void;
}
/**
 * A SQLite database handle, as Cellar uses it; a driver adapter implements this. Only
 * {@linkcode SqliteConnection.execute | execute} is required: each optional method is a faster path Cellar falls
 * back from when it's missing.
 */
export interface SqliteConnection {
    /** Runs one statement synchronously. */
    execute(sql: string, params?: ReadonlyArray<string | number | null>): QueryExecResult;
    /** Runs several statements in one transaction, synchronously. */
    executeBatch?(commands: ReadonlyArray<[string, ReadonlyArray<string | number | null>]>): void;
    /** Runs one statement off the JS thread. */
    executeAsync?(sql: string, params?: ReadonlyArray<string | number | null>): Promise<QueryExecResult>;
    /** Runs several statements in one transaction, off the JS thread. */
    executeBatchAsync?(commands: ReadonlyArray<[string, ReadonlyArray<string | number | null>]>): Promise<void>;
    /**
     * Parses a JSON response and writes its rows with a native shred program, off the JS thread; resolves to the number
     * of rows written.
     */
    shredJsonArrayAsync?(spec: ShredSpec, rawJson: string, binds: ReadonlyArray<string | number | null>): Promise<number>;
    /** A second, read-only handle to the same database, so reads can run while a write holds the main one. */
    reader?: PinnedConnection;
}
/** A connection with no separate reader, so every statement runs on this one handle and sees its `TEMP` tables. */
export type PinnedConnection = SqliteConnection & {
    /** Always absent. */
    readonly reader?: undefined;
};
/** The one handle to run reads on: the connection's reader if it has one, otherwise the connection itself. */
export declare function pinnedReader(conn: SqliteConnection): PinnedConnection;
/** One SQL statement and its parameters, as {@linkcode runBatch} takes them. */
export type BatchCommand = [string, ReadonlyArray<string | number | null>];
/**
 * Runs `commands` as one transaction, which is what makes a delete-then-insert replacement all-or-nothing. It holds
 * the JS thread for the length of the write, so anything ingest-sized wants {@linkcode runBatchAsync} instead.
 */
export declare function runBatch(conn: SqliteConnection, commands: ReadonlyArray<BatchCommand>): void;
/**
 * The same transaction handed to the driver's async batch, for a write big enough to drop a frame — an ingest's insert
 * chunks. A driver without one runs it synchronously, so awaiting this is not on its own a promise that JS yielded.
 */
export declare function runBatchAsync(conn: SqliteConnection, commands: ReadonlyArray<BatchCommand>): Promise<void>;
/** Wraps `conn` so every statement returns: the first failure calls `onFatal`, and later calls answer empty. */
export declare function guardedConnection(conn: SqliteConnection, onFatal: (error: unknown, op: string) => void, onContended?: (error: unknown, op: string) => void): SqliteConnection;
/**
 * Runs a `SELECT` and returns its rows as plain objects. It runs on the connection's reader if it has one, so a query
 * of a `TEMP` table the caller just created must be passed a {@linkcode PinnedConnection}.
 */
export declare function readRows<T>(conn: SqliteConnection, sql: string, params?: ReadonlyArray<string | number | null>): T[];
/**
 * Runs a `SELECT` over `values` in as many statements as it takes, and returns every row, in the order the statements
 * ran. `sql` is handed the placeholders for one chunk, such as `?, ?, ?`, to put inside its `IN (…)`; `before` binds
 * ahead of them and `after` behind. A chunk holds `chunk` values, or as many as SQLite's bind limit leaves room for
 * when that's fewer. A smaller `chunk` keeps each native result small when rows are wide.
 */
export declare function readRowsIn<T>(conn: SqliteConnection, sql: (placeholders: string) => string, values: ReadonlyArray<string | number>, opts?: {
    before?: ReadonlyArray<string | number | null>;
    after?: ReadonlyArray<string | number | null>;
    chunk?: number;
}): T[];
//# sourceMappingURL=connection.d.ts.map