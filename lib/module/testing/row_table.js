"use strict";

/** A row table for a test: SQLite over a fresh sql.js database, built and ready. */

import { createSqliteRowTable } from "../table/sqlite.js";
import { nativeSpecOf, partitionedSchema } from "../table/partitioned.js";
import { createSqlJsConnection } from "./sqljs_connection.js";

/**
 * Creates a table on a new sql.js database with every optional connection method, so a test runs the device's code
 * paths.
 */
export function createTestRowTable(schema, nativeShredSpec) {
  return createTestRowTableWithConnection(schema, nativeShredSpec).table;
}

/**
 * A store's table as {@linkcode defineSqliteStore} builds it, over `conn`. Its `shred` takes a partition fetch's `native`
 * choice. Call its {@linkcode RowTable.init | init} first.
 */
export function createStoreTable(schema, conn, nativeShredSpecs) {
  return createSqliteRowTable(partitionedSchema(schema), conn, nativeSpecOf(nativeShredSpecs));
}

/** A store's table as {@linkcode defineSqliteStore} builds it, on a new sql.js database, initialized. */
export function createTestStoreTable(schema, nativeShredSpecs) {
  return createTestRowTable(partitionedSchema(schema), nativeSpecOf(nativeShredSpecs));
}

/** Like {@linkcode createTestStoreTable}, also returning the connection, for a test that runs its own SQL over it. */
export function createTestStoreTableWithConnection(schema, nativeShredSpecs) {
  return createTestRowTableWithConnection(partitionedSchema(schema), nativeSpecOf(nativeShredSpecs));
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