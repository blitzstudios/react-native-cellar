/**
 * The Node writer: a worker thread that owns a store's database for writing, so parsing a fetched body and writing its
 * rows happen off the thread that renders. It takes requests over one port, in order, and answers each on that port,
 * or, for a call the main thread is blocked on, on the sync port with a signal it waits on.
 */

import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { workerData, type MessagePort } from 'node:worker_threads';

import { shredCommandStatements } from '../write/js_shred';
import type { BatchCommand, ShredCommand } from '../table/connection';

/** What the main thread hands the writer when it starts. */
export interface WriterData {
  path: string;
  requests: MessagePort;
  replies: MessagePort;
  signal: SharedArrayBuffer;
}

export type Param = string | number | null | undefined;

export type WriterRequest =
  | { id: number; sync: boolean; kind: 'execute'; sql: string; params?: readonly Param[] }
  | { id: number; sync: boolean; kind: 'batch'; commands: ReadonlyArray<BatchCommand | ShredCommand> }
  | { id: number; sync: true; kind: 'ready' };

export type WriterReply = { id: number; rows?: unknown[]; error?: { message: string; code?: string } };

/** Prepared statements kept per connection; a store runs a few dozen distinct ones over and over. */
const STATEMENT_CACHE_MAX = 256;

/** A connection's statements by SQL, most recently used last, so the oldest is the first evicted. */
export function statementCache(db: DatabaseSync): (sql: string) => StatementSync {
  const statements = new Map<string, StatementSync>();
  return (sql) => {
    let statement = statements.get(sql);
    if (statement) {
      statements.delete(sql);
    } else {
      statement = db.prepare(sql);
      if (statements.size >= STATEMENT_CACHE_MAX) statements.delete(statements.keys().next().value as string);
    }
    statements.set(sql, statement);
    return statement;
  };
}

/** `undefined` binds as NULL, the way every other connection takes it. */
export function bindable(params: readonly Param[] | undefined): Array<string | number | null> {
  return params ? params.map((param) => (param === undefined ? null : param)) : [];
}

function startWriter({ path, requests, replies, signal }: WriterData): void {
  const g = globalThis as { __DEV__?: boolean };
  g.__DEV__ ??= process.env.NODE_ENV !== 'production';

  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = OFF; PRAGMA busy_timeout = 5000;');
  const prepare = statementCache(db);
  const run = (sql: string, params?: readonly Param[]): unknown[] => prepare(sql).all(...bindable(params));

  const batch = (commands: ReadonlyArray<BatchCommand | ShredCommand>): void => {
    db.exec('BEGIN;');
    try {
      for (const command of commands) {
        if (Array.isArray(command)) run(command[0], command[1]);
        else for (const [sql, params] of shredCommandStatements(command as ShredCommand)) run(sql, params);
      }
      db.exec('COMMIT;');
    } catch (error) {
      db.exec('ROLLBACK;');
      throw error;
    }
  };

  const waiting = new Int32Array(signal);
  requests.on('message', (request: WriterRequest) => {
    let reply: WriterReply;
    try {
      if (request.kind === 'execute') reply = { id: request.id, rows: run(request.sql, request.params) };
      else if (request.kind === 'batch') {
        batch(request.commands);
        reply = { id: request.id };
      } else reply = { id: request.id };
    } catch (error) {
      const { message, code } = error as { message?: string; code?: string };
      reply = { id: request.id, error: { message: message ?? String(error), code } };
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

const data = workerData as { cellarWriter?: WriterData } | null;
if (data?.cellarWriter) startWriter(data.cellarWriter);
