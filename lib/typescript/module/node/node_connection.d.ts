/**
 * The {@linkcode SqliteConnection} for Node, over `node:sqlite`, for a server that renders a store's reads. A worker
 * thread ({@linkcode ./writer}) holds the database for writing, so a fetched body is parsed and written off the thread
 * that renders; the main thread reads through a connection of its own to the same file, which WAL lets run alongside a
 * write.
 */
import type { BindOptions } from '../define_sqlite_store';
import type { SqliteConnection } from '../table/connection';
export interface NodeConnectionOptions {
    /** The database file. A new file in the OS temp directory by default; whatever is at the path is deleted first. */
    path?: string;
    /** The writer's script, for a build that moves it; `writer.js` beside this module by default. */
    writerFile?: string;
}
/** A connection over `node:sqlite`, with the means to shut its writer down. */
export interface NodeConnection extends SqliteConnection {
    /** The database file. */
    readonly path: string;
    /** Stops the writer and closes both handles. Statements after this throw. */
    close: () => Promise<void>;
}
/**
 * Opens a database for one store: its writer thread, and the main thread's reader over the same file. Blocks until the
 * writer has opened the file, which is at startup, when a store binds.
 */
export declare function openNodeConnection(options?: NodeConnectionOptions): NodeConnection;
/** A store, as far as binding it needs. */
interface BindableStore {
    bindSqlite: (conn: SqliteConnection, options?: BindOptions) => void;
}
/**
 * Binds `store` to a database of its own on this machine, written by a worker thread. A failure is reported, not
 * thrown, and the store's reads stay empty.
 */
export declare function bindNodeStore(label: string, store: BindableStore, options?: NodeConnectionOptions): NodeConnection | undefined;
export type { SqliteConnection };
//# sourceMappingURL=node_connection.d.ts.map