"use strict";

/**
 * The Node writer: a worker thread that owns a store's database for writing, so parsing a fetched body and writing its
 * rows happen off the thread that renders. It takes requests over one port, in order, and answers each on that port,
 * or, for a call the main thread is blocked on, on the sync port with a signal it waits on.
 */

import { workerData } from 'node:worker_threads';
import { shredCommandStatements } from "../write/js_shred.js";

/** What the main thread hands the writer when it starts. */

/**
 * `node:sqlite`, loaded at run time rather than imported: a bundler that doesn't know the module yet would turn a static
 * import into a reference it can't resolve, and fail the build of the server that bundles this.
 */
export function nodeSqlite() {
  return process.getBuiltinModule('node:sqlite');
}

/** Prepared statements kept per connection; a store runs a few dozen distinct ones over and over. */
const STATEMENT_CACHE_MAX = 256;

/** A connection's statements by SQL, most recently used last, so the oldest is the first evicted. */
export function statementCache(db) {
  const statements = new Map();
  return sql => {
    let statement = statements.get(sql);
    if (statement) {
      statements.delete(sql);
    } else {
      statement = db.prepare(sql);
      if (statements.size >= STATEMENT_CACHE_MAX) statements.delete(statements.keys().next().value);
    }
    statements.set(sql, statement);
    return statement;
  };
}

/** `undefined` binds as NULL, the way every other connection takes it. */
export function bindable(params) {
  return params ? params.map(param => param === undefined ? null : param) : [];
}
function startWriter({
  path,
  requests,
  replies,
  signal
}) {
  const g = globalThis;
  g.__DEV__ ??= process.env.NODE_ENV !== 'production';
  const {
    DatabaseSync: Database
  } = nodeSqlite();
  const db = new Database(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = OFF; PRAGMA busy_timeout = 5000;');
  const prepare = statementCache(db);
  const run = (sql, params) => prepare(sql).all(...bindable(params));
  const batch = commands => {
    db.exec('BEGIN;');
    try {
      for (const command of commands) {
        if (Array.isArray(command)) run(command[0], command[1]);else for (const [sql, params] of shredCommandStatements(command)) run(sql, params);
      }
      db.exec('COMMIT;');
    } catch (error) {
      db.exec('ROLLBACK;');
      throw error;
    }
  };
  const waiting = new Int32Array(signal);
  requests.on('message', request => {
    let reply;
    try {
      if (request.kind === 'execute') reply = {
        id: request.id,
        rows: run(request.sql, request.params)
      };else if (request.kind === 'batch') {
        batch(request.commands);
        reply = {
          id: request.id
        };
      } else reply = {
        id: request.id
      };
    } catch (error) {
      const {
        message,
        code
      } = error;
      reply = {
        id: request.id,
        error: {
          message: message ?? String(error),
          code
        }
      };
    }
    if (!request.sync) {
      requests.postMessage(reply);
      return;
    }
    replies.postMessage(reply);
    Atomics.store(waiting, 0, 1);
    Atomics.notify(waiting, 0);
  });
}
const data = workerData;
if (data?.cellarWriter) startWriter(data.cellarWriter);
//# sourceMappingURL=writer.js.map