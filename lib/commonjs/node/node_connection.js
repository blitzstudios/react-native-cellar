"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.bindNodeStore = bindNodeStore;
exports.openNodeConnection = openNodeConnection;
var _nodeFs = _interopRequireDefault(require("node:fs"));
var _nodeOs = _interopRequireDefault(require("node:os"));
var _nodePath = _interopRequireDefault(require("node:path"));
var _nodeWorker_threads = require("node:worker_threads");
var _telemetry = require("../diagnostics/telemetry.js");
var _writer = require("./writer.js");
function _interopRequireDefault(e) { return e && e.__esModule ? e : { default: e }; }
/**
 * The {@linkcode SqliteConnection} for Node, over `node:sqlite`, for a server that renders a store's reads. A worker
 * thread ({@linkcode ./writer}) holds the database for writing, so a fetched body is parsed and written off the thread
 * that renders; the main thread reads through a connection of its own to the same file, which WAL lets run alongside a
 * write.
 */

/** How long a call the main thread blocks on may wait behind the writes queued ahead of it. */
const SYNC_TIMEOUT_MS = 30_000;

/** A connection over `node:sqlite`, with the means to shut its writer down. */

function removeDatabase(file) {
  for (const suffix of ['', '-wal', '-shm']) _nodeFs.default.rmSync(`${file}${suffix}`, {
    force: true
  });
}
function errorOf(reply) {
  const error = new Error(reply.error?.message ?? 'cellar node writer: unknown error');
  if (reply.error?.code) error.code = reply.error.code;
  return error;
}

/**
 * Opens a database for one store: its writer thread, and the main thread's reader over the same file. Blocks until the
 * writer has opened the file, which is at startup, when a store binds.
 */
function openNodeConnection(options = {}) {
  const file = options.path ?? _nodePath.default.join(_nodeOs.default.tmpdir(), `cellar-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  removeDatabase(file);
  const requests = new _nodeWorker_threads.MessageChannel();
  const replies = new _nodeWorker_threads.MessageChannel();
  const signal = new SharedArrayBuffer(4);
  const waiting = new Int32Array(signal);
  const worker = new _nodeWorker_threads.Worker(options.writerFile ?? _nodePath.default.join(__dirname, 'writer.js'), {
    workerData: {
      cellarWriter: {
        path: file,
        requests: requests.port2,
        replies: replies.port2,
        signal
      }
    },
    transferList: [requests.port2, replies.port2]
  });
  // A store's writer lives as long as the process; it must not be what keeps the process alive.
  worker.unref();
  requests.port1.unref();
  let nextId = 0;
  const pending = new Map();
  requests.port1.on('message', reply => {
    const waiter = pending.get(reply.id);
    if (!waiter) return;
    pending.delete(reply.id);
    if (reply.error) waiter.reject(errorOf(reply));else waiter.resolve(reply.rows ?? []);
  });
  let stopped;
  const stop = error => {
    stopped ??= error;
    for (const waiter of pending.values()) waiter.reject(stopped);
    pending.clear();
  };
  worker.on('error', error => stop(error instanceof Error ? error : new Error(String(error))));
  worker.on('exit', code => stop(new Error(`cellar node writer: the writer exited (code ${code})`)));
  const callSync = request => {
    if (stopped) throw stopped;
    Atomics.store(waiting, 0, 0);
    nextId += 1;
    requests.port1.postMessage({
      ...request,
      id: nextId,
      sync: true
    });
    if (Atomics.wait(waiting, 0, 0, SYNC_TIMEOUT_MS) === 'timed-out') {
      throw new Error(`cellar node writer: no answer in ${SYNC_TIMEOUT_MS}ms`);
    }
    const reply = (0, _nodeWorker_threads.receiveMessageOnPort)(replies.port1)?.message;
    if (!reply) throw new Error('cellar node writer: the writer signalled but sent no reply');
    if (reply.error) throw errorOf(reply);
    return reply.rows ?? [];
  };
  const callAsync = request => new Promise((resolve, reject) => {
    if (stopped) {
      reject(stopped);
      return;
    }
    nextId += 1;
    pending.set(nextId, {
      resolve,
      reject
    });
    requests.port1.postMessage({
      ...request,
      id: nextId,
      sync: false
    });
  });
  callSync({
    kind: 'ready'
  });
  const {
    DatabaseSync
  } = (0, _writer.nodeSqlite)();
  const db = new DatabaseSync(file);
  db.exec('PRAGMA busy_timeout = 5000;');
  const prepare = (0, _writer.statementCache)(db);
  const result = rows => ({
    rows: {
      _array: rows
    }
  });
  const reader = {
    execute: (sql, params) => result(prepare(sql).all(...(0, _writer.bindable)(params))),
    reader: undefined
  };
  return {
    path: file,
    reader,
    execute: (sql, params) => result(callSync({
      kind: 'execute',
      sql,
      params
    })),
    executeAsync: async (sql, params) => result(await callAsync({
      kind: 'execute',
      sql,
      params
    })),
    executeBatch: commands => {
      callSync({
        kind: 'batch',
        commands
      });
    },
    executeBatchAsync: async commands => {
      await callAsync({
        kind: 'batch',
        commands
      });
    },
    shredBatchAsync: async commands => {
      await callAsync({
        kind: 'batch',
        commands
      });
    },
    close: async () => {
      db.close();
      requests.port1.close();
      replies.port1.close();
      await worker.terminate();
    }
  };
}

/** A store, as far as binding it needs. */

/**
 * Binds `store` to a database of its own on this machine, written by a worker thread. A failure is reported, not
 * thrown, and the store's reads stay empty.
 */
function bindNodeStore(label, store, options) {
  try {
    const conn = openNodeConnection(options);
    store.bindSqlite(conn, {
      database: `node:${label}`
    });
    return conn;
  } catch (error) {
    (0, _telemetry.reportStoreDegradation)({
      scope: `node.bind.${label}`,
      group: 'node.bind',
      context: 'failed to bind the store to node:sqlite; its reads are empty for the life of the process',
      error,
      extra: {
        label
      }
    });
    return undefined;
  }
}

// Exported so the built declaration files keep these names in scope for the doc links above; an import that only a
// doc comment uses is dropped from them.
//# sourceMappingURL=node_connection.js.map