import { beforeAll, describe, expect, it } from 'vitest';
import type { SqlJsStatic } from 'sql.js';
import { createDumpRpc } from '../ui/dump_rpc';
import { loadSqlJs } from './fixtures';

let SQL: SqlJsStatic;
let bytes: Uint8Array;

beforeAll(async () => {
  SQL = (await loadSqlJs()) as unknown as SqlJsStatic;
  // What a dump holds: each store's table and its `_meta`, copied without keys or indexes.
  const db = new SQL.Database();
  db.run(`
    CREATE TABLE players (partition_key TEXT, player_id TEXT, first_name TEXT, logo BLOB);
    CREATE TABLE players_meta (partition_key TEXT, etag TEXT, partition TEXT);
    CREATE TABLE unrelated (x INTEGER);
    INSERT INTO players VALUES ('nfl', '1003', 'Trindon', NULL), ('nba', '1003', 'Tony', x'deadbeef'), ('nba', '2002', 'Other', NULL);
    INSERT INTO players_meta VALUES ('nfl', 'W/"1"', '{"sport":"nfl"}'), ('mlb', 'W/"2"', NULL);
  `);
  bytes = db.export();
  db.close();
});

describe('a dump in the panel', () => {
  it('finds each store as a table with a _meta beside it, and guesses its entity column', async () => {
    const { rpc, stores } = createDumpRpc(SQL, bytes, 'sleeper-db-dump.db');
    expect(stores.map((store) => store.name)).toEqual(['players']);
    expect(await rpc.method('stores').invoke()).toMatchObject([
      {
        name: 'players',
        schema: { table: 'players', metaTable: 'players_meta', entityColumn: 'player_id' },
        summary: { binding: { state: 'database', database: 'sleeper-db-dump.db' }, rows: 3, partitions: 3 },
      },
    ]);
  });

  it('lists partitions with their rows, entities, ETag and description', async () => {
    const { rpc } = createDumpRpc(SQL, bytes, 'dump.db');
    expect(await rpc.method('partitions').invoke({ store: 'players' })).toEqual([
      { key: 'mlb', rows: 0, entities: 0, version: 0, etag: 'W/"2"', fetchedAt: null },
      { key: 'nba', rows: 2, entities: 2, version: 0, etag: null, fetchedAt: null },
      { key: 'nfl', partition: { sport: 'nfl' }, rows: 1, entities: 1, version: 0, etag: 'W/"1"', fetchedAt: null },
    ]);
  });

  it('pages a query in the statement’s column order, blobs described, and refuses a write', async () => {
    const { rpc } = createDumpRpc(SQL, bytes, 'dump.db');
    expect(await rpc.method('query').invoke({ store: 'players', sql: 'SELECT first_name, logo FROM players ORDER BY first_name', limit: 1, offset: 1 })).toMatchObject({
      columns: ['first_name', 'logo'],
      rows: [['Tony', { $blob: true, bytes: 4, hex: 'deadbeef' }]],
      truncated: true,
      offset: 1,
    });
    await expect(rpc.method('query').invoke({ store: 'players', sql: 'DELETE FROM players' })).rejects.toThrow(/Only reads/);
  });

  it('reads one entity within its partition, and the other partitions using its id', async () => {
    const { rpc } = createDumpRpc(SQL, bytes, 'dump.db');
    expect(await rpc.method('entity').invoke({ store: 'players', key: 'nfl', id: '1003' })).toEqual({
      partition: 'nfl',
      id: '1003',
      rows: [{ partition_key: 'nfl', player_id: '1003', first_name: 'Trindon', logo: null }],
      version: 0,
      cacheEntries: [],
      sameIdIn: ['nba'],
    });
  });

  it('answers empty for what only the app knows, and refuses what acts on it', async () => {
    const { rpc } = createDumpRpc(SQL, bytes, 'dump.db');
    expect(await rpc.method('events').invoke({})).toEqual([]);
    expect(await rpc.method('caches').invoke({})).toEqual([]);
    await expect(rpc.method('refetch').invoke({ store: 'players', key: 'nfl' })).rejects.toThrow(/needs the running app/);
    await expect(rpc.method('dump').invoke()).rejects.toThrow(/needs the running app/);
  });
});
