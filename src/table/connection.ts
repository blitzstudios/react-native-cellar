/** The interface between the stores and the platform's SQLite driver. */

import { ShredSpec } from '../write/shred_spec';

/**
 * What a driver returns for one statement. Reading rows should go through {@linkcode readRows}, which unwraps the rows
 * and calls {@linkcode QueryExecResult.dispose | dispose}.
 */
export interface QueryExecResult {
  /** The result rows. */
  rows?: {
    /** The rows, as objects keyed by column. */
    _array?: unknown[];
  };
  /**
   * Each result column by name, with its position in the statement. Nitro reports it, and its row objects don't keep
   * the statement's column order, so this is the only way to know it there.
   */
  metadata?: Record<string, { index: number }>;
  /** Frees the result's native memory. */
  dispose?: () => void;
}

/**
 * A SQLite database handle, as Cellar uses it; a driver adapter implements this. Only
 * {@linkcode SqliteConnection.execute | execute} is required: each optional method is a faster path Cellar falls
 * back from when it's missing.
 */
export interface SqliteConnection {
  /** Runs one statement synchronously. */
  execute(sql: string, params?: ReadonlyArray<string | number | null>): QueryExecResult;
  /** Runs several statements in one transaction, synchronously. */
  executeBatch?(commands: ReadonlyArray<[string, ReadonlyArray<string | number | null>]>): void;
  /** Runs one statement off the JS thread. */
  executeAsync?(sql: string, params?: ReadonlyArray<string | number | null>): Promise<QueryExecResult>;
  /** Runs several statements in one transaction, off the JS thread. */
  executeBatchAsync?(commands: ReadonlyArray<[string, ReadonlyArray<string | number | null>]>): Promise<void>;
  /**
   * Parses a JSON response and writes its rows with a native shred program, off the JS thread; resolves to the number
   * of rows written.
   */
  shredJsonArrayAsync?(spec: ShredSpec, rawJson: string, binds: ReadonlyArray<string | number | null>): Promise<number>;
  /** A second, read-only handle to the same database, so reads can run while a write holds the main one. */
  reader?: PinnedConnection;
}

/** A connection with no separate reader, so every statement runs on this one handle and sees its `TEMP` tables. */
export type PinnedConnection = SqliteConnection & {
  /** Always absent. */
  readonly reader?: undefined;
};

/** The one handle to run reads on: the connection's reader if it has one, otherwise the connection itself. */
export function pinnedReader(conn: SqliteConnection): PinnedConnection {
  return conn.reader ?? { ...conn, reader: undefined };
}

/** One SQL statement and its parameters, as {@linkcode runBatch} takes them. */
export type BatchCommand = [string, ReadonlyArray<string | number | null>];

/**
 * Runs `commands` as one transaction, which is what makes a delete-then-insert replacement all-or-nothing. It holds
 * the JS thread for the length of the write, so anything ingest-sized wants {@linkcode runBatchAsync} instead.
 */
export function runBatch(conn: SqliteConnection, commands: ReadonlyArray<BatchCommand>): void {
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
export async function runBatchAsync(conn: SqliteConnection, commands: ReadonlyArray<BatchCommand>): Promise<void> {
  if (conn.executeBatchAsync) {
    await conn.executeBatchAsync(commands);
    return;
  }
  runBatch(conn, commands);
}

const EMPTY_RESULT: QueryExecResult = { rows: { _array: [] } };

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

/**
 * An error that says the storage under the connection failed, not the statement: the file, the disk, or memory.
 * Only these make the connection unusable; a statement that is wrong fails the same way on any connection.
 */
const STORAGE_FAILURE =
  /SQLITE_(?:IOERR|CORRUPT|NOTADB|FULL|CANTOPEN|NOMEM|READONLY)|disk I\/O error|database disk image is malformed|file is not a database|unable to open database|database or disk is full|out of memory/i;

/** A statement that only reads, whose failure can answer empty without leaving anything half-written behind. */
const READ_STATEMENT = /^\s*(?:SELECT|WITH)\b/i;

const messageOf = (error: unknown): string => String((error as { message?: unknown })?.message ?? error);

/**
 * Wraps `conn` so every statement returns. A read that fails on its own statement (a query bug, or a value its SQL
 * cannot parse) calls `onStatementError` and answers empty, and the connection carries on. Anything else fails the
 * connection: the first such failure calls `onFatal`, and later calls answer empty. A write fails it even for a bug
 * in its statement, since the rows it didn't write would otherwise stand behind an ETag that vouches for them.
 */
export function guardedConnection(
  conn: SqliteConnection,
  onFatal: (error: unknown, op: string) => void,
  onContended?: (error: unknown, op: string) => void,
  onStatementError?: (error: unknown, op: string) => void,
): SqliteConnection {
  let failed = false;
  let contended = 0;

  const trip = (error: unknown, op: string, isRead: boolean): void => {
    if (__DEV__) throw error;
    if (failed) return;
    const message = messageOf(error);
    if (CONTENTION.test(message)) {
      contended += 1;
      // Reported once: the first one says the connection is being shared by something that should not be sharing it,
      // and the rest say the same thing.
      if (contended === 1) onContended?.(error, op);
      if (contended < CONTENTION_TOLERANCE) return;
    } else if (isRead && !STORAGE_FAILURE.test(message)) {
      onStatementError?.(error, op);
      return;
    }
    failed = true;
    onFatal(error, op);
  };

  function guard<T>(op: string, run: () => T, benign: T, isRead = false): T {
    if (failed) return benign;
    try {
      return run();
    } catch (error) {
      trip(error, op, isRead);
      return benign;
    }
  }

  async function guardAsync<T>(op: string, run: () => Promise<T>, benign: T, isRead = false): Promise<T> {
    if (failed) return benign;
    try {
      return await run();
    } catch (error) {
      trip(error, op, isRead);
      return benign;
    }
  }

  const guarded: SqliteConnection = {
    execute: (sql, params) => guard('execute', () => conn.execute(sql, params), EMPTY_RESULT, READ_STATEMENT.test(sql)),
    executeBatch: conn.executeBatch && ((commands) => guard('executeBatch', () => conn.executeBatch!(commands), undefined)),
    executeAsync:
      conn.executeAsync && ((sql, params) => guardAsync('executeAsync', () => conn.executeAsync!(sql, params), EMPTY_RESULT, READ_STATEMENT.test(sql))),
    executeBatchAsync: conn.executeBatchAsync && ((commands) => guardAsync('executeBatchAsync', () => conn.executeBatchAsync!(commands), undefined)),
    // Deliberately unguarded: `shred` answers a rejection by parsing in JS, and swallowing one here into a resolved 0
    // would take that fallback away and degrade the store instead. A shred fails for two reasons, and letting it reject
    // is right for both — a payload the native shredder cannot handle is recovered by the JS parse, and a broken disk
    // trips this guard anyway on the writes that fallback issues, at the cost of one wasted parse.
    shredJsonArrayAsync: conn.shredJsonArrayAsync && ((spec, rawJson, binds) => (failed ? Promise.resolve(0) : conn.shredJsonArrayAsync!(spec, rawJson, binds))),
    reader: conn.reader && {
      execute: (sql, params) => guard('reader.execute', () => conn.reader!.execute(sql, params), EMPTY_RESULT, true),
      reader: undefined,
    },
  };
  return guarded;
}

/**
 * Runs a `SELECT` and returns its rows as plain objects. It runs on the connection's reader if it has one, so a query
 * of a `TEMP` table the caller just created must be passed a {@linkcode PinnedConnection}.
 */
export function readRows<T>(conn: SqliteConnection, sql: string, params?: ReadonlyArray<string | number | null>): T[] {
  const result = (conn.reader ?? conn).execute(sql, params);
  const rows = (result.rows?._array ?? []) as T[];
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
export function readRowsIn<T>(
  conn: SqliteConnection,
  sql: (placeholders: string) => string,
  values: ReadonlyArray<string | number>,
  opts: {
    before?: ReadonlyArray<string | number | null>;
    after?: ReadonlyArray<string | number | null>;
    chunk?: number;
  } = {},
): T[] {
  const before = opts.before ?? [];
  const after = opts.after ?? [];
  const size = Math.max(1, Math.min(opts.chunk ?? Infinity, MAX_BIND_PARAMS - before.length - after.length));
  const out: T[] = [];
  for (let start = 0; start < values.length; start += size) {
    const chunk = values.slice(start, start + size);
    const placeholders = chunk.map(() => '?').join(', ');
    for (const row of readRows<T>(conn, sql(placeholders), [...before, ...chunk, ...after])) out.push(row);
  }
  return out;
}
