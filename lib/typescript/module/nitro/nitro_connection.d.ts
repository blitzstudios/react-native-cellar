/**
 * The {@linkcode SqliteConnection} for devices, over `react-native-nitro-sqlite`. It opens a store's database file,
 * sets the pragmas stores rely on, and passes native shreds to our fork's C++. A store whose file won't open is
 * reported rather than throwing, and runs on an in-memory database instead.
 */
import { readRows, SqliteConnection } from '../index';
import type { BindOptions } from '../define_sqlite_store';
/** Every database connection this module has open, by name, such as for a dev tool that dumps them. */
export declare function getOpenSqliteConnections(): Array<{
    /** The database's name. */
    name: string;
    /** Its connection. */
    conn: SqliteConnection;
}>;
/** Closes a database's connection and its reader, ignoring a handle that won't close. */
export declare function closeNitroConnection(name: string): void;
/** Options for {@linkcode openNitroConnection}. */
export interface NitroConnectionOptions {
    /**
     * Also opens a second, read-only handle to the same database file, and runs reads on it, so a read doesn't wait for
     * a write in progress on the main handle (such as a large fetch being written).
     */
    dedicatedReader?: boolean;
    /**
     * Builds rows in JS instead of with the native JSON shredder. For a remote switch, since a response the native
     * shredder mishandles can't be fixed any other way.
     */
    shredInJs?: boolean;
}
/**
 * Opens a database file on the device as a {@linkcode SqliteConnection}, closing any connection already open under
 * `name`.
 */
export declare function openNitroConnection(name: string, opts?: NitroConnectionOptions): SqliteConnection;
/** A store, as far as binding it needs. */
interface BindableStore {
    /** Moves the store onto a connection. */
    bindSqlite: (conn: SqliteConnection, options?: BindOptions) => void;
}
/**
 * Opens the in-memory database a store falls back to, where its `TEMP` tables hold the store's rows: the private one
 * nitro opens for `:memory:<dbName>`, which needs no file. It has no separate reader, since `TEMP` tables are visible
 * only to their own connection.
 */
export declare function openNitroMemoryFallback(dbName: string, opts?: Pick<NitroConnectionOptions, 'shredInJs'>): SqliteConnection;
/** Options for {@linkcode bindSqliteStore}. */
export interface BindSqliteStoreOptions extends NitroConnectionOptions {
    /** Runs the store on an in-memory database without opening its file, as a kill switch. */
    inMemory?: boolean;
}
/**
 * Opens the database file `dbName` and binds `store` to it, at app startup; `label` names the store in reports. If the
 * file won't open, it is deleted and opened again from empty, since it only caches server data. If that fails too, the
 * store runs on an in-memory database until {@linkcode retrySqliteStores} gets it back on the file. A failure later in
 * the session reopens the database, and otherwise moves the store to the in-memory database.
 */
export declare function bindSqliteStore(label: string, dbName: string, store: BindableStore, opts?: BindSqliteStoreOptions): void;
/**
 * Tries to move every store running off its database file back onto it, up to 3 times per database. Call it when the
 * app returns to the foreground: a launch in the background before the device's first unlock can't open files, which
 * later works.
 */
export declare function retrySqliteStores(): void;
export type { SqliteConnection, readRows };
//# sourceMappingURL=nitro_connection.d.ts.map