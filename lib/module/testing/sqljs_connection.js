"use strict";

/** A {@linkcode SqliteConnection} over sql.js for Jest: real SQLite, though a different build from the device's. */

import path from 'path';
import { evalShredSpec } from "../write/shred_spec.js";
let SqlModule;

/** Loads sql.js. Await it in `beforeAll` before creating a connection. */
export async function initSqlJs() {
  if (SqlModule) return;
  // eslint-disable-next-line global-require
  const factory = require('sql.js');
  const dist = path.dirname(require.resolve('sql.js'));
  SqlModule = await factory({
    locateFile: file => path.join(dist, file)
  });
}

/**
 * Which connection methods a test connection has: `minimal` has only {@linkcode SqliteConnection.execute | execute},
 * and `full` has every optional method.
 */

/** How many times each connection method has been called. */

/** A test connection, which also records what was called on it. */

/** Options for {@linkcode createSqlJsConnection}. */

/** Turns every `undefined` bind into `null`, the shape sql.js accepts. */
function sanitize(params) {
  if (!params) return [];
  return params.map(param => param === undefined ? null : param);
}
function shredSql(spec, rows, binds) {
  const cmds = [];
  const deleteWhere = spec.deleteWhere ?? [];
  if (deleteWhere.length) {
    const where = deleteWhere.map(column => `${column.column} = ?`).join(' AND ');
    cmds.push([`DELETE FROM ${spec.table} WHERE ${where};`, deleteWhere.map(column => binds[column.bindIndex] ?? null)]);
  }
  const placeholders = spec.columns.map(() => '?').join(', ');
  const insert = `${spec.insertVerb} INTO ${spec.table} (${spec.columns.join(', ')}) VALUES (${placeholders});`;
  for (const row of rows) cmds.push([insert, spec.columns.map(column => row[column] ?? null)]);
  return cmds;
}

/** The statements a native shred runs for one command, which parse the body in JS here. */
function shredCommandSql({
  shred: spec,
  rawJson,
  binds
}) {
  const parsed = JSON.parse(rawJson);
  const elements = spec.source === 'objectValues' ? Object.values(parsed) : parsed;
  return shredSql(spec, evalShredSpec(spec, elements, binds), binds);
}

/** Creates a connection to a new in-memory sql.js database. Requires {@linkcode initSqlJs} to have finished. */
export function createSqlJsConnection(options = {}) {
  if (!SqlModule) throw new Error('createSqlJsConnection: call `await initSqlJs()` in beforeAll first');
  const capabilities = options.capabilities ?? 'minimal';
  const db = new SqlModule.Database();
  const calls = {
    execute: 0,
    executeAsync: 0,
    executeBatch: 0,
    executeBatchAsync: 0,
    shredBatchAsync: 0,
    readerExecute: 0,
    dispose: 0
  };
  const executed = [];
  const run = (sql, params) => {
    executed.push(sql);
    const stmt = db.prepare(sql);
    try {
      stmt.bind(sanitize(params));
      const out = [];
      while (stmt.step()) out.push(stmt.getAsObject());
      const result = {
        rows: {
          _array: out
        },
        dispose: () => {
          calls.dispose += 1;
          if (options.poisonOnDispose && result.rows) result.rows._array = undefined;
        }
      };
      return result;
    } finally {
      stmt.free();
    }
  };
  const minimal = {
    execute(sql, params) {
      calls.execute += 1;
      return run(sql, params);
    },
    close() {
      db.close();
    },
    calls,
    executed
  };
  if (capabilities === 'minimal') return minimal;

  /** A read handle over the same sql.js database, modelling how a read is routed. */
  const reader = {
    execute(sql, params) {
      calls.readerExecute += 1;
      return run(sql, params);
    },
    reader: undefined
  };
  return {
    ...minimal,
    reader,
    executeAsync: async (sql, params) => {
      calls.executeAsync += 1;
      return run(sql, params);
    },
    executeBatch(commands) {
      calls.executeBatch += 1;
      run('BEGIN;');
      try {
        for (const [sql, params] of commands) run(sql, params);
        run('COMMIT;');
      } catch (error) {
        run('ROLLBACK;');
        throw error;
      }
    },
    executeBatchAsync: async commands => {
      calls.executeBatchAsync += 1;
      run('BEGIN;');
      try {
        for (const [sql, params] of commands) run(sql, params);
        run('COMMIT;');
      } catch (error) {
        run('ROLLBACK;');
        throw error;
      }
    },
    shredBatchAsync: async commands => {
      calls.shredBatchAsync += 1;
      run('BEGIN;');
      try {
        for (const command of commands) {
          if (Array.isArray(command)) run(...command);else for (const [sql, params] of shredCommandSql(command)) run(sql, params);
        }
        run('COMMIT;');
      } catch (error) {
        run('ROLLBACK;');
        throw error;
      }
    }
  };
}

// Exported so the built declaration files keep these names in scope for the doc links above; an import that only a
// doc comment uses is dropped from them.
//# sourceMappingURL=sqljs_connection.js.map