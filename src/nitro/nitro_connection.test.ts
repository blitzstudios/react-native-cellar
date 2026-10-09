import { NitroSQLite, open, openSecondary } from 'react-native-nitro-sqlite';

import { configureCellar } from '../index';
import { resetOnceGuards } from '../diagnostics/once_guard';
import { bindSqliteStore, getOpenSqliteConnections, openNitroConnection, retrySqliteStores } from './nitro_connection';

jest.mock('react-native-nitro-sqlite', () => ({ open: jest.fn(), openSecondary: jest.fn(), NitroSQLite: { native: { close: jest.fn(), drop: jest.fn() } } }));

const mockOpen = open as jest.MockedFunction<typeof open>;
const mockOpenSecondary = openSecondary as jest.MockedFunction<typeof openSecondary>;
const mockNativeClose = NitroSQLite.native.close as jest.MockedFunction<typeof NitroSQLite.native.close>;
/** What nitro throws when a secondary handle's name is still registered — the only marker that says so. */
const handleInUse = () => new Error("handle 'things:reader' is already in use by an open connection");
const captureException = jest.fn();
const captureMessage = jest.fn();
configureCellar({ errors: { captureException, captureMessage } });

/** What the adapter reported: the scope it filed under, and the context line it filed. */
function lastReport(): { scope: string; context: string } {
  const [, captureContext] = captureException.mock.calls[captureException.mock.calls.length - 1];
  return { scope: String(captureContext.tags.cellar_degradation), context: String(captureContext.extra.context) };
}

interface FakeHandle {
  executed: Array<{ sql: string; params?: unknown[] }>;
  batches: unknown[][];
  execute: jest.Mock;
  executeAsync: jest.Mock;
  executeBatch: jest.Mock;
  executeBatchAsync: jest.Mock;
  close: jest.Mock;
}

function fakeHandle(opts: { failOn?: string; asyncResult?: unknown } = {}): FakeHandle {
  const executed: Array<{ sql: string; params?: unknown[] }> = [];
  const batches: unknown[][] = [];
  const record = (sql: string, params?: unknown[]) => {
    executed.push({ sql, params });
    if (opts.failOn && sql.includes(opts.failOn)) throw new Error(`cannot apply ${sql}`);
    return { rows: { _array: [] } };
  };
  return {
    executed,
    batches,
    execute: jest.fn(record),
    executeAsync: jest.fn((sql: string, params?: unknown[]) => {
      record(sql, params);
      return Promise.resolve(opts.asyncResult ?? { rows: { _array: [] } });
    }),
    executeBatch: jest.fn((cmds: unknown[]) => {
      batches.push(cmds);
    }),
    executeBatchAsync: jest.fn((cmds: unknown[]) => {
      batches.push(cmds);
      return Promise.resolve();
    }),
    close: jest.fn(),
  };
}

const sqlOf = (handle: FakeHandle) => handle.executed.map((command) => command.sql);

let warn: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  // Each report is filed once per scope per session, and these tests reuse scopes.
  resetOnceGuards();
  warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => warn.mockRestore());

describe('openNitroConnection — pragmas', () => {
  it('applies the settings the store depends on', () => {
    const handle = fakeHandle();
    mockOpen.mockReturnValue(handle as never);

    openNitroConnection('things');

    expect(sqlOf(handle)).toEqual([
      'PRAGMA journal_mode=WAL;',
      'PRAGMA synchronous=NORMAL;',
      'PRAGMA busy_timeout=5000;',
      'PRAGMA temp_store=MEMORY;',
      'PRAGMA cache_size=-8000;',
    ]);
  });

  it('keeps applying the rest after one fails, so a failed journal_mode cannot swallow busy_timeout', () => {
    const handle = fakeHandle({ failOn: 'journal_mode' });
    mockOpen.mockReturnValue(handle as never);

    openNitroConnection('things');

    expect(sqlOf(handle)).toContain('PRAGMA busy_timeout=5000;');
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it('names the setting that failed and what its absence costs, since neither is recoverable from the error', () => {
    mockOpen.mockReturnValue(fakeHandle({ failOn: 'busy_timeout' }) as never);

    openNitroConnection('things');

    const report = lastReport();
    expect(report.scope).toBe('nitro_connection.pragma.things');
    expect(report.context).toContain('PRAGMA busy_timeout=5000;');
    expect(report.context).toContain('SQLITE_BUSY');
  });
});

describe('openNitroConnection — the dedicated read handle', () => {
  it('opens no second handle unless asked, and reads then share the writer', () => {
    mockOpen.mockReturnValue(fakeHandle() as never);

    const conn = openNitroConnection('things');

    expect(mockOpenSecondary).not.toHaveBeenCalled();
    expect(conn.reader).toBeUndefined();
  });

  it('opens the reader against the same database under its own handle name, with the same pragmas', () => {
    const writer = fakeHandle();
    const reader = fakeHandle();
    mockOpen.mockReturnValue(writer as never);
    mockOpenSecondary.mockReturnValue(reader as never);

    const conn = openNitroConnection('things', { dedicatedReader: true });

    expect(mockOpenSecondary).toHaveBeenCalledWith({ name: 'things', handle: 'things:reader' });
    expect(sqlOf(reader)).toEqual(sqlOf(writer));
    expect(conn.reader).toBeDefined();
  });

  it('is a pinned handle, so nothing can route off it a second time', () => {
    mockOpen.mockReturnValue(fakeHandle() as never);
    mockOpenSecondary.mockReturnValue(fakeHandle() as never);

    const conn = openNitroConnection('things', { dedicatedReader: true });

    expect(conn.reader?.reader).toBeUndefined();
  });

  it('degrades to sharing the writer when the second handle will not open, rather than failing the store', () => {
    mockOpen.mockReturnValue(fakeHandle() as never);
    mockOpenSecondary.mockImplementation(() => {
      throw new Error('too many handles');
    });

    const conn = openNitroConnection('things', { dedicatedReader: true });

    expect(conn.reader).toBeUndefined();
    expect(conn.execute).toBeDefined();
    expect(lastReport().context).toContain('a reopen and a refetch');
  });

  // An iOS CodePush reload replaces the JS runtime inside the running process, so `openConnections` comes back empty
  // while nitro still holds every handle the previous runtime opened. The writer re-registers by name; the reader is
  // the one whose name is exclusive, and losing it is what puts the store's whole working set back on the JS heap.
  it('reclaims a reader handle a previous JS runtime left open, rather than giving it up', () => {
    mockOpen.mockReturnValue(fakeHandle() as never);
    const reader = fakeHandle();
    mockOpenSecondary.mockImplementationOnce(() => {
      throw handleInUse();
    });
    mockOpenSecondary.mockReturnValue(reader as never);

    const conn = openNitroConnection('things', { dedicatedReader: true });

    expect(mockNativeClose).toHaveBeenCalledWith('things:reader');
    expect(mockOpenSecondary).toHaveBeenLastCalledWith({ name: 'things', handle: 'things:reader' });
    expect(conn.reader).toBeDefined();
    expect(captureException).not.toHaveBeenCalled();
  });

  it('takes a handle name of its own when the stale one will not close, which cannot collide either', () => {
    mockOpen.mockReturnValue(fakeHandle() as never);
    const reader = fakeHandle();
    mockOpenSecondary.mockImplementationOnce(() => {
      throw handleInUse();
    });
    mockOpenSecondary.mockReturnValue(reader as never);
    mockNativeClose.mockImplementationOnce(() => {
      throw new Error('not ours to close');
    });

    const conn = openNitroConnection('things', { dedicatedReader: true });

    expect(conn.reader).toBeDefined();
    expect(String(mockOpenSecondary.mock.lastCall?.[0].handle)).toMatch(/^things:reader:.+/);
    expect(captureException).not.toHaveBeenCalled();
  });
});

describe('openNitroConnection — parameter coercion', () => {
  const paramsOf = (handle: FakeHandle) => handle.executed[handle.executed.length - 1].params;

  it('narrows the JS values a caller can hold to the three the bridge takes', () => {
    const handle = fakeHandle();
    mockOpen.mockReturnValue(handle as never);
    const conn = openNitroConnection('things');

    conn.execute('SELECT ?, ?, ?, ?, ?;', [true, false, null, 'a', 2] as never);

    // SQLite has no boolean type; an uncoerced one binds as `null`.
    expect(paramsOf(handle)).toEqual([1, 0, null, 'a', 2]);
  });

  it('passes no params at all through as undefined, rather than as an empty bind list', () => {
    const handle = fakeHandle();
    mockOpen.mockReturnValue(handle as never);

    openNitroConnection('things').execute('SELECT 1;');

    expect(paramsOf(handle)).toBeUndefined();
  });

  it('coerces batch params too, which are the ones an ingest binds by the thousand', () => {
    const handle = fakeHandle();
    mockOpen.mockReturnValue(handle as never);
    const conn = openNitroConnection('things');

    conn.executeBatch?.([['INSERT INTO t VALUES (?, ?);', [true, null] as never]]);

    expect(handle.batches[0]).toEqual([{ query: 'INSERT INTO t VALUES (?, ?);', params: [1, null] }]);
  });

  // Nitro reads `[]` as zero rows of a batch update and runs the statement zero times; a batch of nothing but those
  // reaches the driver empty and throws `NoBatchCommandsProvided`.
  it('sends a batch statement with nothing to bind as having no params, so the driver runs it', async () => {
    const handle = fakeHandle();
    mockOpen.mockReturnValue(handle as never);
    const conn = openNitroConnection('things');
    const commands: Array<[string, Array<string | number | null>]> = [
      ['CREATE TABLE IF NOT EXISTS temp.t (a);', []],
      ['DELETE FROM temp.t WHERE a = ?;', [1]],
    ];

    conn.executeBatch?.(commands);
    await conn.executeBatchAsync?.(commands);

    for (const batch of handle.batches) {
      expect(batch).toEqual([
        { query: 'CREATE TABLE IF NOT EXISTS temp.t (a);', params: undefined },
        { query: 'DELETE FROM temp.t WHERE a = ?;', params: [1] },
      ]);
    }
    expect(handle.batches).toHaveLength(2);
  });
});

describe('openNitroConnection — shredBatchAsync', () => {
  const spec = {
    version: 1 as const,
    table: 'things',
    insertVerb: 'INSERT OR REPLACE' as const,
    columns: ['id'],
    ops: [{ op: 'text' as const, path: 'id' }],
    deleteWhere: [{ column: 'scope', bindIndex: 0 }],
  };

  it('sends a shred as the sentinel the C++ fork matches, with the spec, the payload, then the binds, in one batch with the statements around it', async () => {
    const handle = fakeHandle();
    mockOpen.mockReturnValue(handle as never);

    await openNitroConnection('things').shredBatchAsync!([
      ['DELETE FROM temp.stage;', []],
      { shred: spec, rawJson: '[{"id":"a"}]', binds: ['s'] },
      ['INSERT INTO t SELECT * FROM temp.stage WHERE scope = ?;', ['s']],
    ]);

    expect(handle.executeAsync).not.toHaveBeenCalled();
    expect(handle.batches).toEqual([
      [
        { query: 'DELETE FROM temp.stage;', params: undefined },
        { query: '-- nitro_shred_v1', params: [JSON.stringify(spec), '[{"id":"a"}]', 's'] },
        { query: 'INSERT INTO t SELECT * FROM temp.stage WHERE scope = ?;', params: ['s'] },
      ],
    ]);
  });

  it('leaves the shred out of a connection that shreds in JS', () => {
    mockOpen.mockReturnValue(fakeHandle() as never);
    expect(openNitroConnection('things', { shredInJs: true }).shredBatchAsync).toBeUndefined();
  });
});

describe('binding a store', () => {
  it('keeps the app running when every bind throws, and reports that the store reads empty', () => {
    mockOpen.mockReturnValue(fakeHandle() as never);
    const store = {
      bindSqlite: () => {
        throw new Error('no such file or directory');
      },
    };

    expect(() => bindSqliteStore('leaderboard', 'metrics.db', store)).not.toThrow();
    expect(lastReport().context).toContain('reads are empty');
  });

  it('opens the database and binds the store to the connection', () => {
    mockOpen.mockReturnValue(fakeHandle() as never);
    mockOpenSecondary.mockReturnValue(fakeHandle() as never);
    const store = { bindSqlite: jest.fn() };

    bindSqliteStore('leaderboard', 'metrics.db', store, { dedicatedReader: true });

    expect(mockOpen).toHaveBeenCalledWith({ name: 'metrics.db' });
    expect(mockOpenSecondary).toHaveBeenCalled();
    expect(store.bindSqlite).toHaveBeenCalledWith(
      expect.objectContaining({ execute: expect.any(Function) }),
      expect.objectContaining({ startup: true, recovery: expect.objectContaining({ reopen: expect.any(Function), fallback: expect.any(Function) }) }),
    );
  });

  it('registers the connection under its database name, which is what the dev overlay dumps', () => {
    mockOpen.mockReturnValue(fakeHandle() as never);

    const conn = openNitroConnection('registered.db');

    expect(getOpenSqliteConnections()).toContainEqual({ name: 'registered.db', conn });
  });
});

/**
 * A secondary handle's name is exclusive for the life of the process, so handles a failed bind opened are not merely
 * untidy: they are what makes the *next* attempt — a retry, or a Fast Refresh re-running the same init — report a
 * handle collision on top of the failure that actually happened.
 */
describe('binding a store — the handles a failure opened', () => {
  const failingBind = (name: string, writer: FakeHandle, reader: FakeHandle) => {
    mockOpen.mockReturnValue(writer as never);
    mockOpenSecondary.mockReturnValue(reader as never);
    const store = {
      bindSqlite: () => {
        throw new Error('a schema change forces a rebuild');
      },
    };
    bindSqliteStore('metrics', name, store, { dedicatedReader: true });
  };

  it('closes both of them after each attempt, handing back the names the next attempt has to open', () => {
    const writer = fakeHandle();
    const reader = fakeHandle();

    failingBind('metrics.db', writer, reader);

    // Three attempts, each closing its own: the file, the file again after deleting it, and then the in-memory
    // fallback, which opens a writer and no reader.
    expect(writer.close).toHaveBeenCalledTimes(3);
    expect(reader.close).toHaveBeenCalledTimes(2);
  });

  it('forgets the connection, so nothing later reads through a handle that is closed', () => {
    failingBind('metrics.db', fakeHandle(), fakeHandle());

    expect(getOpenSqliteConnections().map((entry) => entry.name)).not.toContain('metrics.db');
  });

  it('still reports the failure that started it, which is the one worth reading', () => {
    failingBind('metrics.db', fakeHandle(), fakeHandle());

    expect(lastReport().scope).toBe('nitro_connection.bind.metrics');
    expect(lastReport().context).toContain('reads are empty');
  });

  it('leaves a connection another store already had open alone', () => {
    const other = fakeHandle();
    mockOpen.mockReturnValue(other as never);
    openNitroConnection('schedule.db');

    failingBind('metrics.db', fakeHandle(), fakeHandle());

    expect(other.close).not.toHaveBeenCalled();
    expect(getOpenSqliteConnections().map((entry) => entry.name)).toContain('schedule.db');
  });

  it('closes the reopened handles of a store that had already bound this database once, which is the Fast Refresh case', () => {
    mockOpen.mockReturnValue(fakeHandle() as never);
    mockOpenSecondary.mockReturnValue(fakeHandle() as never);
    openNitroConnection('again.db', { dedicatedReader: true });

    const writer = fakeHandle();
    const reader = fakeHandle();
    failingBind('again.db', writer, reader);

    expect(writer.close).toHaveBeenCalledTimes(3);
    expect(reader.close).toHaveBeenCalledTimes(2);
    expect(getOpenSqliteConnections().map((entry) => entry.name)).not.toContain('again.db');
  });

  it('closes nothing when the bind succeeds, which is the whole point of holding the handles', () => {
    const writer = fakeHandle();
    mockOpen.mockReturnValue(writer as never);

    bindSqliteStore('metrics', 'kept.db', { bindSqlite: () => {} });

    expect(writer.close).not.toHaveBeenCalled();
    expect(getOpenSqliteConnections().map((entry) => entry.name)).toContain('kept.db');
  });
});

/**
 * The bind that *succeeds* and then runs again is the ordinary case in development, and it is the one that leaked:
 * the second open registered over the first entry without closing it, so the reader name stayed taken and the store
 * spent the rest of the session reading through the writer handle, contending with its own ingests.
 */
describe('reopening a database this process already holds', () => {
  /** Secondary handle names nitro is currently holding. Claiming one twice is what throws on the device. */
  let taken: Set<string>;
  /** Every handle the fake driver has handed out, newest last, since the point at issue is which ones get closed. */
  let writers: FakeHandle[];
  let readers: FakeHandle[];

  beforeEach(() => {
    taken = new Set();
    writers = [];
    readers = [];
    mockOpen.mockImplementation((() => {
      const handle = fakeHandle();
      writers.push(handle);
      return handle;
    }) as never);
    mockOpenSecondary.mockImplementation((({ handle }: { handle: string }) => {
      if (taken.has(handle)) throw new Error(`NitroSQLite.openSecondary(...): handle '${handle}' is already in use by an open connection`);
      taken.add(handle);
      const opened = fakeHandle();
      opened.close.mockImplementation(() => taken.delete(handle));
      readers.push(opened);
      return opened;
    }) as never);
  });

  const openWithReader = (name: string) => openNitroConnection(name, { dedicatedReader: true });

  it('closes the handles it held, rather than registering over them', () => {
    openWithReader('reopened.db');

    openWithReader('reopened.db');

    expect(writers[0].close).toHaveBeenCalledTimes(1);
    expect(readers[0].close).toHaveBeenCalledTimes(1);
  });

  it('gets its dedicated reader back, instead of degrading to the writer for the rest of the session', () => {
    openWithReader('reopened.db');

    const second = openWithReader('reopened.db');

    expect(second.reader).toBeDefined();
    expect(captureException).not.toHaveBeenCalled();
  });

  it('leaves a database another store has open alone', () => {
    openWithReader('untouched.db');

    openWithReader('reopened.db');

    expect(writers[0].close).not.toHaveBeenCalled();
    expect(readers[0].close).not.toHaveBeenCalled();
    expect(getOpenSqliteConnections().map((entry) => entry.name)).toContain('untouched.db');
  });
});

describe('binding a store — getting SQLite back', () => {
  const mockDrop = NitroSQLite.native.drop as jest.MockedFunction<typeof NitroSQLite.native.drop>;
  const lastMessage = () => {
    const calls = captureMessage.mock.calls;
    return String(calls[calls.length - 1]?.[0] ?? '');
  };

  beforeEach(() => {
    mockOpen.mockReturnValue(fakeHandle() as never);
    mockOpenSecondary.mockReturnValue(fakeHandle() as never);
    mockDrop.mockClear();
  });

  it('retries a failed bind once on a deleted database, WAL files and all', () => {
    const bindSqlite = jest.fn().mockImplementationOnce(() => {
      throw new Error('file is not a database');
    });

    bindSqliteStore('fresh', 'fresh.db', { bindSqlite });

    expect(bindSqlite).toHaveBeenCalledTimes(2);
    expect(mockDrop.mock.calls.map(([file]) => file)).toEqual(['fresh.db', 'fresh.db-wal', 'fresh.db-shm']);
    expect(getOpenSqliteConnections().map((entry) => entry.name)).toContain('fresh.db');
    expect(lastMessage()).toContain('nitro_connection.bind_fresh.fresh');
  });

  it('runs a store whose file will not bind on its in-memory database, as temp tables with temp_store in memory', () => {
    const memory = fakeHandle();
    mockOpen.mockImplementation(({ name }: { name: string }) => (name.startsWith(':memory:') ? memory : fakeHandle()) as never);
    const bindSqlite = jest.fn().mockImplementationOnce(() => {
      throw new Error('disk I/O error');
    }).mockImplementationOnce(() => {
      throw new Error('disk I/O error');
    });

    bindSqliteStore('memory', 'memory.db', { bindSqlite });

    expect(bindSqlite).toHaveBeenCalledTimes(3);
    expect(bindSqlite.mock.calls[2][1]).toEqual(expect.objectContaining({ temporary: true, startup: true }));
    expect(sqlOf(memory)).toContain('PRAGMA temp_store=MEMORY;');
    expect(getOpenSqliteConnections().map((entry) => entry.name)).toContain(':memory:memory.db');
    expect(lastMessage()).toContain('runs on its in-memory database');
    mockOpen.mockReset();
  });

  it('runs a store on its in-memory database without touching the file when asked to, which is the kill switch', () => {
    const bindSqlite = jest.fn();

    bindSqliteStore('switched', 'switched.db', { bindSqlite }, { inMemory: true });

    expect(mockOpen.mock.calls.map(([options]) => (options as { name: string }).name)).toEqual([':memory:switched.db']);
    expect(bindSqlite.mock.calls[0][0]).toEqual(expect.objectContaining({ reader: undefined }));
    expect(bindSqlite.mock.calls[0][1]).toEqual(expect.objectContaining({ temporary: true }));
    expect(getOpenSqliteConnections().map((entry) => entry.name)).toContain(':memory:switched.db');
  });

  it('closes the in-memory database a previous JS runtime left open under the name, so its rows do not survive', () => {
    const left = fakeHandle();
    mockOpen.mockReturnValueOnce(left as never);
    openNitroConnection(':memory:reloaded.db');

    bindSqliteStore('reloaded', 'reloaded.db', { bindSqlite: jest.fn() }, { inMemory: true });

    expect(left.close).toHaveBeenCalledTimes(1);
    expect(getOpenSqliteConnections().map((entry) => entry.name)).toContain(':memory:reloaded.db');
  });

  it('ingests through the JS row builders when asked to: on the file, on a reopen, and on the in-memory database', () => {
    const bindSqlite = jest.fn();
    bindSqliteStore('js', 'js.db', { bindSqlite }, { shredInJs: true });
    const [conn, { recovery }] = bindSqlite.mock.calls[0];

    expect(conn.shredBatchAsync).toBeUndefined();
    expect(recovery.reopen({ discard: false }).shredBatchAsync).toBeUndefined();
    expect(recovery.fallback().shredBatchAsync).toBeUndefined();

    const switched = jest.fn();
    bindSqliteStore('js-memory', 'js-memory.db', { bindSqlite: switched }, { inMemory: true, shredInJs: true });
    expect(switched.mock.calls[0][0].shredBatchAsync).toBeUndefined();
  });

  it('keeps the native shred on a connection by default', () => {
    const bindSqlite = jest.fn();
    bindSqliteStore('native', 'native.db', { bindSqlite });
    const [conn, { recovery }] = bindSqlite.mock.calls[0];

    expect(conn.shredBatchAsync).toEqual(expect.any(Function));
    expect(recovery.fallback().shredBatchAsync).toEqual(expect.any(Function));
  });

  it('hands the store a reopen that deletes the database only when asked to', () => {
    const bindSqlite = jest.fn();
    bindSqliteStore('reopening', 'reopening.db', { bindSqlite });
    const { recovery } = bindSqlite.mock.calls[0][1];

    recovery.reopen({ discard: false });
    expect(mockDrop).not.toHaveBeenCalled();
    recovery.reopen({ discard: true });
    expect(mockDrop.mock.calls.map(([file]) => file)).toEqual(['reopening.db', 'reopening.db-wal', 'reopening.db-shm']);
  });

  it('moves a store that never bound back onto its file when the app retries, and then stops retrying it', () => {
    let failing = true;
    const bindSqlite = jest.fn(() => {
      if (failing) throw new Error('unable to open database file');
    });
    bindSqliteStore('locked', 'locked.db', { bindSqlite });
    const bindsAtStartup = bindSqlite.mock.calls.length;
    failing = false;

    retrySqliteStores();
    retrySqliteStores();

    expect(bindSqlite.mock.calls.length - bindsAtStartup).toBe(1);
    expect(bindSqlite).toHaveBeenLastCalledWith(expect.objectContaining({ execute: expect.any(Function) }), expect.objectContaining({ recovery: expect.anything() }));
    expect(lastMessage()).toContain('nitro_connection.rebound.locked');
  });

  it('retries a store that left its file mid-session', () => {
    const bindSqlite = jest.fn();
    bindSqliteStore('left', 'left.db', { bindSqlite });

    bindSqlite.mock.calls[0][1].recovery.onLeftFile();
    retrySqliteStores();

    expect(bindSqlite).toHaveBeenCalledTimes(2);
  });

  it('stops retrying a database that never opens, since each attempt costs the store a refetch', () => {
    const bindSqlite = jest.fn(() => {
      throw new Error('unable to open database file');
    });
    bindSqliteStore('never', 'never.db', { bindSqlite });
    const bindsAtStartup = bindSqlite.mock.calls.length;

    for (let attempt = 0; attempt < 6; attempt += 1) retrySqliteStores();

    expect(bindSqlite.mock.calls.length - bindsAtStartup).toBe(3);
  });
});
