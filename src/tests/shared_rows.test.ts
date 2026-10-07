import { installTestRuntime } from '../testing/runtime';
import { createSqlJsConnection } from '../testing/sqljs_connection';
import { defineSqliteStore } from '../define_sqlite_store';
import { byEntity } from '../read/derived_values';
import { runTracked } from '../reactivity/tracking';
import { readRows } from '../table/connection';
import { StoreTableSchema } from '../table/partitioned';
import { ShredSpec } from '../write/shred_spec';

jest.mock('../diagnostics/telemetry', () => ({ reportStoreDegradation: jest.fn() }));

installTestRuntime();

type Player = { sport: string; player_id: string; team: string | null; height: string | null };
type PlayerPartition = { request?: 'sport'; sport: string } | { request: 'player'; sport: string; playerId: string };
type PlayerArgs = { sport: string; playerId: string };

const PLAYERS: StoreTableSchema<Player> = {
  table: 'players',
  columns: {
    sport: { type: 'TEXT', notNull: true },
    player_id: { type: 'TEXT', notNull: true },
    team: { type: 'TEXT' },
    height: { type: 'TEXT' },
  },
  primaryKey: ['sport', 'player_id'],
  entityId: 'player_id',
  indexes: [{ name: 'idx_players_team', columns: ['partition_key', 'team'] }],
};

const CATALOG_NATIVE: Record<string, ShredSpec> = {
  all: {
    version: 1,
    table: 'players',
    insertVerb: 'INSERT OR REPLACE',
    source: 'objectValues',
    columns: ['sport', 'player_id', 'team', 'height'],
    ops: [
      { op: 'bind', index: 1 },
      { op: 'text', path: 'player_id' },
      { op: 'text', path: 'team' },
      { op: 'text', path: 'height' },
    ],
  },
};

/** What the server answers: the catalog per sport, and each player's own record. */
function playerServer() {
  const catalog: Record<string, Record<string, { player_id: string; team: string }>> = {
    nfl: { p1: { player_id: 'p1', team: 'SF' }, p2: { player_id: 'p2', team: 'KC' } },
  };
  const detail: Record<string, { player_id: string; team: string; height: string } | null> = {
    p1: { player_id: 'p1', team: 'SF', height: '72' },
    p2: { player_id: 'p2', team: 'KC', height: '75' },
  };
  return { catalog, detail };
}

function playerStore(over: { native?: boolean } = {}) {
  const server = playerServer();
  const store = defineSqliteStore({
    name: 'players_store',
    schema: PLAYERS,
    partition: {
      fields: ['sport'],
      fromArgs: ({ sport }: { sport?: string }): PlayerPartition | null => (sport ? { sport } : null),
    },
    fetch: (p: PlayerPartition) => {
      type Body = { player_id: string; team: string; height?: string };
      const toRow = (one: Body) => ({ sport: p.sport, player_id: one.player_id, team: one.team ?? null, height: one.height ?? null });
      return p.request === 'player'
        ? {
            queryFn: async () => ({ data: JSON.stringify(server.detail[p.playerId]) }),
            toRows: (raw: string) => [JSON.parse(raw) as Body].map(toRow),
          }
        : {
            queryFn: async () => ({ data: JSON.stringify(server.catalog[p.sport]) }),
            toRows: (raw: string) => Object.values(JSON.parse(raw) as Record<string, Body>).map(toRow),
            ...(over.native ? { native: { variant: 'all', binds: [p.sport] } } : {}),
            fills: ['team'] as const,
          };
    },
    nativeShredSpecs: over.native ? CATALOG_NATIVE : undefined,
    build: (cellar) => {
      const { cards } = cellar.defineCaches({
        cards: byEntity({ max: 64, fromRows: ([row]) => (row ? { id: row.player_id, team: row.team, height: row.height } : undefined) }),
      });
      return {
        reads: {
          Card: cellar.defineRead<PlayerArgs, { id: string; team: string | null; height: string | null } | undefined>({
            select: (args, key) => cards.at(key, args.playerId),
            empty: undefined,
          }),
          Detail: cellar.defineRead<PlayerArgs, { id: string; team: string | null; height: string | null } | undefined>({
            partition: ({ sport, playerId }) => cellar.keyOf({ request: 'player', sport, playerId }),
            select: (args, key) => cards.at(key, args.playerId),
            empty: undefined,
          }),
        },
      };
    },
  });
  const conn = createSqlJsConnection({ capabilities: over.native ? 'full' : 'minimal' });
  const { surface, table } = store.testing.over(conn);
  const fetchCatalog = () => surface.lifecycle.fetch({ sport: 'nfl' } as never, { staleTime: 0 });
  const stored = () => readRows<Player>(conn, 'SELECT sport, player_id, team, height FROM players__rows ORDER BY player_id;');
  return { surface, table, conn, server, fetchCatalog, stored };
}

const P1 = { sport: 'nfl', playerId: 'p1' };

describe('shared rows — a catalog and one player’s detail', () => {
  it('writes both into one row, so the catalog’s readers see what the detail brought', async () => {
    const { surface, fetchCatalog, stored } = playerStore();
    await fetchCatalog();
    expect(surface.reads.Card.getValue(P1)).toEqual({ id: 'p1', team: 'SF', height: null });

    surface.reads.Detail.getValue(P1);
    await surface.lifecycle.fetch({ request: 'player', sport: 'nfl', playerId: 'p1' } as never);

    expect(stored()).toEqual([
      { sport: 'nfl', player_id: 'p1', team: 'SF', height: '72' },
      { sport: 'nfl', player_id: 'p2', team: 'KC', height: null },
    ]);
    expect(surface.reads.Card.getValue(P1)).toEqual({ id: 'p1', team: 'SF', height: '72' });
    expect(surface.reads.Detail.getValue(P1)).toEqual({ id: 'p1', team: 'SF', height: '72' });
  });

  it('keeps the columns a catalog refetch does not carry, and moves the ones it does for every reader', async () => {
    const { surface, server, fetchCatalog, stored } = playerStore();
    await fetchCatalog();
    surface.reads.Detail.getValue(P1);
    await surface.lifecycle.fetch({ request: 'player', sport: 'nfl', playerId: 'p1' } as never);

    server.catalog.nfl.p1 = { player_id: 'p1', team: 'LV' };
    await fetchCatalog();

    expect(stored()[0]).toEqual({ sport: 'nfl', player_id: 'p1', team: 'LV', height: '72' });
    expect(surface.reads.Detail.getValue(P1)).toEqual({ id: 'p1', team: 'LV', height: '72' });
  });

  it('wakes a catalog reader when the detail changes its player, and nobody else', async () => {
    const { surface, fetchCatalog } = playerStore();
    await fetchCatalog();
    const p1 = jest.fn();
    const p2 = jest.fn();
    for (const dep of runTracked(() => surface.reads.Card.getValue(P1)).deps) dep.subscribe(p1);
    for (const dep of runTracked(() => surface.reads.Card.getValue({ sport: 'nfl', playerId: 'p2' })).deps) dep.subscribe(p2);

    surface.reads.Detail.getValue(P1);
    await surface.lifecycle.fetch({ request: 'player', sport: 'nfl', playerId: 'p1' } as never);

    expect(p1).toHaveBeenCalled();
    expect(p2).not.toHaveBeenCalled();
  });

  it('keeps a row the catalog dropped while the detail still holds it, and deletes one nothing holds', async () => {
    const { surface, server, fetchCatalog, stored } = playerStore();
    await fetchCatalog();
    surface.reads.Detail.getValue(P1);
    await surface.lifecycle.fetch({ request: 'player', sport: 'nfl', playerId: 'p1' } as never);

    delete server.catalog.nfl.p1;
    delete server.catalog.nfl.p2;
    await fetchCatalog();

    expect(surface.reads.Card.getValue(P1)).toBeUndefined();
    expect(surface.reads.Detail.getValue(P1)).toEqual({ id: 'p1', team: 'SF', height: '72' });
    expect(stored().map((row) => row.player_id)).toEqual(['p1']);
  });

  it('writes the catalog through the native shred into the same rows', async () => {
    const { surface, fetchCatalog, stored } = playerStore({ native: true });
    await fetchCatalog();
    surface.reads.Detail.getValue(P1);
    await surface.lifecycle.fetch({ request: 'player', sport: 'nfl', playerId: 'p1' } as never);
    await fetchCatalog();

    expect(stored()).toEqual([
      { sport: 'nfl', player_id: 'p1', team: 'SF', height: '72' },
      { sport: 'nfl', player_id: 'p2', team: 'KC', height: null },
    ]);
  });
});

type Stat = { week: number; game_id: string; player_id: string; pts: number | null };
type StatPartition = { request: 'week'; week: number } | { request: 'game'; gameId: string };

const STATS: StoreTableSchema<Stat> = {
  table: 'stats',
  columns: {
    week: { type: 'INTEGER', notNull: true },
    game_id: { type: 'TEXT', notNull: true },
    player_id: { type: 'TEXT', notNull: true },
    pts: { type: 'REAL' },
  },
  primaryKey: ['week', 'game_id', 'player_id'],
  entityId: 'player_id',
  pushFed: true,
};

function statStore() {
  const weekBody: Stat[] = [
    { week: 3, game_id: 'g1', player_id: 'a', pts: 10 },
    { week: 3, game_id: 'g2', player_id: 'b', pts: 4 },
  ];
  const store = defineSqliteStore({
    name: 'stats_store',
    schema: STATS,
    partition: {
      fromArgs: (args: { week?: number; gameId?: string }): StatPartition | null =>
        args.gameId ? { request: 'game', gameId: args.gameId } : args.week ? { request: 'week', week: args.week } : null,
    },
    fetch: (p: StatPartition) => ({
      queryFn: async () => ({ data: JSON.stringify(p.request === 'week' ? weekBody : weekBody.filter((stat) => stat.game_id === p.gameId)) }),
      toRows: (raw) => JSON.parse(raw) as Stat[],
    }),
    push: {
      idOf: (stat: Stat) => `${stat.game_id}_${stat.player_id}`,
      partitionsOf: (stat: Stat) => [{ request: 'week', week: stat.week } as StatPartition],
      toRows: (key, stats) => stats.map((stat) => ({ ...stat, partition_key: key })),
    },
    build: (cellar) => ({
      reads: {
        Points: cellar.defineRead<{ gameId: string; playerId: string }, number | null>({
          partition: ({ gameId }) => cellar.keyOf({ request: 'game', gameId }),
          select: (args, key) => cellar.rows(key, { player_id: args.playerId }).rows[0]?.pts ?? null,
          empty: null,
        }),
      },
    }),
  });
  const conn = createSqlJsConnection({ capabilities: 'minimal' });
  const { surface } = store.testing.over(conn);
  const stored = () => readRows<Stat>(conn, 'SELECT week, game_id, player_id, pts FROM stats__rows ORDER BY game_id;');
  return { surface, conn, stored };
}

describe('shared rows — a week and one of its games', () => {
  it('stores each stat line once, and a push into the week wakes the game’s reader', async () => {
    const { surface, stored } = statStore();
    await surface.lifecycle.fetch({ week: 3 } as never);
    const args = { gameId: 'g1', playerId: 'a' };
    surface.reads.Points.getValue(args);
    await surface.lifecycle.fetch({ gameId: 'g1' } as never);
    expect(stored()).toHaveLength(2);

    const woken = jest.fn();
    for (const dep of runTracked(() => surface.reads.Points.getValue(args)).deps) dep.subscribe(woken);
    surface.push!.ingest([{ week: 3, game_id: 'g1', player_id: 'a', pts: 12 }]);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(woken).toHaveBeenCalled();
    expect(surface.reads.Points.getValue(args)).toBe(12);
    expect(stored()).toHaveLength(2);
  });
});

describe('shared rows — the layout on disk', () => {
  it('rebuilds a table from the layout before rows were shared', () => {
    const conn = createSqlJsConnection({ capabilities: 'minimal' });
    conn.execute('CREATE TABLE players (partition_key TEXT NOT NULL, sport TEXT NOT NULL, player_id TEXT NOT NULL, PRIMARY KEY (partition_key, player_id));');
    conn.execute(`INSERT INTO players VALUES ('nfl', 'nfl', 'p1');`);

    const store = defineSqliteStore({ name: 'players_store', schema: PLAYERS, partition: { fields: ['sport'] }, build: () => ({ reads: {} }) });
    store.testing.over(conn);

    expect(readRows<{ type: string }>(conn, `SELECT type FROM sqlite_master WHERE name = 'players';`)[0].type).toBe('view');
    expect(readRows(conn, 'SELECT * FROM players;')).toEqual([]);
  });

  it('refuses a table without a primary key, which has no identity to share rows by', () => {
    expect(() =>
      defineSqliteStore({ name: 'loose_store', schema: { ...PLAYERS, primaryKey: [] }, partition: { fields: ['sport'] }, build: () => ({ reads: {} }) }).testing.over(
        createSqlJsConnection({ capabilities: 'minimal' }),
      ),
    ).toThrow(/needs a primary key/);
  });

  it('keeps a stored row a staged copy is older than', async () => {
    const conn = createSqlJsConnection({ capabilities: 'minimal' });
    type Line = { game_id: string; player_id: string; pts: number | null; updated_at: number | null };
    const store = defineSqliteStore({
      name: 'lines_store',
      schema: {
        table: 'lines',
        columns: {
          game_id: { type: 'TEXT', notNull: true },
          player_id: { type: 'TEXT', notNull: true },
          pts: { type: 'REAL' },
          updated_at: { type: 'INTEGER' },
        },
        primaryKey: ['game_id', 'player_id'],
        entityId: 'player_id',
        newerBy: 'updated_at',
      } as StoreTableSchema<Line>,
      partition: { fields: ['game_id'] },
      build: () => ({ reads: {} }),
    });
    const { table } = store.testing.over(conn);
    table.overwrite({ partition_key: 'g1' }, [{ game_id: 'g1', player_id: 'a', pts: 12, updated_at: 200 }]);
    table.overwrite({ partition_key: 'week' }, [{ game_id: 'g1', player_id: 'a', pts: 10, updated_at: 100 }]);

    expect(readRows(conn, 'SELECT pts, updated_at FROM lines__rows;')).toEqual([{ pts: 12, updated_at: 200 }]);
    expect(table.find({ partition_key: 'week' })).toHaveLength(1);
  });
});
