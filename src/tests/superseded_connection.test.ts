import { defineSqliteStore } from '../define_sqlite_store';
import { resetOnceGuards } from '../diagnostics/once_guard';
import { itProd } from '../testing/dev_mode';
import { installTestRuntime } from '../testing/runtime';
import { SqliteConnection } from '../table/connection';
import { StoreTableSchema } from '../table/partitioned';

const runtime = installTestRuntime();

type Thing = { id: string };

const schema: StoreTableSchema<Thing> = {
  table: 'things',
  columns: { id: { type: 'TEXT' } },
  uniqueBy: ['id'],
  entityId: 'id',
};

/**
 * A connection named `label`, which answers `SELECT label` with its name and every other statement with nothing, and
 * whose `SELECT`s fail with `failWith` once `failing.now` is set.
 */
function namedConn(label: string, failWith: string) {
  const failing = { now: false };
  const conn: SqliteConnection = {
    execute: (sql: string) => {
      if (sql === 'SELECT label') return { rows: { _array: [{ label }] } };
      if (failing.now && sql.startsWith('SELECT')) throw new Error(failWith);
      return { rows: { _array: [] } };
    },
  };
  return { conn, failing };
}

function labelledStore() {
  return defineSqliteStore({
    name: 'superseded_store',
    schema,
    partition: ({ id }: { id?: string }) => (id ? { id } : null),
    build: (cellar) => ({ reads: { label: cellar.caps.label, rows: () => cellar.table.find({}) } }),
    capabilities: (conn: SqliteConnection): { label: string } => {
      const [row] = (conn.execute('SELECT label').rows?._array ?? []) as Array<{ label: string }>;
      return { label: row?.label ?? 'unbound' };
    },
  });
}

const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve));

/**
 * A store on its in-memory fallback that a retry binds back onto its file still has the fallback's writes in flight.
 * Each resumes on the fallback's connection, and in the app on whatever nitro now holds under that name — such as a
 * fresh in-memory database with none of its `TEMP` tables (SLEEPER-PROD-84T1, SLEEPER-PROD-84GX).
 */
describe('defineSqliteStore — a failure on a connection the store has moved off of', () => {
  beforeEach(() => {
    resetOnceGuards();
    runtime.captureException.mockClear();
    runtime.captureMessage.mockClear();
  });

  itProd('leaves the store on the connection it moved to, rather than unbinding it', async () => {
    const store = labelledStore();
    const memory = namedConn('memory', 'disk I/O error');
    const disk = namedConn('disk', 'disk I/O error');
    const onLeftFile = jest.fn();
    // As `bindSqliteStore` binds in memory: temporary, and nothing to fall back to.
    store.bindSqlite(memory.conn, { temporary: true, recovery: { reopen: () => disk.conn, onLeftFile } });
    // A write already under way on the in-memory surface, taken before the store moves.
    const inFlight = store.reads.rows;
    // As `retrySqliteStores` binds it back onto its file.
    store.bindSqlite(disk.conn, { recovery: { reopen: () => disk.conn, fallback: () => memory.conn, onLeftFile } });

    memory.failing.now = true;
    expect(inFlight()).toEqual([]);
    await flush();

    expect(store.reads.label).toBe('disk');
    expect(onLeftFile).not.toHaveBeenCalled();
    expect(runtime.captureException).not.toHaveBeenCalled();
  });

  itProd("doesn't report a read that fails on the superseded connection's own statement", async () => {
    const store = labelledStore();
    const memory = namedConn('memory', 'no such table: temp.things__write_clock');
    const disk = namedConn('disk', 'no such table: temp.things__write_clock');
    store.bindSqlite(memory.conn, { temporary: true, recovery: { reopen: () => disk.conn } });
    const inFlight = store.reads.rows;
    store.bindSqlite(disk.conn, { recovery: { reopen: () => disk.conn, fallback: () => memory.conn } });

    memory.failing.now = true;
    inFlight();
    await flush();

    expect(runtime.captureException).not.toHaveBeenCalled();
    expect(store.reads.label).toBe('disk');
  });

  itProd('still unbinds a store whose running in-memory connection fails', async () => {
    const store = labelledStore();
    const memory = namedConn('memory', 'disk I/O error');
    const onLeftFile = jest.fn();
    store.bindSqlite(memory.conn, { temporary: true, recovery: { reopen: () => memory.conn, onLeftFile } });

    memory.failing.now = true;
    store.reads.rows();
    await flush();

    expect(store.reads.label).toBe('unbound');
    expect(onLeftFile).toHaveBeenCalledTimes(1);
  });
});
