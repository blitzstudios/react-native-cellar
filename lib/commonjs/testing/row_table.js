"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.createStoreTable = createStoreTable;
exports.createTestRowTable = createTestRowTable;
exports.createTestRowTableWithConnection = createTestRowTableWithConnection;
exports.createTestStoreTable = createTestStoreTable;
exports.createTestStoreTableWithConnection = createTestStoreTableWithConnection;
var _sqlite = require("../table/sqlite.js");
var _partitioned = require("../table/partitioned.js");
var _sqljs_connection = require("./sqljs_connection.js");
/** A row table for a test: SQLite over a fresh sql.js database, built and ready. */

/**
 * Creates a table on a new sql.js database with every optional connection method, so a test runs the device's code
 * paths.
 */
function createTestRowTable(schema, nativeShredSpec) {
  return createTestRowTableWithConnection(schema, nativeShredSpec).table;
}

/**
 * A store's table as {@linkcode defineSqliteStore} builds it, over `conn`. Its `shred` takes a fetch plan's `native`
 * choice. Call its {@linkcode RowTable.init | init} first.
 */
function createStoreTable(schema, conn, nativeShredSpecs) {
  return (0, _sqlite.createSqliteRowTable)((0, _partitioned.partitionedSchema)(schema), conn, (0, _partitioned.nativeSpecOf)(nativeShredSpecs));
}

/** A store's table as {@linkcode defineSqliteStore} builds it, on a new sql.js database, initialized. */
function createTestStoreTable(schema, nativeShredSpecs) {
  return createTestRowTable((0, _partitioned.partitionedSchema)(schema), (0, _partitioned.nativeSpecOf)(nativeShredSpecs));
}

/** Like {@linkcode createTestStoreTable}, also returning the connection, for a test that runs its own SQL over it. */
function createTestStoreTableWithConnection(schema, nativeShredSpecs) {
  return createTestRowTableWithConnection((0, _partitioned.partitionedSchema)(schema), (0, _partitioned.nativeSpecOf)(nativeShredSpecs));
}

/** Like {@linkcode createTestRowTable}, also returning the connection, for a test that inspects the SQL run. */
function createTestRowTableWithConnection(schema, nativeShredSpec) {
  const conn = (0, _sqljs_connection.createSqlJsConnection)({
    capabilities: 'full'
  });
  const table = (0, _sqlite.createSqliteRowTable)(schema, conn, nativeShredSpec);
  table.init();
  return {
    table,
    conn
  };
}
//# sourceMappingURL=row_table.js.map