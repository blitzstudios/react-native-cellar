/**
 * The {@linkcode SqliteConnection} for devices, over `react-native-nitro-sqlite`. It opens a store's database file,
 * sets the pragmas stores rely on, and passes native shreds to our fork's C++. A store whose file won't open is
 * reported rather than throwing, and runs on an in-memory database instead.
 */

import { NitroSQLite, open, openSecondary } from 'react-native-nitro-sqlite';

import { PinnedConnection, readRows, reportStoreDegradation, ShredSpec, SqliteConnection } from '../index';
import type { BindOptions, SqliteRecovery } from '../define_sqlite_store';

/** Matched verbatim by `sqliteExecute` in our `react-native-nitro-sqlite` fork (`cpp/shred.cpp`). */
const NITRO_SHRED_SENTINEL = '-- nitro_shred_v1';

function toNativeParams(params?: ReadonlyArray<unknown>): Array<string | number | null> | undefined {
  if (!params) return undefined;
  return params.map((value) => {
    if (value == null) return null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (typeof value === 'string' || typeof value === 'number') return value;
    return JSON.stringify(value);
  });
}

/**
 * Every connection this module has open, with the handles to close it by: nitro addresses a handle by name, not by
 * object.
 */
const openConnections = new Map<string, { conn: SqliteConnection; handles: ReadonlyArray<{ close(): void }> }>();

/** Every database connection this module has open, by name, such as for a dev tool that dumps them. */
export function getOpenSqliteConnections(): Array<{
  /** The database's name. */
  name: string;
  /** Its connection. */
  conn: SqliteConnection;
}> {
  return Array.from(openConnections, ([name, entry]) => ({ name, conn: entry.conn }));
}

/** Closes a database's connection and its reader, ignoring a handle that won't close. */
export function closeNitroConnection(name: string): void {
  const entry = openConnections.get(name);
  if (!entry) return;
  openConnections.delete(name);
  for (const handle of entry.handles) {
    try {
      handle.close();
    } catch {
      /* already gone, or never opened */
    }
  }
}

const PRAGMAS: ReadonlyArray<{ sql: string; cost: string }> = [
  { sql: 'PRAGMA journal_mode=WAL;', cost: 'DB stays on the slower default journal mode' },
  { sql: 'PRAGMA synchronous=NORMAL;', cost: 'writes fsync more often than they need to' },
  { sql: 'PRAGMA busy_timeout=5000;', cost: 'a contended write throws SQLITE_BUSY instead of waiting for the lock' },
  { sql: 'PRAGMA temp_store=MEMORY;', cost: "the ranker's temp tables can spill to a file instead of staying resident" },
  // Negative is KiB, and caps rather than reserves.
  { sql: 'PRAGMA cache_size=-8000;', cost: "the page cache stays at SQLite's 2MB default, so bulk ingests re-read index pages" },
];

function applyPragmas(conn: ReturnType<typeof open>, name: string): void {
  for (const pragma of PRAGMAS) {
    try {
      conn.execute(pragma.sql);
    } catch (error) {
      reportStoreDegradation({
        scope: `nitro_connection.pragma.${name}`,
        group: 'nitro_connection.pragma',
        context: `failed to apply \`${pragma.sql}\` — ${pragma.cost}`,
        error,
        extra: { connection: name, pragma: pragma.sql },
      });
    }
  }
}

/**
 * Shred specs already serialized. A store hands the same spec object to every ingest of a partition variant, and the
 * spec describes the schema rather than the body, so serializing it per call re-encodes a constant.
 */
const serializedSpecs = new WeakMap<ShredSpec, string>();

function serializeSpec(spec: ShredSpec): string {
  const cached = serializedSpecs.get(spec);
  if (cached !== undefined) {
    // Caching on identity assumes a spec is never edited after its first ingest. Nothing freezes them, so in dev the
    // assumption is checked rather than trusted: silently shredding against a stale spec writes the wrong columns.
    if (__DEV__ && JSON.stringify(spec) !== cached) {
      throw new Error(`nitro_connection: shred spec for '${spec.table}' was mutated after it was first serialized`);
    }
    return cached;
  }
  const json = JSON.stringify(spec);
  serializedSpecs.set(spec, json);
  return json;
}

/**
 * A batch command's params are either one bind list or a list of them, and nitro decodes an empty array as the list of
 * lists: zero executions, so the statement is silently dropped. A statement with nothing to bind has to send none.
 */
const toBatchCommand = ([query, params]: readonly [string, ReadonlyArray<unknown>?]) => ({
  query,
  params: params?.length ? toNativeParams(params) : undefined,
});

function adaptHandle(conn: ReturnType<typeof open>): PinnedConnection {
  return {
    execute: (sql, params) => conn.execute(sql, toNativeParams(params)),
    executeBatch: (commands) => {
      conn.executeBatch(commands.map(toBatchCommand));
    },
    executeAsync: (sql, params) => conn.executeAsync(sql, toNativeParams(params)),
    executeBatchAsync: async (commands) => {
      await conn.executeBatchAsync(commands.map(toBatchCommand));
    },
    // Nitro runs every batch statement through the path that recognizes the sentinel, and the shred's savepoint nests
    // inside the batch's transaction.
    shredBatchAsync: async (commands) => {
      await conn.executeBatchAsync(
        commands.map((command) =>
          Array.isArray(command)
            ? toBatchCommand(command)
            : { query: NITRO_SHRED_SENTINEL, params: toNativeParams([serializeSpec(command.shred), command.rawJson, ...command.binds]) },
        ),
      );
    },
  };
}

/** A handle name nitro still holds is reported this way; the message is the only thing that distinguishes it. */
function isHandleInUse(error: unknown): boolean {
  return String((error as { message?: unknown })?.message ?? error).includes('is already in use');
}

/**
 * Opens `name`'s dedicated reader, reclaiming the handle if a previous JS runtime left it open.
 *
 * {@linkcode closeNitroConnection} can only hand back handles this module's own map knows about, and that map lives in
 * the JS heap. An iOS CodePush reload replaces the JS runtime in the same native process, so the new runtime starts
 * with an empty map while nitro's registry still holds every handle the old one opened. The writer survives that,
 * because `open` addresses a database by name and re-registers it; a secondary handle's name is exclusive, so the
 * reader is the one that collides.
 *
 * Losing it is not the small thing it reads as. {@linkcode readRows} falls back to the writer handle, so the ranker's
 * multi statement `TEMP` work starts interleaving with an ingest's savepoint on one connection, SQLite refuses the
 * nested transaction, and each refusal sends the store through recovery: a reopen and a refetch of everything it holds.
 * So this tries hard: close the stale handle by name and retry, and failing that take a unique name, which cannot
 * collide with anything.
 */
function openReader(name: string): ReturnType<typeof openSecondary> | undefined {
  const preferred = `${name}:reader`;
  try {
    return openSecondary({ name, handle: preferred });
  } catch (error) {
    if (!isHandleInUse(error)) throw error;
  }

  // Addressed by name, which is how nitro identifies a connection — holding the original object is not required, and
  // after a reload there is no object to hold.
  try {
    NitroSQLite.native.close(preferred);
    return openSecondary({ name, handle: preferred });
  } catch {
    /* the stale handle would not close, or the retry lost the same race; fall through to a name of our own */
  }

  return openSecondary({ name, handle: `${preferred}:${Date.now().toString(36)}` });
}

/** Options for {@linkcode openNitroConnection}. */
export interface NitroConnectionOptions {
  /**
   * Also opens a second, read-only handle to the same database file, and runs reads on it, so a read doesn't wait for
   * a write in progress on the main handle (such as a large fetch being written).
   */
  dedicatedReader?: boolean;
  /**
   * Builds rows in JS instead of with the native JSON shredder. For a remote switch, since a response the native
   * shredder mishandles can't be fixed any other way.
   */
  shredInJs?: boolean;
}

/**
 * Opens a database file on the device as a {@linkcode SqliteConnection}, closing any connection already open under
 * `name`.
 */
export function openNitroConnection(name: string, opts?: NitroConnectionOptions): SqliteConnection {
  // Reopening a database this process already holds — a Fast Refresh re-running init, or a store rebound after a
  // schema change — has to hand the previous handles back first. Registering over them would leak them, and because a
  // secondary handle's name is exclusive, the reader is the one that would not come back.
  closeNitroConnection(name);

  const writer = open({ name });
  applyPragmas(writer, name);
  const handles: Array<{ close(): void }> = [writer];

  let reader: PinnedConnection | undefined;
  if (opts?.dedicatedReader) {
    try {
      const readHandle = openReader(name);
      if (readHandle) {
        applyPragmas(readHandle, `${name}:reader`);
        reader = adaptHandle(readHandle);
        handles.push(readHandle);
      }
    } catch (error) {
      reportStoreDegradation({
        scope: `nitro_connection.reader.${name}`,
        group: 'nitro_connection.reader',
        context:
          'failed to open the dedicated reader handle — reads fall back to the writer, where a read that needs a transaction can collide ' +
          'with an ingest and send the store through a reopen and a refetch',
        error,
        extra: { connection: name },
      });
    }
  }

  const { shredBatchAsync, ...writerHandle } = adaptHandle(writer);
  const adapted: SqliteConnection = { ...writerHandle, ...(opts?.shredInJs ? {} : { shredBatchAsync }), reader };
  openConnections.set(name, { conn: adapted, handles });
  openedDuringBind?.add(name);
  return adapted;
}

/**
 * Names opened by the bind currently running, tracked by what this attempt opened rather than by what was already
 * registered: a store re-initializing — a retry, or a Fast Refresh — opens a name that is *also* the one it held
 * before, and comparing registries would take that for a connection someone else owns and leave it open.
 */
let openedDuringBind: Set<string> | undefined;

/** Runs one bind attempt, and returns what it threw, having closed whatever the attempt had opened. */
function attemptBind(bind: () => void): unknown {
  const outer = openedDuringBind;
  const opened = new Set<string>();
  openedDuringBind = opened;
  try {
    bind();
    return undefined;
  } catch (error) {
    // A half-bound store would otherwise keep its handles for the life of the process, and a secondary handle's name is
    // exclusive: whatever opens next could not have its reader back, and would report a handle collision on top of the
    // failure that actually happened.
    for (const name of opened) closeNitroConnection(name);
    return error ?? new Error('bind failed');
  } finally {
    openedDuringBind = outer;
  }
}

/**
 * Deletes `name`'s database and the WAL files beside it, so the next open starts empty; a WAL left behind would replay
 * the old pages into the new file. Best effort per file: one that is not there is already what this wants.
 */
function discardNitroDatabase(name: string): void {
  closeNitroConnection(name);
  for (const file of [name, `${name}-wal`, `${name}-shm`]) {
    try {
      NitroSQLite.native.drop(file);
    } catch {
      /* not there, or not removable; the open that follows says which */
    }
  }
}

/** A store, as far as binding it needs. */
interface BindableStore {
  /** Moves the store onto a connection. */
  bindSqlite: (conn: SqliteConnection, options?: BindOptions) => void;
}

interface StoreBinding {
  label: string;
  dbName: string;
  store: BindableStore;
  opts: NitroConnectionOptions;
}

/** Stores off their database file — on the in-memory fallback, or unbound — by database name. */
const offFile = new Map<string, StoreBinding>();
const retriesByDb = new Map<string, number>();
/**
 * Each retry that fails again costs a full refetch of the store, so a database that never opens stops being retried.
 */
const MAX_RETRIES = 3;

/**
 * Opens the in-memory database a store falls back to, where its `TEMP` tables hold the store's rows: the private one
 * nitro opens for `:memory:<dbName>`, which needs no file. It has no separate reader, since `TEMP` tables are visible
 * only to their own connection.
 */
export function openNitroMemoryFallback(dbName: string, opts?: Pick<NitroConnectionOptions, 'shredInJs'>): SqliteConnection {
  const name = `:memory:${dbName}`;
  // Also closes one a previous JS runtime left open under this name, which would otherwise keep its rows in memory.
  discardNitroDatabase(name);
  return openNitroConnection(name, { shredInJs: opts?.shredInJs });
}

function recoveryFor(binding: StoreBinding): SqliteRecovery {
  return {
    reopen: ({ discard }) => {
      if (discard) discardNitroDatabase(binding.dbName);
      return openNitroConnection(binding.dbName, binding.opts);
    },
    fallback: () => openNitroMemoryFallback(binding.dbName, binding.opts),
    onLeftFile: () => offFile.set(binding.dbName, binding),
  };
}

const messageOf = (error: unknown): string => String((error as { message?: unknown })?.message ?? error);

/** Options for {@linkcode bindSqliteStore}. */
export interface BindSqliteStoreOptions extends NitroConnectionOptions {
  /** Runs the store on an in-memory database without opening its file, as a kill switch. */
  inMemory?: boolean;
}

/**
 * Opens the database file `dbName` and binds `store` to it, at app startup; `label` names the store in reports. If the
 * file won't open, it is deleted and opened again from empty, since it only caches server data. If that fails too, the
 * store runs on an in-memory database until {@linkcode retrySqliteStores} gets it back on the file. A failure later in
 * the session reopens the database, and otherwise moves the store to the in-memory database.
 */
export function bindSqliteStore(label: string, dbName: string, store: BindableStore, opts: BindSqliteStoreOptions = {}): void {
  const binding: StoreBinding = { label, dbName, store, opts: { dedicatedReader: opts.dedicatedReader, shredInJs: opts.shredInJs } };
  const recovery = recoveryFor(binding);
  const bindInMemory = () => store.bindSqlite(openNitroMemoryFallback(dbName, binding.opts), { temporary: true, startup: true, database: dbName, recovery: { reopen: recovery.reopen } });

  if (opts.inMemory) {
    const error = attemptBind(bindInMemory);
    if (error !== undefined) {
      reportStoreDegradation({
        scope: `nitro_connection.bind_in_memory.${label}`,
        group: 'nitro_connection.bind_in_memory',
        context: 'the store was asked to run in memory, and its in-memory database would not open; its reads are empty this session',
        error,
        extra: { label },
      });
    }
    return;
  }

  const bind = () => store.bindSqlite(openNitroConnection(dbName, binding.opts), { recovery, startup: true, database: dbName });
  const firstError = attemptBind(bind);
  if (firstError === undefined) return;

  discardNitroDatabase(dbName);
  const secondError = attemptBind(bind);
  if (secondError === undefined) {
    reportStoreDegradation({
      scope: `nitro_connection.bind_fresh.${label}`,
      context: 'failed to bind SQLite, then bound after deleting the database — the store starts empty and refetches',
      error: firstError,
      extra: { label },
      severity: 'info',
    });
    return;
  }

  offFile.set(dbName, binding);
  const memoryError = attemptBind(bindInMemory);
  reportStoreDegradation({
    scope: `nitro_connection.bind.${label}`,
    group: 'nitro_connection.bind',
    context:
      memoryError === undefined
        ? 'failed to bind SQLite, and again after deleting the database — the store runs on its in-memory database until a retry binds it'
        : 'failed to bind SQLite, again after deleting the database, and to open its in-memory database — its reads are empty until a retry binds it',
    error: firstError,
    extra: { label, afterDeleting: messageOf(secondError), ...(memoryError === undefined ? {} : { inMemory: messageOf(memoryError) }) },
  });
}

/**
 * Tries to move every store running off its database file back onto it, up to 3 times per database. Call it when the
 * app returns to the foreground: a launch in the background before the device's first unlock can't open files, which
 * later works.
 */
export function retrySqliteStores(): void {
  for (const [dbName, binding] of offFile) {
    const retries = (retriesByDb.get(dbName) ?? 0) + 1;
    if (retries > MAX_RETRIES) continue;
    retriesByDb.set(dbName, retries);
    const error = attemptBind(() => binding.store.bindSqlite(openNitroConnection(dbName, binding.opts), { recovery: recoveryFor(binding), database: dbName }));
    if (error !== undefined) continue;
    offFile.delete(dbName);
    reportStoreDegradation({
      scope: `nitro_connection.rebound.${binding.label}`,
      context: 'a store that was off its database file is back on it, and refetches into it',
      extra: { label: binding.label, retries },
      severity: 'info',
    });
  }
}

// Exported so the built declaration files keep these names in scope for the doc links above; an import that only a
// doc comment uses is dropped from them.
export type { SqliteConnection, readRows };
