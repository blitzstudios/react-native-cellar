"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.bindSqlJsStore = bindSqlJsStore;
exports.openSqlJsConnection = openSqlJsConnection;
var _telemetry = require("../diagnostics/telemetry.js");
/**
 * The {@linkcode SqliteConnection} for web, over sql.js (SQLite compiled to WebAssembly). Each store's database is held
 * in memory for the life of the page. The app loads sql.js and passes the module in, and device builds never import
 * this.
 */

/** The parts of a sql.js prepared statement used here. */

/** The parts of a sql.js database used here. */

/** The sql.js module, as `initSqlJs()` resolves it. */

/** A store, as far as binding it needs. */

/**
 * Opens a new in-memory sql.js database as a {@linkcode SqliteConnection}. sql.js is synchronous, so the async methods
 * wrap the sync ones.
 */
function openSqlJsConnection(SQL) {
  const db = new SQL.Database();
  const run = (sql, params) => {
    const statement = db.prepare(sql);
    try {
      statement.bind((params ?? []).map(param => param === undefined ? null : param));
      const rows = [];
      while (statement.step()) rows.push(statement.getAsObject());
      return {
        rows: {
          _array: rows
        }
      };
    } finally {
      statement.free();
    }
  };
  const batch = commands => {
    run('BEGIN;');
    try {
      for (const [sql, params] of commands) run(sql, params);
      run('COMMIT;');
    } catch (error) {
      run('ROLLBACK;');
      throw error;
    }
  };
  return {
    execute: run,
    executeAsync: async (sql, params) => run(sql, params),
    executeBatch: batch,
    executeBatchAsync: async commands => batch(commands)
  };
}

/**
 * Binds `store` to a new sql.js database of its own. A failure is reported, not thrown, and the store's reads stay
 * empty.
 */
function bindSqlJsStore(label, SQL, store) {
  try {
    store.bindSqlite(openSqlJsConnection(SQL), {
      database: `sql.js:${label}`
    });
  } catch (error) {
    (0, _telemetry.reportStoreDegradation)({
      scope: `sqljs.bind.${label}`,
      context: 'failed to bind the store to sql.js; its reads are empty for the life of the page',
      error,
      extra: {
        label
      }
    });
  }
}

// Exported so the built declaration files keep these names in scope for the doc links above; an import that only a
// doc comment uses is dropped from them.
//# sourceMappingURL=sqljs_connection.js.map