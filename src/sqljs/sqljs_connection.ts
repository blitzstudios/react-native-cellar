/**
 * The {@linkcode SqliteConnection} for web, over sql.js (SQLite compiled to WebAssembly). Each store's database is held
 * in memory for the life of the page. The app loads sql.js and passes the module in, and device builds never import
 * this.
 */

import type { BindOptions } from '../define_sqlite_store';
import { reportStoreDegradation } from '../diagnostics/telemetry';
import type { BatchCommand, QueryExecResult, SqliteConnection } from '../table/connection';

/** The parts of a sql.js prepared statement used here. */
interface SqlJsStatement {
  /** Sets the statement's parameters. */
  bind(params: Array<string | number | null>): void;
  /** Moves to the next result row, returning false when there are none left. */
  step(): boolean;
  /** The current row, as an object keyed by column. */
  getAsObject(): unknown;
  /** Frees the statement. */
  free(): void;
}

/** The parts of a sql.js database used here. */
interface SqlJsDatabase {
  /** Compiles a statement. */
  prepare(sql: string): SqlJsStatement;
}

/** The sql.js module, as `initSqlJs()` resolves it. */
export interface SqlJsModule {
  /** Creates a new in-memory database. */
  Database: new () => SqlJsDatabase;
}

/** A store, as far as binding it needs. */
interface BindableStore {
  /** Moves the store onto a connection. */
  bindSqlite: (conn: SqliteConnection, options?: BindOptions) => void;
}

/**
 * Opens a new in-memory sql.js database as a {@linkcode SqliteConnection}. sql.js is synchronous, so the async methods
 * wrap the sync ones.
 */
export function openSqlJsConnection(SQL: SqlJsModule): SqliteConnection {
  const db = new SQL.Database();

  const run = (sql: string, params?: ReadonlyArray<string | number | null | undefined>): QueryExecResult => {
    const statement = db.prepare(sql);
    try {
      statement.bind((params ?? []).map((param) => (param === undefined ? null : param)));
      const rows: unknown[] = [];
      while (statement.step()) rows.push(statement.getAsObject());
      return { rows: { _array: rows } };
    } finally {
      statement.free();
    }
  };

  const batch = (commands: ReadonlyArray<BatchCommand>): void => {
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
    executeBatchAsync: async (commands) => batch(commands),
  };
}

/**
 * Binds `store` to a new sql.js database of its own. A failure is reported, not thrown, and the store's reads stay
 * empty.
 */
export function bindSqlJsStore(label: string, SQL: SqlJsModule, store: BindableStore): void {
  try {
    store.bindSqlite(openSqlJsConnection(SQL), { database: `sql.js:${label}` });
  } catch (error) {
    reportStoreDegradation({
      scope: `sqljs.bind.${label}`,
      group: 'sqljs.bind',
      context: 'failed to bind the store to sql.js; its reads are empty for the life of the page',
      error,
      extra: { label },
    });
  }
}

// Exported so the built declaration files keep these names in scope for the doc links above; an import that only a
// doc comment uses is dropped from them.
export type { SqliteConnection };
