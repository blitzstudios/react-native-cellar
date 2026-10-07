/** A row table for a test: SQLite over a fresh sql.js database, built and ready. */

import { RowShape, RowTable, RowTableSchema } from '../table/types';
import { createSqliteRowTable } from '../table/sqlite';
import type { SqliteConnection } from '../table/connection';
import { nativeSpecOf, PartitionKeyColumn, partitionedSchema, StoreTableSchema } from '../table/partitioned';
import { NativeShredSpec, ShredSpec } from '../write/shred_spec';
import { createSqlJsConnection, SqlJsConnection } from './sqljs_connection';

/**
 * Creates a table on a new sql.js database with every optional connection method, so a test runs the device's code
 * paths.
 */
export function createTestRowTable<Row extends RowShape>(schema: RowTableSchema<Row>, nativeShredSpec?: NativeShredSpec): RowTable<Row> {
  return createTestRowTableWithConnection(schema, nativeShredSpec).table;
}

/**
 * A store's table as {@linkcode defineSqliteStore} builds it from the store's schema and its `nativeShredSpecs`, over
 * `conn`: for a test that picks its own connection. Its `shred` takes a fetch plan's `native` choice in place of a
 * partition. Call its {@linkcode RowTable.init | init} first.
 */
export function createStoreTable<Row extends RowShape>(
  schema: StoreTableSchema<Row>,
  conn: SqliteConnection,
  nativeShredSpecs?: Readonly<Record<string, ShredSpec>>,
): RowTable<Row & PartitionKeyColumn> {
  return createSqliteRowTable(partitionedSchema(schema), conn, nativeSpecOf(nativeShredSpecs));
}

/** A store's table as {@linkcode defineSqliteStore} builds it from the store's schema, on a new sql.js database, built and ready. */
export function createTestStoreTable<Row extends RowShape>(
  schema: StoreTableSchema<Row>,
  nativeShredSpecs?: Readonly<Record<string, ShredSpec>>,
): RowTable<Row & PartitionKeyColumn> {
  return createTestRowTable(partitionedSchema(schema), nativeSpecOf(nativeShredSpecs));
}

/** Like {@linkcode createTestStoreTable}, also returning the connection, for a test that runs its own SQL over it. */
export function createTestStoreTableWithConnection<Row extends RowShape>(
  schema: StoreTableSchema<Row>,
  nativeShredSpecs?: Readonly<Record<string, ShredSpec>>,
): {
  /** The table. */
  table: RowTable<Row & PartitionKeyColumn>;
  /** Its connection. */
  conn: SqlJsConnection;
} {
  return createTestRowTableWithConnection(partitionedSchema(schema), nativeSpecOf(nativeShredSpecs));
}

/** Like {@linkcode createTestRowTable}, also returning the connection, for a test that inspects the SQL run. */
export function createTestRowTableWithConnection<Row extends RowShape>(
  schema: RowTableSchema<Row>,
  nativeShredSpec?: NativeShredSpec,
): {
  /** The table. */
  table: RowTable<Row>;
  /** Its connection. */
  conn: SqlJsConnection;
} {
  const conn = createSqlJsConnection({ capabilities: 'full' });
  const table = createSqliteRowTable(schema, conn, nativeShredSpec);
  table.init();
  return { table, conn };
}
