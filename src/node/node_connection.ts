/**
 * The {@linkcode SqliteConnection} for Node, over `node:sqlite`, for a server that renders a store's reads. A worker
 * thread ({@linkcode ./writer}) holds the database for writing, so a fetched body is parsed and written off the thread
 * that renders; the main thread reads through a connection of its own to the same file, which WAL lets run alongside a
 * write.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MessageChannel, receiveMessageOnPort, Worker } from 'node:worker_threads';

import type { BindOptions } from '../define_sqlite_store';
import { reportStoreDegradation } from '../diagnostics/telemetry';
import type { BatchCommand, PinnedConnection, QueryExecResult, ShredCommand, SqliteConnection } from '../table/connection';
import { bindable, nodeSqlite, statementCache, type Param, type WriterReply, type WriterRequest } from './writer';

/** How long a call the main thread blocks on may wait behind the writes queued ahead of it. */
const SYNC_TIMEOUT_MS = 30_000;

export interface NodeConnectionOptions {
  /** The database file. A new file in the OS temp directory by default; whatever is at the path is deleted first. */
  path?: string;
  /** The writer's script, for a build that moves it; `writer.js` beside this module by default. */
  writerFile?: string;
}

/** A connection over `node:sqlite`, with the means to shut its writer down. */
export interface NodeConnection extends SqliteConnection {
  /** The database file. */
  readonly path: string;
  /** Stops the writer and closes both handles. Statements after this throw. */
  close: () => Promise<void>;
}

function removeDatabase(file: string): void {
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${file}${suffix}`, { force: true });
}

function errorOf(reply: WriterReply): Error {
  const error = new Error(reply.error?.message ?? 'cellar node writer: unknown error') as Error & { code?: string };
  if (reply.error?.code) error.code = reply.error.code;
  return error;
}

/**
 * Opens a database for one store: its writer thread, and the main thread's reader over the same file. Blocks until the
 * writer has opened the file, which is at startup, when a store binds.
 */
export function openNodeConnection(options: NodeConnectionOptions = {}): NodeConnection {
  const file = options.path ?? path.join(os.tmpdir(), `cellar-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  removeDatabase(file);

  const requests = new MessageChannel();
  const replies = new MessageChannel();
  const signal = new SharedArrayBuffer(4);
  const waiting = new Int32Array(signal);
  const worker = new Worker(options.writerFile ?? path.join(__dirname, 'writer.js'), {
    workerData: { cellarWriter: { path: file, requests: requests.port2, replies: replies.port2, signal } },
    transferList: [requests.port2, replies.port2],
  });
  // A store's writer lives as long as the process; it must not be what keeps the process alive.
  worker.unref();
  requests.port1.unref();

  let nextId = 0;
  const pending = new Map<number, { resolve: (rows: unknown[]) => void; reject: (error: Error) => void }>();
  requests.port1.on('message', (reply: WriterReply) => {
    const waiter = pending.get(reply.id);
    if (!waiter) return;
    pending.delete(reply.id);
    if (reply.error) waiter.reject(errorOf(reply));
    else waiter.resolve(reply.rows ?? []);
  });
  let stopped: Error | undefined;
  const stop = (error: Error): void => {
    stopped ??= error;
    for (const waiter of pending.values()) waiter.reject(stopped);
    pending.clear();
  };
  worker.on('error', (error: unknown) => stop(error instanceof Error ? error : new Error(String(error))));
  worker.on('exit', (code) => stop(new Error(`cellar node writer: the writer exited (code ${code})`)));

  type Request = WriterRequest extends infer R ? (R extends { id: number; sync: boolean } ? Omit<R, 'id' | 'sync'> : never) : never;

  const callSync = (request: Request): unknown[] => {
    if (stopped) throw stopped;
    Atomics.store(waiting, 0, 0);
    nextId += 1;
    requests.port1.postMessage({ ...request, id: nextId, sync: true });
    if (Atomics.wait(waiting, 0, 0, SYNC_TIMEOUT_MS) === 'timed-out') {
      throw new Error(`cellar node writer: no answer in ${SYNC_TIMEOUT_MS}ms`);
    }
    const reply = receiveMessageOnPort(replies.port1)?.message as WriterReply | undefined;
    if (!reply) throw new Error('cellar node writer: the writer signalled but sent no reply');
    if (reply.error) throw errorOf(reply);
    return reply.rows ?? [];
  };

  const callAsync = (request: Request): Promise<unknown[]> =>
    new Promise((resolve, reject) => {
      if (stopped) {
        reject(stopped);
        return;
      }
      nextId += 1;
      pending.set(nextId, { resolve, reject });
      requests.port1.postMessage({ ...request, id: nextId, sync: false });
    });

  callSync({ kind: 'ready' });

  const { DatabaseSync } = nodeSqlite();
  const db = new DatabaseSync(file);
  db.exec('PRAGMA busy_timeout = 5000;');
  const prepare = statementCache(db);
  const result = (rows: unknown[]): QueryExecResult => ({ rows: { _array: rows } });

  const reader: PinnedConnection = {
    execute: (sql, params) => result(prepare(sql).all(...bindable(params as readonly Param[] | undefined))),
    reader: undefined,
  };

  return {
    path: file,
    reader,
    execute: (sql, params) => result(callSync({ kind: 'execute', sql, params })),
    executeAsync: async (sql, params) => result(await callAsync({ kind: 'execute', sql, params })),
    executeBatch: (commands) => {
      callSync({ kind: 'batch', commands });
    },
    executeBatchAsync: async (commands) => {
      await callAsync({ kind: 'batch', commands });
    },
    shredBatchAsync: async (commands: ReadonlyArray<BatchCommand | ShredCommand>) => {
      await callAsync({ kind: 'batch', commands });
    },
    close: async () => {
      db.close();
      requests.port1.close();
      replies.port1.close();
      await worker.terminate();
    },
  };
}

/** A store, as far as binding it needs. */
interface BindableStore {
  bindSqlite: (conn: SqliteConnection, options?: BindOptions) => void;
}

/**
 * Binds `store` to a database of its own on this machine, written by a worker thread. A failure is reported, not
 * thrown, and the store's reads stay empty.
 */
export function bindNodeStore(label: string, store: BindableStore, options?: NodeConnectionOptions): NodeConnection | undefined {
  try {
    const conn = openNodeConnection(options);
    store.bindSqlite(conn, { database: `node:${label}` });
    return conn;
  } catch (error) {
    reportStoreDegradation({
      scope: `node.bind.${label}`,
      group: 'node.bind',
      context: 'failed to bind the store to node:sqlite; its reads are empty for the life of the process',
      error,
      extra: { label },
    });
    return undefined;
  }
}

// Exported so the built declaration files keep these names in scope for the doc links above; an import that only a
// doc comment uses is dropped from them.
export type { SqliteConnection };
