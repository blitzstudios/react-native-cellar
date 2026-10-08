import { installTestRuntime } from '../testing/runtime';
import { createSqlJsConnection } from '../testing/sqljs_connection';
import { defineSqliteStore } from '../define_sqlite_store';
import { byEntity } from '../read/derived_values';
import { runTracked } from '../reactivity/tracking';
import { readRows } from '../table/connection';
import { StoreTableSchema } from '../table/partitioned';
import { ShredSpec } from '../write/shred_spec';
import { defineShredColumns, ShredColumn } from '../write/shred_columns';

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
  uniqueBy: ['sport', 'player_id'],
  entityId: 'player_id',
  indexes: [{ name: 'idx_players_team', columns: ['team'] }],
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
    partition: ({ sport }: { sport?: string }): PlayerPartition | null => (sport ? { sport } : null),
    fetch: (p: PlayerPartition) => {
      type Body = { player_id: string; team: string; height?: string };
      // A field the body leaves out stays undefined, so the write keeps what another body stored.
      const toRow = (one: Body) => ({ sport: p.sport, player_id: one.player_id, team: one.team, height: one.height }) as Player;
      return p.request === 'player'
        ? {
            query: { queryFn: async () => ({ data: JSON.stringify(server.detail[p.playerId]) }) },
            toRows: (raw: string) => [JSON.parse(raw) as Body].map(toRow),
          }
        : {
            query: { queryFn: async () => ({ data: JSON.stringify(server.catalog[p.sport]) }) },
            toRows: (raw: string) => Object.values(JSON.parse(raw) as Record<string, Body>).map(toRow),
            ...(over.native ? { native: { variant: 'all', binds: [p.sport] } } : {}),
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
  uniqueBy: ['week', 'game_id', 'player_id'],
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
    partition: (args: { week?: number; gameId?: string }): StatPartition | null =>
        args.gameId ? { request: 'game', gameId: args.gameId } : args.week ? { request: 'week', week: args.week } : null,
    fetch: (p: StatPartition) => ({
      query: { queryFn: async () => ({ data: JSON.stringify(p.request === 'week' ? weekBody : weekBody.filter((stat) => stat.game_id === p.gameId)) }) },
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

    const store = defineSqliteStore({ name: 'players_store', schema: PLAYERS, partition: ({ sport }: { sport?: string }) => (sport ? { sport } : null), build: () => ({ reads: {} }) });
    store.testing.over(conn);

    expect(readRows<{ type: string }>(conn, `SELECT type FROM sqlite_master WHERE name = 'players';`)[0].type).toBe('view');
    expect(readRows(conn, 'SELECT * FROM players;')).toEqual([]);
  });

  it('reads a filtered partition from the rows table’s index rather than walking the partition', () => {
    const conn = createSqlJsConnection({ capabilities: 'minimal' });
    const define = () => defineSqliteStore({ name: 'players_store', schema: PLAYERS, partition: ({ sport }: { sport?: string }) => (sport ? { sport } : null), build: () => ({ reads: {} }) });
    define().testing.over(conn);
    const plan = () =>
      readRows<{ detail: string }>(conn, `EXPLAIN QUERY PLAN SELECT * FROM players WHERE partition_key = 'sport=nfl' AND team = 'SF';`)
        .map((row) => row.detail)
        .join(' | ');

    expect(plan()).toMatch(/^SEARCH r USING INDEX idx_players_team \(team=\?\)/);

    const stats = () => readRows(conn, `SELECT idx, stat FROM sqlite_stat1 WHERE tbl = 'players__members' ORDER BY idx;`);
    const written = stats();
    define().testing.over(conn);
    expect(stats()).toEqual(written);
    expect(written).toHaveLength(2);
  });

  it('creates the indexes on the rows table, one per set of columns', () => {
    const conn = createSqlJsConnection({ capabilities: 'minimal' });
    const schema = { ...PLAYERS, indexes: [...(PLAYERS.indexes ?? []), { name: 'idx_players_player', columns: [PLAYERS.entityId] }] };
    defineSqliteStore({ name: 'players_store', schema, partition: ({ sport }: { sport?: string }) => (sport ? { sport } : null), build: () => ({ reads: {} }) }).testing.over(conn);
    const indexes = readRows<{ name: string; tbl_name: string }>(conn, `SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%' ORDER BY name;`);

    expect(indexes).toEqual([
      { name: 'idx_players_entity', tbl_name: 'players__rows' },
      { name: 'idx_players_team', tbl_name: 'players__rows' },
    ]);
  });

  it('refuses a table without `uniqueBy`, which has no identity to share rows by', () => {
    expect(() =>
      defineSqliteStore({ name: 'loose_store', schema: { ...PLAYERS, uniqueBy: [] }, partition: ({ sport }: { sport?: string }) => (sport ? { sport } : null), build: () => ({ reads: {} }) }).testing.over(
        createSqlJsConnection({ capabilities: 'minimal' }),
      ),
    ).toThrow(/needs `uniqueBy`/);
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
        uniqueBy: ['game_id', 'player_id'],
        entityId: 'player_id',
        newerBy: 'updated_at',
      } as StoreTableSchema<Line>,
      partition: ({ game_id }: { game_id?: string }) => (game_id ? { game_id } : null),
      build: () => ({ reads: {} }),
    });
    const { table } = store.testing.over(conn);
    table.overwrite({ partition_key: 'g1' }, [{ game_id: 'g1', player_id: 'a', pts: 12, updated_at: 200 }]);
    table.overwrite({ partition_key: 'week' }, [{ game_id: 'g1', player_id: 'a', pts: 10, updated_at: 100 }]);

    expect(readRows(conn, 'SELECT pts, updated_at FROM lines__rows;')).toEqual([{ pts: 12, updated_at: 200 }]);
    expect(table.find({ partition_key: 'week' })).toHaveLength(1);
  });
});

type LineBody = { week: number; player_id: string; updated_at?: number; player?: { position: string | null }; stats?: Record<string, number> };
type LinePartition = { request: 'week'; week: number } | { request: 'player'; playerId: string };

const LINE_COLUMNS = [
  { name: 'week', type: 'INTEGER', notNull: true, op: { op: 'int', path: 'week' } },
  { name: 'player_id', type: 'TEXT', notNull: true, op: { op: 'text', path: 'player_id' } },
  { name: 'position', type: 'TEXT', op: { op: 'text', path: 'player.position' } },
  { name: 'pts', type: 'REAL', op: { op: 'real', path: 'stats.pts', complete: 'stats' } },
  { name: 'updated_at', type: 'INTEGER', op: { op: 'int', path: 'updated_at' } },
] as const satisfies readonly ShredColumn<LineBody>[];

const lineShred = defineShredColumns<LineBody>()(LINE_COLUMNS);

function lineStore(over: { native?: boolean } = {}) {
  const bodies: Record<LinePartition['request'], LineBody[]> = { week: [], player: [] };
  const store = defineSqliteStore({
    name: 'lines_store',
    schema: { table: 'lines', columns: lineShred.columnDefs, uniqueBy: ['week', 'player_id'], entityId: 'player_id', newerBy: 'updated_at' },
    partition: (args: { week?: number; playerId?: string }): LinePartition | null =>
      args.playerId ? { request: 'player', playerId: args.playerId } : args.week ? { request: 'week', week: args.week } : null,
    fetch: (p: LinePartition) => ({
      query: { queryFn: async () => ({ data: JSON.stringify(bodies[p.request]) }) },
      toRows: (raw: string) => (JSON.parse(raw) as LineBody[]).map((line) => lineShred.row(line, undefined)),
      ...(over.native ? { native: { variant: 'all' } } : {}),
    }),
    push: {
      idOf: (line: LineBody) => `${line.week}_${line.player_id}`,
      partitionsOf: (line: LineBody) => [{ request: 'week', week: line.week } as LinePartition],
      toRows: (key, lines) => lines.map((line) => ({ ...lineShred.row(line, undefined), partition_key: key })),
    },
    nativeShredSpecs: over.native ? { all: { version: 1, table: 'lines', insertVerb: 'INSERT OR REPLACE', columns: lineShred.names, ops: lineShred.ops } } : undefined,
    build: () => ({ reads: {} }),
  });
  const conn = createSqlJsConnection({ capabilities: over.native ? 'full' : 'minimal' });
  const { surface } = store.testing.over(conn);
  const fetch = (args: { week?: number; playerId?: string }) => surface.lifecycle.fetch(args as never, { staleTime: 0 });
  const stored = () => readRows(conn, 'SELECT week, player_id, position, pts, updated_at FROM lines__rows;');
  return { surface, conn, bodies, fetch, stored };
}

const FULL_LINE: LineBody = { week: 4, player_id: 'a', updated_at: 100, player: { position: 'QB' }, stats: { pts: 20 } };

describe.each([
  ['in JS', {}],
  ['natively', { native: true }],
])('shared rows — a body that leaves fields out, written %s', (_path, over) => {
  it('keeps the columns of a block the body leaves out, though the copy is no older', async () => {
    const { bodies, fetch, stored } = lineStore(over);
    bodies.week = [FULL_LINE];
    await fetch({ week: 4 });
    bodies.player = [{ week: 4, player_id: 'a', updated_at: 100, stats: { pts: 20 } }];
    await fetch({ playerId: 'a' });

    expect(stored()).toEqual([{ week: 4, player_id: 'a', position: 'QB', pts: 20, updated_at: 100 }]);
  });

  it('clears a field the body states as null, and a key its complete stats map leaves out', async () => {
    const { bodies, fetch, stored } = lineStore(over);
    bodies.week = [FULL_LINE];
    await fetch({ week: 4 });
    bodies.week = [{ week: 4, player_id: 'a', updated_at: 100, player: { position: null }, stats: {} }];
    await fetch({ week: 4 });

    expect(stored()).toEqual([{ week: 4, player_id: 'a', position: null, pts: null, updated_at: 100 }]);
  });

  it('keeps every stat when the body has no stats map, and leaves a new row’s absent columns null', async () => {
    const { bodies, fetch, stored } = lineStore(over);
    bodies.week = [FULL_LINE];
    await fetch({ week: 4 });
    bodies.player = [
      { week: 4, player_id: 'a', updated_at: 100, player: { position: 'QB' } },
      { week: 5, player_id: 'a' },
    ];
    await fetch({ playerId: 'a' });

    expect(stored()).toEqual([
      { week: 4, player_id: 'a', position: 'QB', pts: 20, updated_at: 100 },
      { week: 5, player_id: 'a', position: null, pts: null, updated_at: null },
    ]);
  });
});

describe('shared rows — a native shred that leaves fields out', () => {
  it('reads the absent columns from the staged element, without falling back to JS', async () => {
    const { conn, bodies, fetch, stored } = lineStore({ native: true });
    bodies.week = [FULL_LINE];
    await fetch({ week: 4 });
    bodies.player = [{ week: 4, player_id: 'a', updated_at: 100 }];
    await fetch({ playerId: 'a' });

    expect(conn.calls.shredJsonArrayAsync).toBe(2);
    expect(jest.requireMock('../diagnostics/telemetry').reportStoreDegradation).not.toHaveBeenCalled();
    expect(stored()).toEqual([{ week: 4, player_id: 'a', position: 'QB', pts: 20, updated_at: 100 }]);
  });
});

describe('shared rows — a push that leaves fields out', () => {
  it('keeps what the pushed line leaves out', async () => {
    const { surface, bodies, fetch, stored } = lineStore();
    bodies.week = [FULL_LINE];
    await fetch({ week: 4 });
    surface.push!.ingest([{ week: 4, player_id: 'a', updated_at: 101, stats: { pts: 25 } }]);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(stored()).toEqual([{ week: 4, player_id: 'a', position: 'QB', pts: 25, updated_at: 101 }]);
  });
});
