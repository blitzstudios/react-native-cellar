/** A {@linkcode SqliteConnection} over sql.js for Jest: real SQLite, though a different build from the device's. */
import { QueryExecResult, SqliteConnection } from '../table/connection';
/** Loads sql.js. Await it in `beforeAll` before creating a connection. */
export declare function initSqlJs(): Promise<void>;
/**
 * Which connection methods a test connection has: `minimal` has only {@linkcode SqliteConnection.execute | execute},
 * and `full` has every optional method.
 */
export type SqlJsCapabilities = 'minimal' | 'full';
/** How many times each connection method has been called. */
export interface SqlJsCallLog {
    execute: number;
    executeAsync: number;
    executeBatch: number;
    executeBatchAsync: number;
    shredJsonArrayAsync: number;
    /** Calls to the reader's {@linkcode SqliteConnection.execute | execute}. */
    readerExecute: number;
    /** Calls to a result's {@linkcode QueryExecResult.dispose | dispose}. */
    dispose: number;
}
/** A test connection, which also records what was called on it. */
export interface SqlJsConnection extends SqliteConnection {
    /** Closes the database. */
    close(): void;
    /** How many times each method has been called. */
    calls: SqlJsCallLog;
    /** Every SQL statement run, in order. */
    executed: string[];
}
/** Options for {@linkcode createSqlJsConnection}. */
export interface SqlJsConnectionOptions {
    /** Which optional methods the connection has; `minimal` by default. */
    capabilities?: SqlJsCapabilities;
    /** Makes a result's {@linkcode QueryExecResult.dispose | dispose()} clear its rows, like a driver that frees them. */
    poisonOnDispose?: boolean;
}
/** Creates a connection to a new in-memory sql.js database. Requires {@linkcode initSqlJs} to have finished. */
export declare function createSqlJsConnection(options?: SqlJsConnectionOptions): SqlJsConnection;
export type { QueryExecResult, SqliteConnection };
//# sourceMappingURL=sqljs_connection.d.ts.map