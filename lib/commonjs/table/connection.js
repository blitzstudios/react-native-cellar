"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.guardedConnection = guardedConnection;
exports.pinnedReader = pinnedReader;
exports.readRows = readRows;
exports.readRowsIn = readRowsIn;
exports.runBatch = runBatch;
exports.runBatchAsync = runBatchAsync;
/** The interface between the stores and the platform's SQLite driver. */

/**
 * What a driver returns for one statement. Reading rows should go through {@linkcode readRows}, which unwraps the rows
 * and calls {@linkcode QueryExecResult.dispose | dispose}.
 */

/**
 * A SQLite database handle, as Cellar uses it; a driver adapter implements this. Only
 * {@linkcode SqliteConnection.execute | execute} is required: each optional method is a faster path Cellar falls
 * back from when it's missing.
 */

/** A connection with no separate reader, so every statement runs on this one handle and sees its `TEMP` tables. */

/** The one handle to run reads on: the connection's reader if it has one, otherwise the connection itself. */
function pinnedReader(conn) {
  return conn.reader ?? {
    ...conn,
    reader: undefined
  };
}

/** One SQL statement and its parameters, as {@linkcode runBatch} takes them. */

/**
 * Runs `commands` as one transaction, which is what makes a delete-then-insert replacement all-or-nothing. It holds
 * the JS thread for the length of the write, so anything ingest-sized wants {@linkcode runBatchAsync} instead.
 */
function runBatch(conn, commands) {
  if (conn.executeBatch) {
    conn.executeBatch(commands);
    return;
  }
  conn.execute('BEGIN;');
  try {
    for (const [sql, params] of commands) conn.execute(sql, params);
    conn.execute('COMMIT;');
  } catch (error) {
    conn.execute('ROLLBACK;');
    throw error;
  }
}

/**
 * The same transaction handed to the driver's async batch, for a write big enough to drop a frame — an ingest's insert
 * chunks. A driver without one runs it synchronously, so awaiting this is not on its own a promise that JS yielded.
 */
async function runBatchAsync(conn, commands) {
  if (conn.executeBatchAsync) {
    await conn.executeBatchAsync(commands);
    return;
  }
  runBatch(conn, commands);
}
const EMPTY_RESULT = {
  rows: {
    _array: []
  }
};

/**
 * A statement refused because another one held the connection, rather than because the database is unusable. SQLite
 * reports these by message only, so matching them is the whole of the distinction.
 */
const CONTENTION = /cannot start a transaction within a transaction|no such savepoint|database (?:table )?is locked|SQLITE_BUSY/i;

/**
 * How many contended failures to absorb before treating the connection as broken. Contention is a bug worth fixing
 * where it happens, but it is recoverable — the next statement on an idle connection succeeds — and the cost of
 * calling it fatal is the store's whole working set moving onto the JS heap for the session. A run of them is
 * something else, so this does not absorb them forever.
 */
const CONTENTION_TOLERANCE = 4;

/** Wraps `conn` so every statement returns: the first failure calls `onFatal`, and later calls answer empty. */
function guardedConnection(conn, onFatal, onContended) {
  let failed = false;
  let contended = 0;
  const trip = (error, op) => {
    if (__DEV__) throw error;
    if (failed) return;
    if (CONTENTION.test(String(error?.message ?? error))) {
      contended += 1;
      // Reported once: the first one says the connection is being shared by something that should not be sharing it,
      // and the rest say the same thing.
      if (contended === 1) onContended?.(error, op);
      if (contended < CONTENTION_TOLERANCE) return;
    }
    failed = true;
    onFatal(error, op);
  };
  function guard(op, run, benign) {
    if (failed) return benign;
    try {
      return run();
    } catch (error) {
      trip(error, op);
      return benign;
    }
  }
  async function guardAsync(op, run, benign) {
    if (failed) return benign;
    try {
      return await run();
    } catch (error) {
      trip(error, op);
      return benign;
    }
  }
  const guarded = {
    execute: (sql, params) => guard('execute', () => conn.execute(sql, params), EMPTY_RESULT),
    executeBatch: conn.executeBatch && (commands => guard('executeBatch', () => conn.executeBatch(commands), undefined)),
    executeAsync: conn.executeAsync && ((sql, params) => guardAsync('executeAsync', () => conn.executeAsync(sql, params), EMPTY_RESULT)),
    executeBatchAsync: conn.executeBatchAsync && (commands => guardAsync('executeBatchAsync', () => conn.executeBatchAsync(commands), undefined)),
    // Deliberately unguarded: `shred` answers a rejection by parsing in JS, and swallowing one here into a resolved 0
    // would take that fallback away and degrade the store instead. A shred fails for two reasons, and letting it reject
    // is right for both — a payload the native shredder cannot handle is recovered by the JS parse, and a broken disk
    // trips this guard anyway on the writes that fallback issues, at the cost of one wasted parse.
    shredJsonArrayAsync: conn.shredJsonArrayAsync && ((spec, rawJson, binds) => failed ? Promise.resolve(0) : conn.shredJsonArrayAsync(spec, rawJson, binds)),
    reader: conn.reader && {
      execute: (sql, params) => guard('reader.execute', () => conn.reader.execute(sql, params), EMPTY_RESULT),
      reader: undefined
    }
  };
  return guarded;
}

/**
 * Runs a `SELECT` and returns its rows as plain objects. It runs on the connection's reader if it has one, so a query
 * of a `TEMP` table the caller just created must be passed a {@linkcode PinnedConnection}.
 */
function readRows(conn, sql, params) {
  const result = (conn.reader ?? conn).execute(sql, params);
  const rows = result.rows?._array ?? [];
  // The native result's C++ backing counts against Hermes' external memory until its wrapper is collected.
  result.dispose?.();
  return rows;
}

/** SQLite's limit on the bind parameters of one statement, before 3.32 raised it. */
const MAX_BIND_PARAMS = 999;

/**
 * Runs a `SELECT` over `values` in as many statements as it takes, and returns every row, in the order the statements
 * ran. `sql` is handed the placeholders for one chunk, such as `?, ?, ?`, to put inside its `IN (…)`; `before` binds
 * ahead of them and `after` behind. A chunk holds `chunk` values, or as many as SQLite's bind limit leaves room for
 * when that's fewer. A smaller `chunk` keeps each native result small when rows are wide.
 */
function readRowsIn(conn, sql, values, opts = {}) {
  const before = opts.before ?? [];
  const after = opts.after ?? [];
  const size = Math.max(1, Math.min(opts.chunk ?? Infinity, MAX_BIND_PARAMS - before.length - after.length));
  const out = [];
  for (let start = 0; start < values.length; start += size) {
    const chunk = values.slice(start, start + size);
    const placeholders = chunk.map(() => '?').join(', ');
    for (const row of readRows(conn, sql(placeholders), [...before, ...chunk, ...after])) out.push(row);
  }
  return out;
}
//# sourceMappingURL=connection.js.map