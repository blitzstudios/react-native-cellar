/**
 * The {@linkcode SqliteConnection} for web, over sql.js (SQLite compiled to WebAssembly). Each store's database is held
 * in memory for the life of the page. The app loads sql.js and passes the module in, and device builds never import
 * this.
 */
import type { BindOptions } from '../define_sqlite_store';
import type { SqliteConnection } from '../table/connection';
/** The parts of a sql.js prepared statement used here. */
interface SqlJsStatement {
    /** Sets the statement's parameters. */
    bind(params: Array<string | number | null>): void;
    /** Moves to the next result row, returning false when there are none left. */
    step(): boolean;
    /** The current row, as an object keyed by column. */
    getAsObject(): unknown;
    /** Frees the statement. */
    free(): void;
}
/** The parts of a sql.js database used here. */
interface SqlJsDatabase {
    /** Compiles a statement. */
    prepare(sql: string): SqlJsStatement;
}
/** The sql.js module, as `initSqlJs()` resolves it. */
export interface SqlJsModule {
    /** Creates a new in-memory database. */
    Database: new () => SqlJsDatabase;
}
/** A store, as far as binding it needs. */
interface BindableStore {
    /** Moves the store onto a connection. */
    bindSqlite: (conn: SqliteConnection, options?: BindOptions) => void;
}
/**
 * Opens a new in-memory sql.js database as a {@linkcode SqliteConnection}. sql.js is synchronous, so the async methods
 * wrap the sync ones.
 */
export declare function openSqlJsConnection(SQL: SqlJsModule): SqliteConnection;
/**
 * Binds `store` to a new sql.js database of its own. A failure is reported, not thrown, and the store's reads stay
 * empty.
 */
export declare function bindSqlJsStore(label: string, SQL: SqlJsModule, store: BindableStore): void;
export type { SqliteConnection };
//# sourceMappingURL=sqljs_connection.d.ts.map