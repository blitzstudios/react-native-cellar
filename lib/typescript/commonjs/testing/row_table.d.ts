/** A row table for a test: SQLite over a fresh sql.js database, built and ready. */
import { RowShape, RowTable, RowTableSchema } from '../table/types';
import type { SqliteConnection } from '../table/connection';
import { PartitionKeyColumn, StoreTableSchema } from '../table/partitioned';
import { NativeShredSpec } from '../write/shred_spec';
import { SqlJsConnection } from './sqljs_connection';
/**
 * Creates a table on a new sql.js database with every optional connection method, so a test runs the device's code
 * paths.
 */
export declare function createTestRowTable<Row extends RowShape>(schema: RowTableSchema<Row>, nativeShredSpec?: NativeShredSpec): RowTable<Row>;
/**
 * A store's table as {@linkcode defineSqliteStore} builds it from the store's schema, with its `partition_key` column
 * and ETag table, over `conn`: for a test that picks its own connection. Call its {@linkcode RowTable.init | init}
 * first.
 */
export declare function createStoreTable<Row extends RowShape>(schema: StoreTableSchema<Row>, conn: SqliteConnection, nativeShredSpec?: NativeShredSpec<never>): RowTable<Row & PartitionKeyColumn>;
/**
 * A store's table as {@linkcode defineSqliteStore} builds it from the store's schema, with its `partition_key` column
 * and ETag table, on a new sql.js database, built and ready.
 */
export declare function createTestStoreTable<Row extends RowShape>(schema: StoreTableSchema<Row>, nativeShredSpec?: NativeShredSpec<never>): RowTable<Row & PartitionKeyColumn>;
/** Like {@linkcode createTestStoreTable}, also returning the connection, for a test that runs its own SQL over it. */
export declare function createTestStoreTableWithConnection<Row extends RowShape>(schema: StoreTableSchema<Row>, nativeShredSpec?: NativeShredSpec<never>): {
    /** The table. */
    table: RowTable<Row & PartitionKeyColumn>;
    /** Its connection. */
    conn: SqlJsConnection;
};
/** Like {@linkcode createTestRowTable}, also returning the connection, for a test that inspects the SQL run. */
export declare function createTestRowTableWithConnection<Row extends RowShape>(schema: RowTableSchema<Row>, nativeShredSpec?: NativeShredSpec): {
    /** The table. */
    table: RowTable<Row>;
    /** Its connection. */
    conn: SqlJsConnection;
};
//# sourceMappingURL=row_table.d.ts.map