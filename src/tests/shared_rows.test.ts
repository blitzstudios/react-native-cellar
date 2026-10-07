import { installTestRuntime } from '../testing/runtime';
import { createSqlJsConnection } from '../testing/sqljs_connection';
import { defineSqliteStore } from '../define_sqlite_store';
import { byEntity } from '../read/derived_values';
import { runTracked } from '../reactivity/tracking';
import { readRows } from '../table/connection';
import { StoreTableSchema } from '../table/partitioned';
import { NativeShredSpec } from '../write/shred_spec';

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
  primaryKey: ['player_id'],
  entityId: 'player_id',
  indexes: [{ name: 'idx_players_team', columns: ['partition_key', 'team'] }],
  sharedRows: { across: ['sport'] },
};

const CATALOG_NATIVE: NativeShredSpec<PlayerPartition> = {
  specs: {
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
  },
  variant: () => 'all',
  binds: ({ sport }) => [sport],
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
      toKey: (p: PlayerPartition) => (p.request === 'player' ? `player:${p.sport}:${p.playerId}` : p.sport),
    },
    fetch: {
      query: (p: PlayerPartition) => ({
        queryFn: async () => ({ data: JSON.stringify(p.request === 'player' ? server.detail[p.playerId] : server.catalog[p.sport]) }),
      }),
      toRows: (p, raw) => {
        const body = JSON.parse(raw) as Record<string, { player_id: string; team: string; height?: string }> | { player_id: string } | null;
        const players = p.request === 'player' ? (body ? [body as { player_id: string; team: string; height?: string }] : []) : Object.values(body ?? {});
        return players.map((one) => ({ sport: p.sport, player_id: one.player_id, team: one.team ?? null, height: one.height ?? null }));
      },
      canShredNatively: (p) => p.request !== 'player',
      carries: (p) => (p.request === 'player' ? undefined : ['team']),
    },
    nativeShredSpec: over.native ? CATALOG_NATIVE : undefined,
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
  const stored = () => readRows<Player>(conn, 'SELECT * FROM players__rows ORDER BY player_id;');
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
  sharedRows: {},
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
      toKey: (p: StatPartition) => (p.request === 'game' ? `game:${p.gameId}` : `week:${p.week}`),
    },
    fetch: {
      query: (p: StatPartition) => ({
        queryFn: async () => ({ data: JSON.stringify(p.request === 'week' ? weekBody : weekBody.filter((stat) => stat.game_id === p.gameId)) }),
      }),
      toRows: (_p, raw) => JSON.parse(raw) as Stat[],
    },
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
  const stored = () => readRows<Stat>(conn, 'SELECT * FROM stats__rows ORDER BY game_id;');
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
  it('rebuilds a table from the old layout into the shared one, and back', () => {
    const conn = createSqlJsConnection({ capabilities: 'minimal' });
    conn.execute('CREATE TABLE players (partition_key TEXT NOT NULL, sport TEXT NOT NULL, player_id TEXT NOT NULL, PRIMARY KEY (partition_key, player_id));');

    const shared = defineSqliteStore({ name: 'players_store', schema: PLAYERS, partition: { fields: ['sport'] }, build: () => ({ reads: {} }) });
    shared.testing.over(conn);
    expect(readRows<{ type: string }>(conn, `SELECT type FROM sqlite_master WHERE name = 'players';`)[0].type).toBe('view');

    const plain = defineSqliteStore({
      name: 'players_store',
      schema: { ...PLAYERS, sharedRows: undefined },
      partition: { fields: ['sport'] },
      build: () => ({ reads: {} }),
    });
    plain.testing.over(conn);
    expect(readRows<{ type: string }>(conn, `SELECT type FROM sqlite_master WHERE name = 'players';`)[0].type).toBe('table');
    expect(readRows(conn, `SELECT name FROM sqlite_master WHERE name GLOB 'players__*';`)).toEqual([]);
  });
});
