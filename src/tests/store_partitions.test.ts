import { installTestRuntime } from '../testing/runtime';
import { createSqlJsConnection } from '../testing/sqljs_connection';
import { defineSqliteStore } from '../define_sqlite_store';
import { byEntity } from '../read/derived_values';
import { createSqliteRowTable } from '../table/sqlite';
import { partitionedSchema, StoreTableSchema } from '../table/partitioned';
import { readRows } from '../table/connection';
import { RowTableSchema } from '../table/types';
import { NativeShredSpec, ShredSpec } from '../write/shred_spec';
import { reportStoreDegradation } from '../diagnostics/telemetry';

jest.mock('../diagnostics/telemetry', () => ({ reportStoreDegradation: jest.fn() }));

installTestRuntime();

type Game = { team: string; sport: string };
type Season = { sport: string; season: string };

const SCHEMA: StoreTableSchema<Game> = {
  table: 'games',
  columns: { team: { type: 'TEXT', notNull: true }, sport: { type: 'TEXT', notNull: true } },
  primaryKey: ['team'],
  entityId: 'team',
};

const GAME_SPEC: ShredSpec = {
  version: 1,
  table: 'games',
  insertVerb: 'INSERT OR REPLACE',
  columns: ['team', 'sport'],
  ops: [
    { op: 'text', path: 'team' },
    { op: 'bind', index: 1 },
  ],
};

const NATIVE: NativeShredSpec<Season> = { specs: { all: GAME_SPEC }, variant: () => 'all', binds: ({ sport }) => [sport] };

function gameStore(
  over: { native?: boolean; internMax?: number; forget?: () => void; fromArgs?: (args: Season) => Season; toKey?: (season: Season) => string } = {},
) {
  const queried: Season[] = [];
  const store = defineSqliteStore({
    name: 'games_store',
    schema: SCHEMA,
    partition: { fields: ['sport', 'season'], fromArgs: over.fromArgs, toKey: over.toKey },
    fetch: {
      query: (season: Season, etag?: string) => {
        queried.push(season);
        return { queryFn: async () => ({ data: '[{"team":"a"},{"team":"b"}]', etag: etag ? undefined : 'W/"1"' }) };
      },
      toRows: (season, raw) => (JSON.parse(raw) as { team: string }[]).map(({ team }) => ({ team, sport: season.sport })),
    },
    nativeShredSpec: over.native ? NATIVE : undefined,
    internMax: over.internMax,
    build: (cellar) => ({
      reads: { Teams: cellar.defineRead<Season, number>({ select: () => 0, empty: 0 }) },
      lifecycle: over.forget ? { forget: over.forget } : undefined,
    }),
  });
  const conn = createSqlJsConnection({ capabilities: over.native ? 'full' : 'minimal' });
  const { surface, table } = store.testing.over(conn);
  return { surface, table, conn, queried };
}

const NFL_2025: Season = { sport: 'nfl', season: '2025' };
const NFL_2024: Season = { sport: 'nfl', season: '2024' };

describe('defineSqliteStore — partitions', () => {
  it('keys a partition by its fields, joined readably, and stamps each row a JS parse builds with it', async () => {
    const { surface, table } = gameStore();

    await surface.lifecycle.fetch(NFL_2025);

    expect(table.find({ partition_key: 'nfl:2025' })).toEqual([
      { partition_key: 'nfl:2025', team: 'a', sport: 'nfl' },
      { partition_key: 'nfl:2025', team: 'b', sport: 'nfl' },
    ]);
  });

  it('hands the native shred the key as bind 0 and replaces only that partition by it', async () => {
    const { surface, table } = gameStore({ native: true });

    await surface.lifecycle.fetch(NFL_2025);
    await surface.lifecycle.fetch(NFL_2024);

    expect(table.find({ partition_key: 'nfl:2025' }).map((row) => row.team)).toEqual(['a', 'b']);
    expect(table.find({ partition_key: 'nfl:2024' })).toEqual([
      { partition_key: 'nfl:2024', team: 'a', sport: 'nfl' },
      { partition_key: 'nfl:2024', team: 'b', sport: 'nfl' },
    ]);
  });

  it('escapes a field value that would read as a separator', async () => {
    const { surface, table } = gameStore();

    await surface.lifecycle.fetch({ sport: 'a:b', season: '2025' });

    expect(table.has({ partition_key: 'a%3Ab:2025' })).toBe(true);
  });

  it('derives a description’s key once when the store hands back the same description, however often it is named', () => {
    const toKey = jest.fn((season: Season) => `${season.sport}/${season.season}`);
    const { surface } = gameStore({ fromArgs: () => NFL_2025, toKey });

    surface.lifecycle.has(NFL_2025);
    surface.lifecycle.getVersion(NFL_2025);

    expect(toKey).toHaveBeenCalledTimes(1);
  });

  it('keeps each partition’s description, through an ETag clear, and describes a key from it once it has left memory', async () => {
    const { surface, table, queried } = gameStore({ internMax: 1 });

    await surface.lifecycle.fetch(NFL_2025);
    expect(table.getMetaRecord({ partition_key: 'nfl:2025' })).toBe('{"sport":"nfl","season":"2025"}');
    table.setMeta({ partition_key: 'nfl:2025' }, undefined);
    expect(table.getMetaRecord({ partition_key: 'nfl:2025' })).toBe('{"sport":"nfl","season":"2025"}');

    await surface.lifecycle.fetch(NFL_2024);
    queried.length = 0;
    surface.lifecycle.refetch(NFL_2025);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(queried).toContainEqual(NFL_2025);
  });

  it('calls a store’s own forget alongside its partitions’', () => {
    const forget = jest.fn();
    const { surface } = gameStore({ forget });

    surface.lifecycle.forget();

    expect(forget).toHaveBeenCalledTimes(1);
    expect(typeof surface.lifecycle.usePrime).toBe('function');
  });
});

describe('defineSqliteStore — caches', () => {
  it('hands a byEntity cache the description of the partition its rows are in', async () => {
    const store = defineSqliteStore({
      name: 'described_store',
      schema: SCHEMA,
      partition: { fields: ['sport', 'season'] },
      fetch: {
        query: (_season: Season) => ({ queryFn: async () => ({ data: '[{"team":"a"},{"team":"b"}]' }) }),
        toRows: (season, raw) => (JSON.parse(raw) as { team: string }[]).map(({ team }) => ({ team, sport: season.sport })),
      },
      build: (cellar) => {
        const { teams } = cellar.defineCaches({ teams: byEntity({ max: 8, fromRows: ([row], season) => `${row.team}@${season.season}` }) });
        return {
          reads: {
            One: cellar.defineRead<Season & { team: string }, string | undefined>({ select: (args, key) => teams.at(key, args.team), empty: undefined }),
            Each: cellar.defineRead<Season & { ids: string[] }, string[]>({ select: (args, key) => teams.atEach(key, args.ids), empty: [] }),
          },
        };
      },
    });
    const { surface } = store.testing.over(createSqlJsConnection());

    await surface.lifecycle.fetch(NFL_2025);

    expect(surface.reads.One.getValue({ ...NFL_2025, team: 'a' })).toBe('a@2025');
    expect(surface.reads.Each.getValue({ ...NFL_2025, ids: ['a', 'b'] })).toEqual(['a@2025', 'b@2025']);
  });
});

describe('defineSqliteStore — pushes', () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

  it('drops and reports an item the store throws on, and queues the rest', async () => {
    const store = defineSqliteStore({
      name: 'throwing_store',
      schema: SCHEMA,
      partition: { fields: ['sport', 'season'] },
      push: {
        idOf: (game: Game) => game.team,
        partitionsOf: (game: Game) => {
          if (game.team === 'bad') throw new Error('no partition for it');
          return [NFL_2025];
        },
        toRows: (key, games) => games.map((game) => ({ ...game, partition_key: key })),
      },
      build: () => ({ reads: {} }),
    });
    const { surface, table } = store.testing.over(createSqlJsConnection());

    surface.push.ingest([
      { team: 'a', sport: 'nfl' },
      { team: 'bad', sport: 'nfl' },
      { team: 'b', sport: 'nfl' },
    ]);
    await settle();

    expect(table.find({ partition_key: 'nfl:2025' }, { orderBy: 'team' }).map((row) => row.team)).toEqual(['a', 'b']);
    expect(reportStoreDegradation).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'throwing_store.push', extra: expect.objectContaining({ dropped: 1, total: 3 }) }),
    );
  });

  it('hands toRows the description of the partition it writes', async () => {
    const store = defineSqliteStore({
      name: 'described_store',
      schema: SCHEMA,
      partition: { fields: ['sport', 'season'] },
      push: {
        idOf: (team: string) => team,
        partitionsOf: () => [NFL_2025],
        toRows: (key, teams, season) => teams.map((team) => ({ team, sport: season.sport, partition_key: key })),
      },
      build: () => ({ reads: {} }),
    });
    const { surface, table } = store.testing.over(createSqlJsConnection());

    surface.push.ingest(['a']);
    await settle();

    expect(table.find({ partition_key: 'nfl:2025' })).toEqual([expect.objectContaining({ team: 'a', sport: 'nfl' })]);
  });

  it('gives a store no push when it declares none', () => {
    const store = defineSqliteStore({ name: 'fetched_store', schema: SCHEMA, partition: { fields: ['sport', 'season'] }, build: () => ({ reads: {} }) });

    expect(store.push).toBeUndefined();
    expect(Object.keys(store.testing.over(createSqlJsConnection()).surface)).not.toContain('push');
  });

  it('holds a push that lands while its partition is being fetched, so the older response cannot overwrite it', async () => {
    let respond!: (value: { data: string }) => void;
    const store = defineSqliteStore({
      name: 'held_store',
      schema: SCHEMA,
      partition: { fields: ['sport', 'season'] },
      fetch: {
        query: (_season: Season) => ({ queryFn: () => new Promise<{ data: string }>((resolve) => (respond = resolve)) }),
        toRows: (season, raw) => (JSON.parse(raw) as { team: string }[]).map(({ team }) => ({ team, sport: season.sport })),
      },
      push: { idOf: (game: Game) => game.team, partitionsOf: () => [NFL_2025], toRows: (key, games) => games.map((game) => ({ ...game, partition_key: key })) },
      build: (cellar) => ({ reads: { Teams: cellar.defineRead<Season, number>({ select: () => 0, empty: 0 }) } }),
    });
    const { surface, table } = store.testing.over(createSqlJsConnection());
    const teams = () => table.find({ partition_key: 'nfl:2025' }, { orderBy: 'team' }).map((row) => row.team);
    const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

    const fetching = surface.lifecycle.fetch(NFL_2025);
    await Promise.resolve();
    surface.push.ingest([{ team: 'c', sport: 'nfl' }]);
    await settle();
    expect(teams()).toEqual([]);

    respond({ data: '[{"team":"a"}]' });
    await fetching;
    await settle();
    expect(teams()).toEqual(['a', 'c']);
  });
});

describe('defineSqliteStore — pushes and ETags', () => {
  function pushedStore() {
    let loaded = false;
    const store = defineSqliteStore({
      name: 'etag_store',
      schema: SCHEMA,
      partition: { fields: ['sport', 'season'] },
      fetch: {
        query: (_season: Season) => ({ queryFn: async () => ({ data: '[{"team":"a"}]', etag: 'W/"1"' }) }),
        toRows: (season, raw) => (JSON.parse(raw) as { team: string }[]).map(({ team }) => ({ team, sport: season.sport })),
      },
      push: { idOf: (game: Game) => game.team, partitionsOf: () => [NFL_2025], toRows: (key, games) => games.map((game) => ({ ...game, partition_key: key })) },
      build: (cellar) => ({
        reads: { Teams: cellar.defineRead<Season, number>({ select: () => 0, empty: 0 }) },
        lifecycle: { loaded: (season: Season) => (loaded = cellar.has(season)) },
      }),
    });
    const { surface, table } = store.testing.over(createSqlJsConnection());
    return { surface, table, wasLoaded: () => loaded };
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

  it('retires a partition’s ETag when a push writes to it, once per interval however many pushes land', async () => {
    const { surface, table } = pushedStore();
    await surface.lifecycle.fetch(NFL_2025);
    expect(table.getMeta({ partition_key: 'nfl:2025' })).toBe('W/"1"');

    surface.push.ingest([{ team: 'b', sport: 'nfl' }]);
    await settle();
    expect(table.getMeta({ partition_key: 'nfl:2025' })).toBeUndefined();

    table.setMeta({ partition_key: 'nfl:2025' }, 'W/"2"');
    surface.push.ingest([{ team: 'c', sport: 'nfl' }]);
    await settle();
    expect(table.getMeta({ partition_key: 'nfl:2025' })).toBe('W/"2"');
  });

  it('writes a push to the partitions it names that hold rows, or to all of them when none does', async () => {
    const store = defineSqliteStore({
      name: 'routed_store',
      schema: SCHEMA,
      partition: { fields: ['sport', 'season'] },
      fetch: {
        query: (_season: Season) => ({ queryFn: async () => ({ data: '[{"team":"a"}]' }) }),
        toRows: (season, raw) => (JSON.parse(raw) as { team: string }[]).map(({ team }) => ({ team, sport: season.sport })),
      },
      push: {
        idOf: (game: Game) => game.team,
        partitionsOf: () => [NFL_2025, NFL_2024],
        toRows: (key, games) => games.map((game) => ({ ...game, partition_key: key })),
      },
      build: (cellar) => ({ reads: { Teams: cellar.defineRead<Season, number>({ select: () => 0, empty: 0 }) } }),
    });
    const over = () => {
      const { surface, table } = store.testing.over(createSqlJsConnection());
      const teams = (key: string) => table.find({ partition_key: key }, { orderBy: 'team' }).map((row) => row.team);
      return { surface, teams };
    };

    const loaded = over();
    await loaded.surface.lifecycle.fetch(NFL_2025);
    loaded.surface.push.ingest([{ team: 'y', sport: 'nfl' }]);
    await settle();
    expect([loaded.teams('nfl:2025'), loaded.teams('nfl:2024')]).toEqual([['a', 'y'], []]);

    const unloaded = over();
    unloaded.surface.push.ingest([{ team: 'x', sport: 'nfl' }]);
    await settle();
    expect([unloaded.teams('nfl:2025'), unloaded.teams('nfl:2024')]).toEqual([['x'], ['x']]);
  });

  it('answers whether a partition holds rows from its description', async () => {
    const { surface, wasLoaded } = pushedStore();
    surface.lifecycle.loaded(NFL_2025);
    expect(wasLoaded()).toBe(false);

    await surface.lifecycle.fetch(NFL_2025);
    surface.lifecycle.loaded(NFL_2025);
    expect(wasLoaded()).toBe(true);
  });
});

describe('defineSqliteStore — a table declared before Cellar owned its partition column', () => {
  /** The same table as a store declared it by hand: its own `partition_key`, key, index, ETag table and spec. */
  const LEGACY: RowTableSchema<Game & { partition_key: string }> = {
    table: 'games',
    columns: { partition_key: { type: 'TEXT', notNull: true }, team: { type: 'TEXT', notNull: true }, sport: { type: 'TEXT', notNull: true } },
    primaryKey: ['partition_key', 'team'],
    entityId: 'team',
    indexes: [{ name: 'idx_games_partition', columns: ['partition_key', 'team'] }],
    meta: { table: 'games_meta', keyColumns: ['partition_key'], column: 'etag' },
  };
  const LEGACY_NATIVE: NativeShredSpec = {
    specs: {
      all: {
        version: 1,
        table: 'games',
        insertVerb: 'INSERT OR REPLACE',
        columns: ['partition_key', 'team', 'sport'],
        ops: [{ op: 'bind', index: 0 }, { op: 'text', path: 'team' }, { op: 'bind', index: 1 }],
        deleteWhere: [{ column: 'partition_key', bindIndex: 0 }],
      },
    },
    variant: () => 'all',
    binds: () => [],
  };

  it('rebuilds it as shared rows, dropping the ETags that described its rows', () => {
    const conn = createSqlJsConnection({ capabilities: 'full' });
    const legacy = createSqliteRowTable(LEGACY, conn, LEGACY_NATIVE);
    legacy.init();
    legacy.overwrite({ partition_key: 'nfl:2025' }, [{ partition_key: 'nfl:2025', team: 'a', sport: 'nfl' }]);
    legacy.setMeta({ partition_key: 'nfl:2025' }, 'W/"1"');

    const table = createSqliteRowTable(partitionedSchema(SCHEMA), conn, NATIVE as NativeShredSpec);
    table.init();

    expect(table.find({ partition_key: 'nfl:2025' })).toEqual([]);
    expect(table.getMeta({ partition_key: 'nfl:2025' })).toBeUndefined();
    expect(readRows<{ name: string }>(conn, 'PRAGMA table_info(games_meta);').map((column) => column.name)).toContain('partition');
  });
});
