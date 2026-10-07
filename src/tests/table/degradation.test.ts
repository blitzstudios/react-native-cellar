import { RowTableSchema } from '../../table/types';
import { createSqliteRowTable } from '../../table/sqlite';
import { defineSqliteStore } from '../../define_sqlite_store';
import { itDev, itProd } from '../../testing/dev_mode';
import { resetOnceGuards } from '../../diagnostics/once_guard';
import { guardedConnection, readRows, runBatch, SqliteConnection } from '../../table/connection';

type Thing = { id: string; region: string };

const schema: RowTableSchema<Thing> = {
  table: 'things',
  columns: { id: { type: 'TEXT' }, region: { type: 'TEXT' } },
  primaryKey: ['id'],
  entityId: 'id',
};

function brokenConn(match = /./): SqliteConnection & { attempts: number } {
  const conn = {
    attempts: 0,
    execute: (sql: string) => {
      conn.attempts += 1;
      if (match.test(sql)) throw new Error('SQLITE_IOERR: disk I/O error');
      return { rows: { _array: [] } };
    },
  };
  return conn as SqliteConnection & { attempts: number };
}

const flushMicrotasks = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

beforeEach(() => {
  resetOnceGuards();
});

describe('guardedConnection', () => {
  itProd('answers a failed read the way an empty store would, rather than throwing into render', () => {
    const conn = guardedConnection(brokenConn(), () => {});
    expect(readRows(conn, 'SELECT * FROM things;')).toEqual([]);
  });

  itProd('reports the failure once and stops touching the driver, since the next statement fails the same way', () => {
    const broken = brokenConn();
    const onFatal = jest.fn();
    const conn = guardedConnection(broken, onFatal);

    for (let index = 0; index < 5; index += 1) readRows(conn, 'SELECT * FROM things;');

    expect(onFatal).toHaveBeenCalledTimes(1);
    expect(broken.attempts).toBe(1);
  });

  // Contention says another statement held the connection, not that the database is gone: the next one on an idle
  // connection works. Calling it fatal costs the store's whole working set, which moves onto the JS heap for the
  // session — a far worse trade than retrying the ingest that lost.
  itProd('absorbs a contended statement instead of degrading, since the database itself is fine', () => {
    const contended = brokenConn(/nothing/);
    contended.execute = () => {
      throw new Error('cannot start a transaction within a transaction');
    };
    const onFatal = jest.fn();
    const conn = guardedConnection(contended, onFatal);

    for (let index = 0; index < 3; index += 1) conn.execute('SELECT 1;');

    expect(onFatal).not.toHaveBeenCalled();
  });

  itProd('gives up on a run of them, which is no longer one unlucky interleave', () => {
    const contended = brokenConn(/nothing/);
    contended.execute = () => {
      throw new Error('cannot start a transaction within a transaction');
    };
    const onFatal = jest.fn();
    const onContended = jest.fn();
    const conn = guardedConnection(contended, onFatal, onContended);

    for (let index = 0; index < 8; index += 1) conn.execute('SELECT 1;');

    expect(onFatal).toHaveBeenCalledTimes(1);
    // Once: the first says the connection is being shared by something that should not be, and the rest repeat it.
    expect(onContended).toHaveBeenCalledTimes(1);
  });

  itProd('still degrades on the first failure that is not contention, which no retry would recover', () => {
    const onFatal = jest.fn();
    const conn = guardedConnection(brokenConn(), onFatal);

    conn.execute('SELECT * FROM things;');

    expect(onFatal).toHaveBeenCalledTimes(1);
  });

  // A read's own statement failing says nothing about the connection: the same SQL fails the same way on any of them,
  // and every other read still works. Degrading for it costs every user the store.
  itProd('answers a read whose statement fails empty, reports it, and keeps the connection', () => {
    const buggy: SqliteConnection = {
      execute: (sql) => {
        if (sql.includes('no_such_column')) throw new Error('SQLITE_ERROR: no such column: no_such_column');
        return { rows: { _array: [{ id: 'a' }] } };
      },
    };
    const onFatal = jest.fn();
    const onStatementError = jest.fn();
    const conn = guardedConnection(buggy, onFatal, undefined, onStatementError);

    expect(readRows(conn, 'SELECT no_such_column FROM things;')).toEqual([]);
    expect(readRows(conn, 'SELECT * FROM things;')).toEqual([{ id: 'a' }]);
    expect(onFatal).not.toHaveBeenCalled();
    expect(onStatementError).toHaveBeenCalledTimes(1);
  });

  itProd('treats a value json_extract cannot parse as the read’s problem, not the file’s', () => {
    const onFatal = jest.fn();
    const conn = guardedConnection(
      {
        execute: () => {
          throw new Error('malformed JSON');
        },
      },
      onFatal,
    );

    expect(readRows(conn, "SELECT json_extract(stats_json, '$.pts') FROM things;")).toEqual([]);
    expect(onFatal).not.toHaveBeenCalled();
  });

  itProd('still fails the connection on a write whose statement fails, so its ETag cannot vouch for rows it never wrote', () => {
    const onFatal = jest.fn();
    const conn = guardedConnection(
      {
        execute: () => {
          throw new Error('SQLITE_CONSTRAINT: NOT NULL constraint failed: things.id');
        },
      },
      onFatal,
    );

    conn.execute('INSERT INTO things (id) VALUES (?);', [null]);
    expect(onFatal).toHaveBeenCalledTimes(1);
  });

  itProd('names the operation that failed, so a read and an ingest are told apart in the report', () => {
    const onFatal = jest.fn();
    const conn = guardedConnection(brokenConn(), onFatal);
    conn.execute('SELECT 1;');
    expect(onFatal.mock.calls[0][1]).toBe('execute');
  });

  itProd('swallows a failed write too, rather than leaving an ingest to throw out of a socket handler', () => {
    const conn = guardedConnection(brokenConn(), () => {});
    expect(() => runBatch(conn, [['INSERT INTO things (id) VALUES (?);', ['a']]])).not.toThrow();
  });

  itProd('lets a failed native shred reject, because that rejection is what `shred` falls back to a JS parse on', async () => {
    const onFatal = jest.fn();
    const broken: SqliteConnection = {
      execute: () => ({ rows: { _array: [] } }),
      shredJsonArrayAsync: () => Promise.reject(new Error('a payload shape the native shredder cannot take')),
    };
    const conn = guardedConnection(broken, onFatal);

    await expect(conn.shredJsonArrayAsync!({} as never, '[]', [])).rejects.toThrow(/cannot take/);
    // A shred that could not parse says nothing about the disk, so the store keeps its SQLite backend.
    expect(onFatal).not.toHaveBeenCalled();
  });

  itProd('stops shredding once some other statement has already degraded the store', async () => {
    const broken: SqliteConnection = {
      execute: () => {
        throw new Error('SQLITE_IOERR: disk I/O error');
      },
      shredJsonArrayAsync: jest.fn(async () => 5),
    };
    const conn = guardedConnection(broken, () => {});
    conn.execute('SELECT 1;');

    await expect(conn.shredJsonArrayAsync!({} as never, '[]', [])).resolves.toBe(0);
    expect(broken.shredJsonArrayAsync).not.toHaveBeenCalled();
  });

  itProd('guards the read handle as well, which is where every read actually goes', () => {
    const onFatal = jest.fn();
    const conn = guardedConnection({ execute: () => ({ rows: { _array: [] } }), reader: { ...brokenConn(), reader: undefined } }, onFatal);

    expect(readRows(conn, 'SELECT * FROM things;')).toEqual([]);
    expect(onFatal).toHaveBeenCalledTimes(1);
    expect(onFatal.mock.calls[0][1]).toBe('reader.execute');
  });

  itProd('leaves a working driver alone, including the optional methods it does not have', () => {
    const plain: SqliteConnection = { execute: () => ({ rows: { _array: [{ id: 'a' }] } }) };
    const conn = guardedConnection(plain, () => {});

    expect(readRows(conn, 'SELECT * FROM things;')).toEqual([{ id: 'a' }]);
    // Callers branch on whether the driver has these, so the wrapper mirrors the driver's own set exactly.
    expect(conn.executeBatch).toBeUndefined();
    expect(conn.shredJsonArrayAsync).toBeUndefined();
    expect(conn.reader).toBeUndefined();
  });

  itDev('rethrows in development, so a broken statement is not mistaken for a broken disk', () => {
    const conn = guardedConnection(brokenConn(), () => {});
    expect(() => conn.execute('SELECT 1;')).toThrow(/SQLITE_IOERR/);
  });
});

describe('defineSqliteStore — the wiring', () => {
  itProd('leaves a store with no way to recover unbound when one of its statements fails, forgetting what it fetched', async () => {
    const forget = jest.fn();
    const store = defineSqliteStore({
      name: 'things',
      schema,
      partition: ({ region }: { region?: string }) => (region ? { region } : null),
      build: (cellar) => ({ reads: { all: () => cellar.table.find({}) }, lifecycle: { forget } }),
    });
    store.bindSqlite(brokenConn(/SELECT/));

    expect(store.reads.all()).toEqual([]);
    await flushMicrotasks();

    expect(forget).toHaveBeenCalledTimes(1);
    expect(store.reads.all()).toEqual([]);
  });

  itProd('gives the capabilities the guarded handle too, so a failing ranker hands the store to recovery rather than throwing', () => {
    let capsConn: SqliteConnection | undefined;
    const store = defineSqliteStore({
      name: 'things',
      schema,
      partition: ({ region }: { region?: string }) => (region ? { region } : null),
      build: () => ({ reads: {} }),
      capabilities: (conn: SqliteConnection) => {
        capsConn = conn;
        return { probe: conn };
      },
    });
    const broken = brokenConn(/SELECT/);
    store.bindSqlite(broken);

    expect(() => readRows(capsConn!, 'SELECT 1;')).not.toThrow();
  });
});

describe('a native shred the driver refuses', () => {
  itProd('falls back to the JS parse over the guarded connection, which is the only wiring production runs', async () => {
    const calls: string[] = [];
    const conn: SqliteConnection = {
      execute: (sql) => {
        calls.push(sql);
        return { rows: { _array: [] } };
      },
      shredJsonArrayAsync: () => Promise.reject(new Error('a payload shape the native shredder cannot take')),
    };
    const onFatal = jest.fn();
    const table = createSqliteRowTable(schema, guardedConnection(conn, onFatal), {
      specs: { all: {} as never },
      variant: () => 'all',
      binds: (scope) => [String(scope.region)],
    });
    const parseRows = jest.fn(() => [{ id: 'a', region: 'us' }]);

    const { changes } = await table.shred({ region: 'us' }, '[{"id":"a"}]', parseRows);

    expect(parseRows).toHaveBeenCalled();
    // This fake answers every statement with nothing, so the partition reads as empty and the rows land directly.
    expect([...(changes as ReadonlySet<string>)]).toEqual(['a']);
    expect(calls.some((sql) => /INSERT/.test(sql) && sql.includes('things'))).toBe(true);
    // The rows landed, so the store keeps the SQLite backend it would otherwise have thrown away for the session.
    expect(onFatal).not.toHaveBeenCalled();
  });
});

describe('a degraded store still answers', () => {
  itProd('reads empty rather than throwing, all the way through the row store', () => {
    const rowTable = createSqliteRowTable(
      schema,
      guardedConnection(brokenConn(/SELECT/), () => {}),
    );
    rowTable.init();

    expect(rowTable.find({ region: 'us' })).toEqual([]);
    expect(rowTable.getOne({ id: 'a' })).toBeUndefined();
    expect(rowTable.has({ region: 'us' })).toBe(false);
  });
});
