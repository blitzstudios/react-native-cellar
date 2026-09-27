"use strict";

/** A row table for a test: SQLite over a fresh sql.js database, built and ready. */

import { createSqliteRowTable } from "../table/sqlite.js";
import { partitionedSchema } from "../table/partitioned.js";
import { createSqlJsConnection } from "./sqljs_connection.js";

/**
 * Creates a table on a new sql.js database with every optional connection method, so a test runs the device's code
 * paths.
 */
export function createTestRowTable(schema, nativeShredSpec) {
  return createTestRowTableWithConnection(schema, nativeShredSpec).table;
}

/**
 * A store's table as {@linkcode defineSqliteStore} builds it from the store's schema, with its `partition_key` column
 * and ETag table, over `conn`: for a test that picks its own connection. Call its {@linkcode RowTable.init | init}
 * first.
 */
export function createStoreTable(schema, conn, nativeShredSpec) {
  return createSqliteRowTable(partitionedSchema(schema), conn, nativeShredSpec);
}

/**
 * A store's table as {@linkcode defineSqliteStore} builds it from the store's schema, with its `partition_key` column
 * and ETag table, on a new sql.js database, built and ready.
 */
export function createTestStoreTable(schema, nativeShredSpec) {
  return createTestRowTable(partitionedSchema(schema), nativeShredSpec);
}

/** Like {@linkcode createTestStoreTable}, also returning the connection, for a test that runs its own SQL over it. */
export function createTestStoreTableWithConnection(schema, nativeShredSpec) {
  return createTestRowTableWithConnection(partitionedSchema(schema), nativeShredSpec);
}

/** Like {@linkcode createTestRowTable}, also returning the connection, for a test that inspects the SQL run. */
export function createTestRowTableWithConnection(schema, nativeShredSpec) {
  const conn = createSqlJsConnection({
    capabilities: 'full'
  });
  const table = createSqliteRowTable(schema, conn, nativeShredSpec);
  table.init();
  return {
    table,
    conn
  };
}
//# sourceMappingURL=row_table.js.map