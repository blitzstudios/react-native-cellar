/** A {@linkcode SqliteConnection} over sql.js for Jest: real SQLite, though a different build from the device's. */

import path from 'path';

import { evalShredSpec } from '../write/shred_spec';
import type { ShredSpec } from '../write/shred_spec';
import { BatchCommand, PinnedConnection, QueryExecResult, ShredCommand, SqliteConnection } from '../table/connection';

interface SqlJsStatement {
  bind(params: Array<string | number | null>): void;
  step(): boolean;
  getAsObject(): unknown;
  free(): void;
}
interface SqlJsDatabase {
  prepare(sql: string): SqlJsStatement;
  close(): void;
}
interface SqlJsModule {
  Database: new () => SqlJsDatabase;
}
type SqlJsFactory = (config: { locateFile: (file: string) => string }) => Promise<SqlJsModule>;

let SqlModule: SqlJsModule | undefined;

/** Loads sql.js. Await it in `beforeAll` before creating a connection. */
export async function initSqlJs(): Promise<void> {
  if (SqlModule) return;
  // eslint-disable-next-line global-require
  const factory = require('sql.js') as SqlJsFactory;
  const dist = path.dirname(require.resolve('sql.js'));
  SqlModule = await factory({ locateFile: (file: string) => path.join(dist, file) });
}

/**
 * Which connection methods a test connection has: `minimal` has only {@linkcode SqliteConnection.execute | execute},
 * and `full` has every optional method.
 */
export type SqlJsCapabilities = 'minimal' | 'full';

/** How many times each connection method has been called. */
export interface SqlJsCallLog {
  execute: number;
  executeAsync: number;
  executeBatch: number;
  executeBatchAsync: number;
  shredBatchAsync: number;
  /** Calls to the reader's {@linkcode SqliteConnection.execute | execute}. */
  readerExecute: number;
  /** Calls to a result's {@linkcode QueryExecResult.dispose | dispose}. */
  dispose: number;
}

/** A test connection, which also records what was called on it. */
export interface SqlJsConnection extends SqliteConnection {
  /** Closes the database. */
  close(): void;
  /** How many times each method has been called. */
  calls: SqlJsCallLog;
  /** Every SQL statement run, in order. */
  executed: string[];
}

/** Options for {@linkcode createSqlJsConnection}. */
export interface SqlJsConnectionOptions {
  /** Which optional methods the connection has; `minimal` by default. */
  capabilities?: SqlJsCapabilities;
  /** Makes a result's {@linkcode QueryExecResult.dispose | dispose()} clear its rows, like a driver that frees them. */
  poisonOnDispose?: boolean;
}

/** Turns every `undefined` bind into `null`, the shape sql.js accepts. */
function sanitize(params?: ReadonlyArray<string | number | null>): Array<string | number | null> {
  if (!params) return [];
  return params.map((param) => (param === undefined ? null : param));
}

function shredSql(spec: ShredSpec, rows: ReadonlyArray<Record<string, string | number | null | undefined>>, binds: ReadonlyArray<string | number | null>) {
  const cmds: Array<[string, Array<string | number | null>]> = [];
  const deleteWhere = spec.deleteWhere ?? [];
  if (deleteWhere.length) {
    const where = deleteWhere.map((column) => `${column.column} = ?`).join(' AND ');
    cmds.push([`DELETE FROM ${spec.table} WHERE ${where};`, deleteWhere.map((column) => binds[column.bindIndex] ?? null)]);
  }
  const placeholders = spec.columns.map(() => '?').join(', ');
  const insert = `${spec.insertVerb} INTO ${spec.table} (${spec.columns.join(', ')}) VALUES (${placeholders});`;
  for (const row of rows) cmds.push([insert, spec.columns.map((column) => row[column] ?? null)]);
  return cmds;
}

/** The statements a native shred runs for one command, which parse the body in JS here. */
function shredCommandSql({ shred: spec, rawJson, binds }: ShredCommand) {
  const parsed = JSON.parse(rawJson) as unknown;
  const elements = spec.source === 'objectValues' ? Object.values(parsed as Record<string, unknown>) : (parsed as unknown[]);
  return shredSql(spec, evalShredSpec(spec, elements, binds), binds);
}

/** Creates a connection to a new in-memory sql.js database. Requires {@linkcode initSqlJs} to have finished. */
export function createSqlJsConnection(options: SqlJsConnectionOptions = {}): SqlJsConnection {
  if (!SqlModule) throw new Error('createSqlJsConnection: call `await initSqlJs()` in beforeAll first');
  const capabilities = options.capabilities ?? 'minimal';
  const db = new SqlModule.Database();

  const calls: SqlJsCallLog = {
    execute: 0,
    executeAsync: 0,
    executeBatch: 0,
    executeBatchAsync: 0,
    shredBatchAsync: 0,
    readerExecute: 0,
    dispose: 0,
  };
  const executed: string[] = [];

  const run = (sql: string, params?: ReadonlyArray<string | number | null>): QueryExecResult => {
    executed.push(sql);
    const stmt = db.prepare(sql);
    try {
      stmt.bind(sanitize(params));
      const out: unknown[] = [];
      while (stmt.step()) out.push(stmt.getAsObject());
      const result: QueryExecResult = {
        rows: { _array: out },
        dispose: () => {
          calls.dispose += 1;
          if (options.poisonOnDispose && result.rows) result.rows._array = undefined;
        },
      };
      return result;
    } finally {
      stmt.free();
    }
  };

  const minimal: SqlJsConnection = {
    execute(sql, params) {
      calls.execute += 1;
      return run(sql, params);
    },
    close() {
      db.close();
    },
    calls,
    executed,
  };
  if (capabilities === 'minimal') return minimal;

  /** A read handle over the same sql.js database, modelling how a read is routed. */
  const reader: PinnedConnection = {
    execute(sql, params) {
      calls.readerExecute += 1;
      return run(sql, params);
    },
    reader: undefined,
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
    executeBatchAsync: async (commands) => {
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
    shredBatchAsync: async (commands) => {
      calls.shredBatchAsync += 1;
      run('BEGIN;');
      try {
        for (const command of commands) {
          if (Array.isArray(command)) run(...(command as BatchCommand));
          else for (const [sql, params] of shredCommandSql(command as ShredCommand)) run(sql, params);
        }
        run('COMMIT;');
      } catch (error) {
        run('ROLLBACK;');
        throw error;
      }
    },
  };
}

// Exported so the built declaration files keep these names in scope for the doc links above; an import that only a
// doc comment uses is dropped from them.
export type { QueryExecResult, SqliteConnection };
