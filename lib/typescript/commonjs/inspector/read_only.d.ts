/**
 * Keeps a query typed into a development tool from changing the database it inspects. The query runs on the app's own
 * connection, where a write would land under the store's feet, and where a pragma that sets something would change how
 * the store's own statements behave, so only statements that read are let through.
 */
import type { SqliteConnection } from '../table/connection';
/** One statement, with its comments and trailing semicolons gone, and its leading keyword. */
export interface ReadStatement {
    /** The statement's text. */
    sql: string;
    /** The statement's first keyword, upper-cased: `SELECT`, `WITH`, `VALUES`, `EXPLAIN` or `PRAGMA`. */
    verb: string;
}
/** Thrown for a statement the inspector won't run, with a message saying why. */
export declare class ReadOnlyViolation extends Error {
    constructor(message: string);
}
/**
 * Parses `sql` as the one statement the inspector will run, throwing a {@linkcode ReadOnlyViolation} for more than one
 * statement, for a statement that isn't a read, and for a pragma that sets something.
 */
export declare function parseReadStatement(sql: string): ReadStatement;
/**
 * Throws a {@linkcode ReadOnlyViolation} if the statement would open a write transaction, as `WITH … DELETE` does.
 * Asks SQLite rather than reading the text: the statement's compiled program opens its transaction with
 * `Transaction p2 ≠ 0` exactly when it writes, to any database, `TEMP` included. `EXPLAIN` and `PRAGMA` need no check,
 * since an `EXPLAIN` only compiles its statement and {@linkcode parseReadStatement} has already vetted the pragma.
 */
export declare function assertCompilesToRead(conn: SqliteConnection, statement: ReadStatement, params: ReadonlyArray<string | number | null>): void;
/** Whether the statement is one whose rows can be wrapped in `SELECT * FROM (…) LIMIT n`. */
export declare function isWrappable(statement: ReadStatement): boolean;
//# sourceMappingURL=read_only.d.ts.map