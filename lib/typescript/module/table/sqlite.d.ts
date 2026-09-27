/** The row table on SQLite: rows live in the database, and become JS objects at the moment a read materializes them. */
import { RowShape, RowTable, RowTableSchema } from './types';
import { NativeShredSpec, ShredSpec } from '../write/shred_spec';
import { SqliteConnection } from './connection';
import type { defineSqliteStore } from '../define_sqlite_store';
/** Options for {@linkcode createSqliteRowTable}. */
export interface SqliteRowTableOptions {
    /**
     * Creates the table, its indexes and its ETag table as `TEMP` tables, held in memory and starting empty each
     * launch. A temp table is visible only to its own connection, so it is never read through a separate reader.
     */
    temporary?: boolean;
}
/**
 * Creates a {@linkcode RowTable} backed by a SQLite table. Rows stay in SQLite, and only the ones a read selects become
 * JS objects. {@linkcode defineSqliteStore} creates one when a store is bound. Call its
 * {@linkcode RowTable.init | init} before anything else, which creates the table or rebuilds an outdated one.
 */
export declare function createSqliteRowTable<Row extends RowShape>(schema: RowTableSchema<Row>, conn: SqliteConnection, storeShredSpec?: NativeShredSpec, options?: SqliteRowTableOptions): RowTable<Row>;
export type { RowTable, ShredSpec, defineSqliteStore };
//# sourceMappingURL=sqlite.d.ts.map