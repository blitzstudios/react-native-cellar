import { NitroSQLite, open } from 'react-native-nitro-sqlite';
import { dumpSqliteStores } from './dump';
import { getOpenSqliteConnections } from './nitro_connection';

jest.mock('react-native-nitro-sqlite', () => ({ open: jest.fn(), NitroSQLite: { native: { close: jest.fn(), drop: jest.fn() } } }));
jest.mock('./nitro_connection', () => ({ getOpenSqliteConnections: jest.fn() }));

/** Each database's objects, as `sqlite_master` lists them. */
const objectsOf: Record<string, Array<{ name: string; type: string }>> = {
  'players.db': [
    { name: 'players', type: 'view' },
    { name: 'players__members', type: 'table' },
    { name: 'players__rows', type: 'table' },
    { name: 'players_meta', type: 'table' },
  ],
  'player_stats.db': [
    { name: 'player_stats', type: 'view' },
    { name: 'player_stats__members', type: 'table' },
    { name: 'player_stats__rows', type: 'table' },
    { name: 'player_stats_meta', type: 'table' },
  ],
  'other.db': [{ name: 'players', type: 'table' }],
};

function fakeSession() {
  let attached: string | undefined;
  const executed: string[] = [];
  const session = {
    executed,
    attach: jest.fn((database: string) => {
      attached = database;
    }),
    detach: jest.fn(() => {
      attached = undefined;
    }),
    close: jest.fn(),
    executeAsync: jest.fn(async (sql: string) => {
      executed.push(sql);
      const rows = (_array: unknown[]) => ({ rows: { _array } });
      if (sql.includes('src.sqlite_master')) return rows(objectsOf[attached!] ?? []);
      if (sql.startsWith('SELECT COUNT(*)')) return rows([{ rows: 3 }]);
      if (sql === 'PRAGMA database_list') return rows([{ name: 'main', file: '/data/NitroSQLite/cellar-dump.db' }]);
      if (sql === 'PRAGMA page_count') return rows([{ page_count: 10 }]);
      if (sql === 'PRAGMA page_size') return rows([{ page_size: 4096 }]);
      return rows([]);
    }),
  };
  return session;
}

const connections = (names: string[]) => (getOpenSqliteConnections as jest.Mock).mockReturnValue(names.map((name) => ({ name, conn: {} })));

beforeEach(() => jest.clearAllMocks());

it("copies every store database's tables into one file, each store's as it reads, prefixing a name an earlier database already used", async () => {
  const session = fakeSession();
  (open as jest.Mock).mockReturnValue(session);
  connections(['players.db', 'player_stats.db', ':memory:schedule.db', 'other.db']);

  const dump = await dumpSqliteStores();

  expect(NitroSQLite.native.drop).toHaveBeenCalledWith('cellar-dump.db');
  expect(open).toHaveBeenCalledWith({ name: 'cellar-dump.db' });
  expect(session.attach.mock.calls.map(([database]) => database)).toEqual(['players.db', 'player_stats.db', 'other.db']);
  expect(session.executed.filter((sql) => sql.startsWith('CREATE TABLE'))).toEqual([
    'CREATE TABLE main."players" AS SELECT * FROM src."players"',
    'CREATE TABLE main."players_meta" AS SELECT * FROM src."players_meta"',
    'CREATE TABLE main."player_stats" AS SELECT * FROM src."player_stats"',
    'CREATE TABLE main."player_stats_meta" AS SELECT * FROM src."player_stats_meta"',
    'CREATE TABLE main."other_players" AS SELECT * FROM src."players"',
  ]);
  expect(dump).toEqual({
    name: 'cellar-dump.db',
    path: '/data/NitroSQLite/cellar-dump.db',
    bytes: 40960,
    tables: [
      { database: 'players.db', table: 'players', rows: 3 },
      { database: 'players.db', table: 'players_meta', rows: 3 },
      { database: 'player_stats.db', table: 'player_stats', rows: 3 },
      { database: 'player_stats.db', table: 'player_stats_meta', rows: 3 },
      { database: 'other.db', table: 'other_players', rows: 3 },
    ],
  });
  expect(session.detach).toHaveBeenCalledTimes(3);
  expect(session.close).toHaveBeenCalled();
});

it('writes under the name it is given', async () => {
  (open as jest.Mock).mockReturnValue(fakeSession());
  connections(['players.db']);
  expect((await dumpSqliteStores({ name: 'sleeper-db-dump.db' })).name).toBe('sleeper-db-dump.db');
  expect(open).toHaveBeenCalledWith({ name: 'sleeper-db-dump.db' });
});

it('refuses when no store is on a database file', async () => {
  connections([':memory:players.db']);
  await expect(dumpSqliteStores()).rejects.toThrow(/No store is on a database file/);
  expect(open).not.toHaveBeenCalled();
});
