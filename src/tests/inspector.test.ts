import { defineSqliteStore } from '../define_sqlite_store';
import { byPartition } from '../caches';
import { recordIngestTiming } from '../diagnostics/ingest_timing';
import { resetOnceGuards } from '../diagnostics/once_guard';
import { reportStoreDegradation } from '../diagnostics/telemetry';
import { clearInspectorEvents, inspectedStore, inspectedStores, onInspectorEvent, recentInspectorEvents, ReadOnlyViolation } from '../inspector';
import type { InspectorEvent } from '../inspector';
import type { Loose } from '../read/facade';
import type { PartitionKeyColumn, StoreTableSchema } from '../table/partitioned';
import type { SqliteConnection } from '../table/connection';
import type { RowTable } from '../table/types';
import { itDev, itProd } from '../testing/dev_mode';
import { installTestRuntime } from '../testing/runtime';
import { createSqlJsConnection } from '../testing/sqljs_connection';

installTestRuntime();

type Game = { team: string; sport: string; score: number | null };
type Season = { sport: string; season: string };

const SCHEMA: StoreTableSchema<Game> = {
  table: 'inspected_games',
  columns: { team: { type: 'TEXT', notNull: true }, sport: { type: 'TEXT', notNull: true }, score: { type: 'INTEGER' } },
  primaryKey: ['sport', 'team'],
  entityId: 'team',
  indexes: [{ name: 'idx_inspected_games_sport', columns: ['sport'] }],
};

function gamesStore(name = 'inspected_games_store') {
  let table: RowTable<Game & PartitionKeyColumn> | undefined;
  const store = defineSqliteStore({
    name,
    schema: SCHEMA,
    partition: (args: Loose<Season>) => (args.sport && args.season ? { sport: args.sport, season: args.season } : null),
    build: (cellar) => {
      table = cellar.table;
      const put = (season: Season, games: Game[]): number => {
        const key = cellar.keyOf(season);
        const result = cellar.table.overwrite(cellar.where(key), games.map((game) => ({ ...game, partition_key: key })));
        return cellar.bump(key, result.changes);
      };
      return {
        reads: { teams: cellar.defineRead<Season, string[]>({ empty: [], select: (_args, key) => cellar.rows(key).map((row) => row.team, []) }) },
        lifecycle: { put, setEtag: (season: Season, etag: string) => cellar.table.setMeta(cellar.where(cellar.keyOf(season)), etag) },
      };
    },
  });
  return { store, table: () => table! };
}

const NFL: Season = { sport: 'nfl', season: '2026' };
const NBA: Season = { sport: 'nba', season: '2026' };

beforeEach(() => {
  clearInspectorEvents();
  resetOnceGuards();
});

describe('the store list', () => {
  it('lists every declared store by name, with its table as declared', () => {
    gamesStore('listed_store');
    const inspected = inspectedStore('listed_store')!;
    expect(inspectedStores().map((store) => store.name)).toContain('listed_store');
    expect(inspected.schema()).toEqual({
      table: 'inspected_games',
      metaTable: 'inspected_games_meta',
      columns: [
        { name: 'partition_key', type: 'TEXT', notNull: true },
        { name: 'team', type: 'TEXT', notNull: true },
        { name: 'sport', type: 'TEXT', notNull: true },
        { name: 'score', type: 'INTEGER', notNull: false },
      ],
      primaryKey: ['partition_key', 'sport', 'team'],
      entityColumn: 'team',
      indexes: [
        { name: 'idx_inspected_games_partition', columns: ['partition_key', 'team'] },
        { name: 'idx_inspected_games_sport', columns: ['sport'] },
      ],
      reads: [],
      nativeShred: false,
    });
  });

  it('keeps one entry per name, the latest declaration, as a Fast Refresh re-declares a store', () => {
    gamesStore('refreshed_store');
    const { store } = gamesStore('refreshed_store');
    store.bindSqlite(createSqlJsConnection());
    expect(inspectedStores().filter((inspected) => inspected.name === 'refreshed_store')).toHaveLength(1);
    expect(inspectedStore('refreshed_store')!.binding().state).toBe('database');
  });
});

describe('where a store runs', () => {
  it('is unbound until the bind, then on the database the bind named, with its reads listed', () => {
    const { store } = gamesStore('bound_store');
    const inspected = inspectedStore('bound_store')!;
    expect(inspected.binding()).toMatchObject({ state: 'unbound', reopens: 0 });

    store.bindSqlite(createSqlJsConnection(), { database: 'games.db' });
    expect(inspected.binding()).toMatchObject({ state: 'database', database: 'games.db', reopens: 0 });
    expect(inspected.schema().reads).toEqual(['teams']);
  });

  it('is on the in-memory database after a temporary bind', () => {
    const { store } = gamesStore('memory_store');
    store.bindSqlite(createSqlJsConnection(), { temporary: true, database: 'games.db' });
    expect(inspectedStore('memory_store')!.binding()).toMatchObject({ state: 'memory', database: 'games.db' });
  });

  it('does not count as a read, so looking before the startup bind reports no late bind', async () => {
    const { store } = gamesStore('looked_at_store');
    const inspected = inspectedStore('looked_at_store')!;
    await inspected.partitions();
    await inspected.summary();
    await inspected.query('SELECT 1 AS one');
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    store.bindSqlite(createSqlJsConnection(), { startup: true });
    expect(warn.mock.calls.filter(([message]) => String(message).includes('store.late_bind'))).toEqual([]);
    warn.mockRestore();
  });

  itDev('records each move as an event', () => {
    const { store } = gamesStore('moving_store');
    store.bindSqlite(createSqlJsConnection(), { database: 'games.db' });
    store.bindSqlite(createSqlJsConnection(), { temporary: true, database: 'games.db' });
    const moves = recentInspectorEvents().filter((event) => event.kind === 'binding' && event.store === 'moving_store');
    expect(moves.map((event) => event.kind === 'binding' && event.binding.state)).toEqual(['database', 'memory']);
  });
});

describe('partitions', () => {
  it('lists each partition with its rows, version, ETag and description, sorted by key', async () => {
    const { store } = gamesStore('partitioned_store');
    store.bindSqlite(createSqlJsConnection());
    store.lifecycle.put(NFL, [
      { team: 'KC', sport: 'nfl', score: 27 },
      { team: 'BUF', sport: 'nfl', score: 24 },
    ]);
    store.lifecycle.put(NFL, [
      { team: 'KC', sport: 'nfl', score: 30 },
      { team: 'BUF', sport: 'nfl', score: 24 },
    ]);
    store.lifecycle.put(NBA, [{ team: 'BOS', sport: 'nba', score: 101 }]);
    store.lifecycle.setEtag(NFL, 'W/"7"');

    const inspected = inspectedStore('partitioned_store')!;
    expect(await inspected.partitions()).toEqual([
      { key: 'season=2026&sport=nba', partition: NBA, rows: 1, entities: 1, version: 1, etag: null, fetchedAt: null },
      { key: 'season=2026&sport=nfl', partition: NFL, rows: 2, entities: 2, version: 2, etag: 'W/"7"', fetchedAt: null },
    ]);
    expect(await inspected.summary()).toMatchObject({ binding: { state: 'database' }, rows: 3, storedRows: 3, partitions: 2 });
    expect((await inspected.summary()).databaseBytes).toBeGreaterThan(0);
  });

  it('leaves out a partition a read only named, which holds nothing and was never fetched', async () => {
    const { store } = gamesStore('named_store');
    store.bindSqlite(createSqlJsConnection());
    store.lifecycle.put(NFL, [{ team: 'KC', sport: 'nfl', score: 27 }]);
    store.lifecycle.getVersion(NBA);

    expect((await inspectedStore('named_store')!.partitions()).map((partition) => partition.key)).toEqual(['season=2026&sport=nfl']);
  });

  it('lists the entities a partition changed since its epoch, newest first', () => {
    const { store } = gamesStore('entity_changes_store');
    store.bindSqlite(createSqlJsConnection());
    store.lifecycle.put(NFL, [
      { team: 'KC', sport: 'nfl', score: 27 },
      { team: 'BUF', sport: 'nfl', score: 24 },
    ]);
    store.lifecycle.put(NFL, [
      { team: 'KC', sport: 'nfl', score: 30 },
      { team: 'BUF', sport: 'nfl', score: 24 },
    ]);
    store.lifecycle.put(NFL, [
      { team: 'KC', sport: 'nfl', score: 30 },
      { team: 'BUF', sport: 'nfl', score: 21 },
    ]);
    expect(inspectedStore('entity_changes_store')!.entityChanges('season=2026&sport=nfl')).toEqual({
      version: 3,
      epoch: 1,
      count: 2,
      changed: [
        { id: 'BUF', version: 3 },
        { id: 'KC', version: 2 },
      ],
    });
  });

  it('reads one entity as an id within one partition, and lists the other partitions using the id', async () => {
    const { store } = gamesStore('entity_lookup_store');
    store.bindSqlite(createSqlJsConnection());
    store.lifecycle.put(NFL, [{ team: 'BUF', sport: 'nfl', score: 24 }, { team: 'KC', sport: 'nfl', score: 27 }]);
    store.lifecycle.put(NFL, [{ team: 'BUF', sport: 'nfl', score: 21 }, { team: 'KC', sport: 'nfl', score: 27 }]);
    store.lifecycle.put(NBA, [{ team: 'BUF', sport: 'nba', score: 99 }]);
    const inspected = inspectedStore('entity_lookup_store')!;
    expect(await inspected.entity('season=2026&sport=nfl', 'BUF')).toEqual({
      partition: 'season=2026&sport=nfl',
      id: 'BUF',
      rows: [{ partition_key: 'season=2026&sport=nfl', team: 'BUF', sport: 'nfl', score: 21 }],
      version: 2,
      cacheEntries: [],
      sameIdIn: ['season=2026&sport=nba'],
    });
    expect(await inspected.entity('season=2026&sport=nba', 'BUF')).toMatchObject({ rows: [{ sport: 'nba', score: 99 }], version: 1, sameIdIn: ['season=2026&sport=nfl'] });
  });

  it('clears a partition ETag, and says a store without fetches cannot refetch', async () => {
    const { store } = gamesStore('etag_store');
    store.bindSqlite(createSqlJsConnection());
    store.lifecycle.put(NFL, [{ team: 'KC', sport: 'nfl', score: 27 }]);
    store.lifecycle.setEtag(NFL, 'W/"7"');
    const inspected = inspectedStore('etag_store')!;

    inspected.clearEtag('season=2026&sport=nfl');
    expect((await inspected.partitions())[0].etag).toBeNull();
    expect(inspected.refetch('season=2026&sport=nfl')).toBe(false);
  });

  it('is empty while the store is unbound', async () => {
    gamesStore('empty_store');
    const inspected = inspectedStore('empty_store')!;
    expect(await inspected.partitions()).toEqual([]);
    expect(await inspected.summary()).toMatchObject({ binding: { state: 'unbound' }, rows: 0, partitions: 0 });
  });
});

describe('queries', () => {
  function seeded(name: string) {
    const { store, table } = gamesStore(name);
    const reopen = jest.fn(() => createSqlJsConnection());
    store.bindSqlite(createSqlJsConnection(), { recovery: { reopen } });
    store.lifecycle.put(NFL, [
      { team: 'KC', sport: 'nfl', score: 27 },
      { team: 'BUF', sport: 'nfl', score: 24 },
      { team: 'MIA', sport: 'nfl', score: null },
    ]);
    return { table, reopen, inspected: inspectedStore(name)! };
  }

  it('returns the columns and each row as values in column order, blobs described', async () => {
    const { inspected } = seeded('query_store');
    const result = await inspected.query("SELECT team, score, CASE team WHEN 'KC' THEN x'deadbeef' END AS logo FROM inspected_games WHERE partition_key = ? ORDER BY team", ['season=2026&sport=nfl']);
    expect(result).toMatchObject({
      columns: ['team', 'score', 'logo'],
      rows: [
        ['BUF', 24, null],
        ['KC', 27, { $blob: true, bytes: 4, hex: 'deadbeef' }],
        ['MIA', null, null],
      ],
      truncated: false,
    });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('stops at the limit and says so, keeping the order the query asked for', async () => {
    const { inspected } = seeded('limited_store');
    const result = await inspected.query('SELECT team FROM inspected_games ORDER BY team DESC', [], { limit: 2 });
    expect(result).toMatchObject({ rows: [['MIA'], ['KC']], truncated: true });
  });

  it('runs a CTE, VALUES, EXPLAIN and the reading pragmas', async () => {
    const { inspected } = seeded('reading_store');
    expect((await inspected.query('WITH t AS (SELECT team FROM inspected_games) SELECT COUNT(*) AS n FROM t')).rows).toEqual([[3]]);
    expect((await inspected.query('VALUES (1, 2)')).rows).toEqual([[1, 2]]);
    expect((await inspected.query('EXPLAIN QUERY PLAN SELECT * FROM inspected_games WHERE sport = ?', ['nfl'])).columns).toContain('detail');
    expect((await inspected.query("PRAGMA table_info('inspected_games')")).rows.map((row) => row[1])).toEqual(['partition_key', 'team', 'sport', 'score']);
    expect((await inspected.query('PRAGMA user_version;')).columns).toEqual(['user_version']);
    expect((await inspected.query('-- the teams\nSELECT team FROM inspected_games /* all */ ORDER BY team;  ')).rows).toHaveLength(3);
  });

  it.each([
    ['DELETE FROM inspected_games', 'this is a DELETE statement'],
    ['UPDATE inspected_games SET score = 0', 'this is an UPDATE statement'],
    ['DROP TABLE inspected_games', 'this is a DROP statement'],
    ["ATTACH ':memory:' AS other", 'this is an ATTACH statement'],
    ['WITH t AS (SELECT 1) DELETE FROM inspected_games', 'writes to the database'],
    ['WITH t AS (SELECT 1) INSERT INTO inspected_games (partition_key, team, sport) VALUES (1, 2, 3)', 'writes to the database'],
    ['SELECT 1; DELETE FROM inspected_games', 'one statement at a time'],
    ['PRAGMA user_version = 3', 'sets a value'],
    ['PRAGMA journal_mode(DELETE)', 'sets a value'],
    ['   ', 'empty'],
  ])('refuses %j', async (sql, reason) => {
    const { inspected } = seeded(`refusing_store_${sql.length}`);
    await expect(inspected.query(sql)).rejects.toThrow(ReadOnlyViolation);
    await expect(inspected.query(sql)).rejects.toThrow(reason);
    expect((await inspected.query('SELECT COUNT(*) AS n FROM inspected_games')).rows).toEqual([[3]]);
  });

  it('pages through the rows with an offset', async () => {
    const { inspected } = seeded('paged_store');
    const first = await inspected.query('SELECT team FROM inspected_games ORDER BY team', [], { limit: 2 });
    const second = await inspected.query('SELECT team FROM inspected_games ORDER BY team', [], { limit: 2, offset: 2 });
    expect(first).toMatchObject({ rows: [['BUF'], ['KC']], truncated: true, offset: 0 });
    expect(second).toMatchObject({ rows: [['MIA']], truncated: false, offset: 2 });
  });

  it('keeps a semicolon inside a string or a quoted name as part of the one statement', async () => {
    const { inspected } = seeded('quoted_store');
    expect((await inspected.query("SELECT 'a;b' AS \"x;y\"")).rows).toEqual([['a;b']]);
  });

  it('rejects SQL that SQLite cannot compile without tripping the store into recovery', async () => {
    const { table, reopen, inspected } = seeded('broken_query_store');
    await expect(inspected.query('SELECT nope FROM inspected_games')).rejects.toThrow(/no such column/);
    await Promise.resolve();
    expect(reopen).not.toHaveBeenCalled();
    expect(inspected.binding().state).toBe('database');
    expect(table().find({})).toHaveLength(3);
  });

  /** A connection that answers as nitro does: rows keyed in reverse, and the column metadata `metadataOf` builds. */
  function nitroLike(metadataOf: (names: string[]) => Record<string, { index: number; name?: string }>): SqliteConnection {
    const sqljs = createSqlJsConnection();
    return {
      execute: (sql, params) => {
        const result = sqljs.execute(sql, params);
        const rows = (result.rows?._array ?? []) as Array<Record<string, unknown>>;
        if (!rows.length) return result;
        return { rows: { _array: rows.map((row) => Object.fromEntries(Object.entries(row).reverse())) }, metadata: metadataOf(Object.keys(rows[0])) };
      },
    };
  }

  it("orders columns as the statement does when the driver's metadata names every one", async () => {
    const { store } = gamesStore('metadata_store');
    store.bindSqlite(nitroLike((names) => Object.fromEntries(names.map((name, index) => [name, { name, index }]))));
    store.lifecycle.put(NFL, [{ team: 'KC', sport: 'nfl', score: 27 }]);
    const result = await inspectedStore('metadata_store')!.query('SELECT score, team, sport FROM inspected_games');
    expect(result).toMatchObject({ columns: ['score', 'team', 'sport'], rows: [[27, 'KC', 'nfl']] });
  });

  it("orders columns as the table does when the metadata is short, as nitro 1.1.5 keys every entry the same", async () => {
    const { store } = gamesStore('short_metadata_store');
    store.bindSqlite(nitroLike((names) => ({ '': { name: names[0], index: 0 } })));
    store.lifecycle.put(NFL, [{ team: 'KC', sport: 'nfl', score: 27 }]);
    const result = await inspectedStore('short_metadata_store')!.query('SELECT score * 2 AS doubled, score, partition_key, team FROM inspected_games');
    expect(result).toMatchObject({ columns: ['partition_key', 'team', 'score', 'doubled'], rows: [['season=2026&sport=nfl', 'KC', 27, 54]] });
  });

  it("keeps the row's own order for a driver without metadata", async () => {
    const { store } = gamesStore('plain_order_store');
    store.bindSqlite(createSqlJsConnection());
    store.lifecycle.put(NFL, [{ team: 'KC', sport: 'nfl', score: 27 }]);
    expect((await inspectedStore('plain_order_store')!.query('SELECT score, team FROM inspected_games')).columns).toEqual(['score', 'team']);
  });

  it('answers nothing while the store is unbound, and still refuses a write', async () => {
    gamesStore('unbound_query_store');
    const inspected = inspectedStore('unbound_query_store')!;
    expect(await inspected.query('SELECT 1 AS one')).toEqual({ columns: [], rows: [], truncated: false, offset: 0, durationMs: 0 });
    await expect(inspected.query('DELETE FROM inspected_games')).rejects.toThrow(ReadOnlyViolation);
  });
});

describe('the event log', () => {
  itDev('records each write with the entities it changed, and hands it to listeners as it happens', () => {
    const { store } = gamesStore('logged_store');
    store.bindSqlite(createSqlJsConnection());
    const heard: InspectorEvent[] = [];
    const stop = onInspectorEvent((event) => heard.push(event));

    store.lifecycle.put(NFL, [{ team: 'KC', sport: 'nfl', score: 27 }]);
    store.lifecycle.put(NFL, [
      { team: 'KC', sport: 'nfl', score: 27 },
      { team: 'BUF', sport: 'nfl', score: 24 },
    ]);
    store.lifecycle.put(NFL, [
      { team: 'KC', sport: 'nfl', score: 27 },
      { team: 'BUF', sport: 'nfl', score: 24 },
    ]);
    stop();
    store.lifecycle.put(NBA, [{ team: 'BOS', sport: 'nba', score: 101 }]);

    const writes = heard.filter((event) => event.kind === 'write');
    expect(writes).toEqual([
      expect.objectContaining({ store: 'logged_store', partition: 'season=2026&sport=nfl', version: 1, entities: ['KC'], entityCount: 1 }),
      expect.objectContaining({ store: 'logged_store', partition: 'season=2026&sport=nfl', version: 2, entities: ['BUF'], entityCount: 1 }),
    ]);
    const logged = recentInspectorEvents().filter((event) => event.kind === 'write');
    expect(logged).toHaveLength(3);
    expect(recentInspectorEvents(writes[1].id).map((event) => event.kind === 'write' && event.partition)).toEqual(['season=2026&sport=nba']);
  });

  itDev('records every degradation report, marking the first of each scope', () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    reportStoreDegradation({ scope: 'inspected.scope', context: 'went wrong', error: new Error('boom') });
    reportStoreDegradation({ scope: 'inspected.scope', context: 'went wrong', severity: 'info' });
    expect(recentInspectorEvents().filter((event) => event.kind === 'degradation')).toEqual([
      expect.objectContaining({ scope: 'inspected.scope', context: 'went wrong', severity: 'error', error: 'boom', first: true }),
      expect.objectContaining({ scope: 'inspected.scope', severity: 'info', first: false }),
    ]);
    (console.warn as jest.Mock).mockRestore();
  });

  itDev('records a degradation with its numbers, a count per scope, and where it came from', () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    reportStoreDegradation({ scope: 'counted.scope', context: 'c', extra: { rows: 9422, partition: 'w=4', nested: { a: 1 } } });
    reportStoreDegradation({ scope: 'counted.scope', context: 'c', callsite: '\n    at StatsScreen (app.bundle:1:2)' });
    const [first, second] = recentInspectorEvents().filter((event) => event.kind === 'degradation');
    expect(first).toMatchObject({ count: 1, extra: { rows: 9422, partition: 'w=4', nested: '{"a":1}' }, callsiteKind: 'stack' });
    expect(first.kind === 'degradation' && first.callsite).toMatch(/inspector\.test/);
    expect(second).toMatchObject({ count: 2, callsite: '\n    at StatsScreen (app.bundle:1:2)', callsiteKind: 'component' });
    (console.warn as jest.Mock).mockRestore();
  });

  itDev('counts what each of a store’s caches does', () => {
    const store = defineSqliteStore({
      name: 'cached_store',
      schema: SCHEMA,
      partition: (args: Loose<Season>) => (args.sport && args.season ? { sport: args.sport, season: args.season } : null),
      build: (cellar) => {
        const { teams } = cellar.defineCaches({ teams: byPartition<string[]>({ max: 4 }) });
        const put = (season: Season, games: Game[]) => {
          const key = cellar.keyOf(season);
          cellar.bump(key, cellar.table.overwrite(cellar.where(key), games.map((game) => ({ ...game, partition_key: key }))).changes);
        };
        const teamsOf = (season: Season) => {
          const key = cellar.keyOf(season);
          return teams.for(key).read(() => cellar.rows(key).map((row) => row.team, []));
        };
        return { reads: {}, lifecycle: { put, teamsOf } };
      },
    });
    store.bindSqlite(createSqlJsConnection());
    store.lifecycle.put(NFL, [{ team: 'KC', sport: 'nfl', score: 27 }]);
    store.lifecycle.teamsOf(NFL);
    store.lifecycle.teamsOf(NFL);
    store.lifecycle.put(NFL, [{ team: 'KC', sport: 'nfl', score: 30 }]);
    store.lifecycle.teamsOf(NFL);

    expect(inspectedStore('cached_store')!.caches()).toEqual([
      expect.objectContaining({ name: 'cached.teams', store: 'cached', cache: 'teams', kind: 'partition', max: 4, entries: 1, hits: 1, absent: 1, stale: 1, builds: 2, reused: 1, evictions: 0 }),
    ]);
  });

  itDev('estimates what each cache holds on the heap, and pages its entries newest first without using them', () => {
    const store = defineSqliteStore({
      name: 'heap_store',
      schema: SCHEMA,
      partition: (args: Loose<Season>) => (args.sport && args.season ? { sport: args.sport, season: args.season } : null),
      build: (cellar) => {
        const { teams } = cellar.defineCaches({ teams: byPartition<{ names: string[] }>({ max: 4 }) });
        return {
          reads: {},
          lifecycle: {
            teamsOf: (season: Season, names: string[]) => teams.for(cellar.keyOf(season)).read(() => ({ names })),
          },
        };
      },
    });
    store.bindSqlite(createSqlJsConnection());
    store.lifecycle.teamsOf(NFL, ['KC', 'BUF']);
    store.lifecycle.teamsOf(NBA, ['BOS']);
    const inspected = inspectedStore('heap_store')!;

    const [cache] = inspected.caches({ heap: true });
    expect(cache.heapBytes).toBeGreaterThan(300);
    expect(cache.heapPartial).toBe(false);
    expect(inspected.caches()[0].heapBytes).toBeUndefined();

    const page = inspected.cacheEntries('teams', { limit: 1 });
    expect(page).toMatchObject({ total: 2, offset: 0, entries: [{ key: ['season=2026&sport=nba'], version: 0, value: { names: ['BOS'] } }] });
    expect(page.entries[0].heapBytes).toBeGreaterThan(0);
    expect(inspected.cacheEntries('teams', { offset: 1 }).entries[0].key).toEqual(['season=2026&sport=nfl']);
  });

  itDev("totals a store's caches in its summary", async () => {
    const summary = await inspectedStore('heap_store')!.summary();
    expect(summary.caches).toMatchObject({ count: 1, entries: 2 });
    expect(summary.caches.heapBytes).toBeGreaterThan(300);
  });

  itDev("counts rows two caches share once in the store's total, and says how much was shared", async () => {
    const store = defineSqliteStore({
      name: 'shared_heap_store',
      schema: SCHEMA,
      partition: (args: Loose<Season>) => (args.sport && args.season ? { sport: args.sport, season: args.season } : null),
      build: (cellar) => {
        const { ranking, rowById } = cellar.defineCaches({
          ranking: byPartition<Array<{ team: string; note: string }>>({ max: 2 }),
          rowById: byPartition<{ team: string; note: string }, [team: string]>({ max: 64 }),
        });
        const rank = (season: Season) => {
          const key = cellar.keyOf(season);
          return ranking.for(key).read(() =>
            Array.from({ length: 20 }, (_, i) => ({ team: `T${i}`, note: 'x'.repeat(200) })).map((row) => rowById.for(key).set(row.team, row)),
          );
        };
        return { reads: {}, lifecycle: { rank } };
      },
    });
    store.bindSqlite(createSqlJsConnection());
    store.lifecycle.rank(NFL);
    const inspected = inspectedStore('shared_heap_store')!;
    const separate = inspected.caches({ heap: true }).reduce((sum, cache) => sum + (cache.heapBytes ?? 0), 0);
    const { caches } = await inspected.summary();
    expect(caches.heapBytes).toBeLessThan(separate);
    expect(caches.sharedBytes).toBe(separate - caches.heapBytes);
    expect(caches.sharedBytes).toBeGreaterThan(20 * 200);
  });

  itProd('lists no caches in a release build', () => {
    expect(inspectedStores().flatMap((store) => store.caches())).toEqual([]);
  });

  itDev('records each fetch under the store name', () => {
    recordIngestTiming({ store: 'players_store_ingest', partition: 'nfl', fetchMs: 120, ingestMs: 30, chars: 4096, rows: 12, at: 1000 });
    expect(recentInspectorEvents()).toEqual([
      expect.objectContaining({ kind: 'fetch', store: 'players_store', partition: 'nfl', fetchMs: 120, ingestMs: 30, chars: 4096, rows: 12, at: 1000 }),
    ]);
  });

  itProd('records nothing in a release build', () => {
    const { store } = gamesStore('silent_store');
    const heard = jest.fn();
    const stop = onInspectorEvent(heard);
    store.bindSqlite(createSqlJsConnection());
    store.lifecycle.put(NFL, [{ team: 'KC', sport: 'nfl', score: 27 }]);
    recordIngestTiming({ store: 'players_store_ingest', partition: 'nfl', fetchMs: 1, ingestMs: 1, chars: 1, rows: 1, at: 1 });
    stop();
    expect(heard).not.toHaveBeenCalled();
    expect(recentInspectorEvents()).toEqual([]);
  });
});
