/**
 * A copy of every store's database in one SQLite file, for a developer to open in a desktop SQLite browser. It needs
 * no file system library: nitro opens, attaches and deletes databases by name in its own directory, and SQLite says
 * where that is.
 */
/** A dump of the stores' databases. */
export interface SqliteDump {
    /** The dump's database name, in nitro's directory. */
    name: string;
    /** Its absolute path on the device; on a simulator, a path on the Mac running it. */
    path: string;
    /** Its size in bytes. */
    bytes: number;
    /** Each table copied, with the database it came from, and its row count. */
    tables: Array<{
        database: string;
        table: string;
        rows: number;
    }>;
}
/**
 * Copies the tables of every database a store runs on into one new database, `name` in nitro's directory (replacing
 * a dump already there under that name), and resolves with where it is and what it holds. A table keeps its name
 * unless an earlier database had one of the same name, when it takes its database's name as a prefix. Only the rows
 * are copied, not indexes or keys, and a store's table is copied as it reads, one row per partition holding it, with
 * `partition_key` first. Stores on the in-memory fallback aren't included: their rows are visible only to their own
 * connection.
 *
 * Each database is attached to the dump's own connection, so the copy reads a committed snapshot alongside the
 * store's writes rather than through the store's connection.
 */
export declare function dumpSqliteStores(options?: {
    name?: string;
}): Promise<SqliteDump>;
//# sourceMappingURL=dump.d.ts.map