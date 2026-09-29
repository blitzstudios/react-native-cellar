import { defineSqliteStore } from '../define_sqlite_store';
import { resetOnceGuards } from '../diagnostics/once_guard';
import { itDev, itProd } from '../testing/dev_mode';
import { SqliteConnection } from '../table/connection';
import { StoreTableSchema } from '../table/partitioned';
import { createSqlJsConnection } from '../testing/sqljs_connection';

type Thing = { id: string };

const schema: StoreTableSchema<Thing> = {
  table: 'things',
  columns: { id: { type: 'TEXT' } },
  primaryKey: ['id'],
  entityId: 'id',
};

/**
 * A connection named `label`, which answers `SELECT label` with its name and every other statement with nothing — so a
 * store can say which connection it runs on — and whose `SELECT`s fail with `failWith` once `failing.now` is set.
 */
function namedConn(label: string, failWith = 'disk I/O error') {
  const failing = { now: false };
  const ran: string[] = [];
  const conn: SqliteConnection = {
    execute: (sql: string) => {
      ran.push(sql);
      if (sql === 'SELECT label') return { rows: { _array: [{ label }] } };
      if (failing.now && sql.startsWith('SELECT')) throw new Error(failWith);
      return { rows: { _array: [] } };
    },
  };
  return { conn, failing, ran };
}

/** A store whose surface says which connection it was built over — `unbound` for the one that answers nothing — and counts its builds. */
function labelledStore() {
  const forgets: jest.Mock[] = [];
  let builds = 0;
  const store = defineSqliteStore({
    name: 'test_store',
    schema,
    partition: { fields: ['id'] },
    build: (cellar) => {
      builds += 1;
      const forget = jest.fn();
      forgets.push(forget);
      return { reads: { label: cellar.caps.label, describe: () => cellar.caps.label, rows: () => cellar.table.find({}) }, lifecycle: { forget } };
    },
    capabilities: (conn: SqliteConnection): { label: string } => {
      try {
        const [row] = (conn.execute('SELECT label').rows?._array ?? []) as Array<{ label: string }>;
        return { label: row?.label ?? 'unbound' };
      } catch {
        return { label: 'sqljs' };
      }
    },
  });
  return { store, forgets, builds: () => builds };
}

const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve));

describe('defineSqliteStore — the running connection', () => {
  beforeEach(() => {
    resetOnceGuards();
  });

  it('reads as unbound until a bind, then from the bound connection', () => {
    const { store } = labelledStore();

    expect(store.reads.label).toBe('unbound');
    store.bindSqlite(namedConn('disk').conn);
    expect(store.reads.label).toBe('disk');
  });

  it('builds nothing over the unbound connection when the bind comes before the first read', () => {
    const { store, builds } = labelledStore();

    store.bindSqlite(namedConn('disk').conn);

    expect(store.reads.label).toBe('disk');
    expect(builds()).toBe(1);
  });

  it('builds the unbound surface once, however many reads it serves', () => {
    const { store, builds } = labelledStore();

    expect(store.reads.label).toBe(store.reads.label);
    expect(builds()).toBe(1);
  });

  it('resolves a group at each access, so a caller holding it follows the store to the next connection', () => {
    const { store } = labelledStore();
    const { reads } = store;

    expect(reads.describe()).toBe('unbound');
    store.bindSqlite(namedConn('disk').conn);
    expect(reads.describe()).toBe('disk');
  });

  it('forgets what the previous surface fetched when it moves, so the next one fetches for itself', () => {
    const { store, forgets } = labelledStore();
    void store.reads.label;

    store.bindSqlite(namedConn('disk').conn);

    expect(forgets[0]).toHaveBeenCalledTimes(1);
  });

  itDev('leaves the store where it was when it cannot be built over the connection', () => {
    const { store } = labelledStore();
    store.bindSqlite(namedConn('disk').conn);
    const broken: SqliteConnection = {
      execute: () => {
        throw new Error('migration failed');
      },
    };

    expect(() => store.bindSqlite(broken)).toThrow('migration failed');
    expect(store.reads.label).toBe('disk');
  });

  itProd('in a release build, takes a connection that fails while building for a failure, and leaves it', async () => {
    const { store } = labelledStore();
    const broken: SqliteConnection = {
      execute: () => {
        throw new Error('migration failed');
      },
    };

    store.bindSqlite(broken);
    await flush();

    expect(store.reads.label).toBe('unbound');
  });

  it('lists the running surface, so a group can be enumerated like the object it stands for', () => {
    const { store } = labelledStore();

    expect(Object.keys(store.reads).sort()).toEqual(['describe', 'label', 'rows']);
    expect('label' in store.reads).toBe(true);
  });

  itDev('reports a startup bind that lands after something has already read', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { store } = labelledStore();

    void store.reads.label;
    store.bindSqlite(namedConn('disk').conn, { startup: true });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('store.late_bind');
    warn.mockRestore();
  });

  it('stays silent for a bind after a read that is not a startup bind, which is how web binds once sql.js loads', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { store } = labelledStore();

    void store.reads.label;
    store.bindSqlite(namedConn('sqljs').conn);

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('defineSqliteStore — testing', () => {
  it('builds a surface and a table over a connection of the test’s own, without moving the store', () => {
    const { store } = labelledStore();
    const { surface, table } = store.testing.over(createSqlJsConnection());

    table.overwrite({ partition_key: 'k' }, [{ partition_key: 'k', id: 'a' }]);
    expect(surface.reads.rows()).toEqual([{ partition_key: 'k', id: 'a' }]);
    expect(store.reads.label).toBe('unbound');
  });

  it('swaps a surface in behind the store, and reset puts it back to unbound', () => {
    const { store } = labelledStore();
    store.testing.swap(store.testing.over(namedConn('seeded').conn).surface);

    expect(store.reads.label).toBe('seeded');
    store.testing.reset();
    expect(store.reads.label).toBe('unbound');
  });
});

/**
 * A failure mid-session. In a development build the failing statement throws instead, so these run in the production
 * pass only.
 */
describe('defineSqliteStore — a SQLite failure mid-session', () => {
  beforeEach(() => {
    resetOnceGuards();
  });

  itProd('reopens the database, clears its ETags, and runs on the reopened connection', async () => {
    const { store, forgets } = labelledStore();
    const first = namedConn('disk');
    const second = namedConn('reopened');
    const reopen = jest.fn(() => second.conn);
    store.bindSqlite(first.conn, { recovery: { reopen } });

    first.failing.now = true;
    expect(store.reads.rows()).toEqual([]);
    await flush();

    expect(reopen).toHaveBeenCalledWith({ discard: false });
    expect(second.ran).toContain('UPDATE things_meta SET etag = NULL;');
    expect(store.reads.label).toBe('reopened');
    expect(forgets[0]).toHaveBeenCalledTimes(1);
  });

  itProd('deletes a corrupt database before reopening it, and keeps nothing it vouched for', async () => {
    const { store } = labelledStore();
    const first = namedConn('disk', 'database disk image is malformed (code 11 SQLITE_CORRUPT)');
    const second = namedConn('reopened');
    const reopen = jest.fn(() => second.conn);
    store.bindSqlite(first.conn, { recovery: { reopen } });

    first.failing.now = true;
    store.reads.rows();
    await flush();

    expect(reopen).toHaveBeenCalledWith({ discard: true });
    expect(second.ran).not.toContain('UPDATE things_meta SET etag = NULL;');
  });

  itProd('keeps its database when a read trips over one malformed JSON value, which says nothing about the file', async () => {
    const { store } = labelledStore();
    const first = namedConn('disk', 'malformed JSON');
    const reopen = jest.fn(() => namedConn('reopened').conn);
    store.bindSqlite(first.conn, { recovery: { reopen } });

    first.failing.now = true;
    expect(store.reads.rows()).toEqual([]);
    await flush();

    expect(reopen).not.toHaveBeenCalled();
    expect(store.reads.label).toBe('disk');
  });

  itProd('moves to the in-memory fallback once reopening has failed twice, building its tables as temp tables', async () => {
    const { store } = labelledStore();
    const conns = [namedConn('disk'), namedConn('reopened'), namedConn('reopened again')];
    const memory = namedConn('memory');
    let opened = 0;
    const reopen = jest.fn(() => conns[(opened += 1)].conn);
    const onLeftFile = jest.fn();
    store.bindSqlite(conns[0].conn, { recovery: { reopen, fallback: () => memory.conn, onLeftFile } });

    for (const { failing } of conns) {
      failing.now = true;
      store.reads.rows();
      // eslint-disable-next-line no-await-in-loop
      await flush();
    }

    expect(reopen).toHaveBeenCalledTimes(2);
    expect(store.reads.label).toBe('memory');
    expect(memory.ran.some((sql) => sql.startsWith('CREATE TEMP TABLE IF NOT EXISTS things'))).toBe(true);
    expect(onLeftFile).toHaveBeenCalledTimes(1);
  });

  itProd('reads as unbound when there is no fallback to move to, and says so to the binding', async () => {
    const { store } = labelledStore();
    const only = namedConn('disk');
    const onLeftFile = jest.fn();
    store.bindSqlite(only.conn, {
      recovery: {
        reopen: () => {
          throw new Error('unable to open database file');
        },
        onLeftFile,
      },
    });

    only.failing.now = true;
    store.reads.rows();
    await flush();

    expect(store.reads.label).toBe('unbound');
    expect(onLeftFile).toHaveBeenCalledTimes(1);
  });

  itProd('reads as unbound when the in-memory fallback fails too, rather than reopening it', async () => {
    const { store } = labelledStore();
    const disk = namedConn('disk');
    const memory = namedConn('memory');
    store.bindSqlite(disk.conn, { temporary: false, recovery: { reopen: () => disk.conn, fallback: () => memory.conn } });
    store.bindSqlite(memory.conn, { temporary: true, recovery: { reopen: () => disk.conn } });

    memory.failing.now = true;
    store.reads.rows();
    await flush();

    expect(store.reads.label).toBe('unbound');
  });
});
