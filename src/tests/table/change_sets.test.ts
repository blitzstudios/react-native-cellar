/**
 * What a write reports it changed, held to the same answers on every SQLite write path: a write
 * names exactly the entities that were added, removed or differ in any column, rewrites only those, and a write whose
 * payload matches the table changes nothing at all.
 */

import { createTestRowTable } from '../../testing/row_table';
import { createSqliteRowTable } from '../../table/sqlite';
import { RowTable, RowTableSchema } from '../../table/types';
import { ALL_ENTITIES, ChangeSet } from '../../table/change_set';
import { createSqlJsConnection, initSqlJs, SqlJsConnection } from '../../testing/sqljs_connection';
import { NativeShredSpec } from '../../write/shred_spec';
import { configureCellar, INERT_ERRORS } from '../../runtime';
import { resetOnceGuards } from '../../diagnostics/once_guard';

interface GameRow {
  [key: string]: string | number | null | undefined;
  partition_key: string;
  game_id: string;
  player_id: string;
  pts: number | null;
  note: string | null;
}

/** A player's games in a week: several rows, one entity. */
const games: RowTableSchema<GameRow> = {
  table: 'games',
  columns: {
    partition_key: { type: 'TEXT' },
    game_id: { type: 'TEXT' },
    player_id: { type: 'TEXT' },
    pts: { type: 'REAL' },
    note: { type: 'TEXT' },
  },
  primaryKey: ['partition_key', 'game_id', 'player_id'],
  entityId: 'player_id',
};

const game = (player: string, id: string, pts: number | null, note: string | null = null, partition = 'w1'): GameRow => ({
  partition_key: partition,
  game_id: id,
  player_id: player,
  pts,
  note,
});

const week = [game('p1', 'g1', 10), game('p1', 'g2', 12), game('p2', 'g1', 7), game('p3', 'g1', 3)];

const entityIds = (changes: ChangeSet): string[] | 'all' => (changes === ALL_ENTITIES ? 'all' : [...changes].sort());

/** The game-per-row payload as the native shred reads it, one element per row. */
const nativeSpec: NativeShredSpec = {
  specs: {
    all: {
      version: 1,
      table: 'games',
      insertVerb: 'INSERT OR REPLACE',
      columns: ['partition_key', 'game_id', 'player_id', 'pts', 'note'],
      ops: [
        { op: 'bind', index: 0 },
        { op: 'text', path: 'game_id' },
        { op: 'text', path: 'player_id' },
        { op: 'real', path: 'pts' },
        { op: 'text', path: 'note' },
      ],
      deleteWhere: [{ column: 'partition_key', bindIndex: 0 }],
    },
  },
  variant: () => 'all',
  binds: (where) => [String(where.partition_key)],
};

interface Backend {
  name: string;
  make: () => { table: RowTable<GameRow>; conn?: SqlJsConnection };
  /** Writes a whole partition the way this backend's ingest does. */
  replace: (table: RowTable<GameRow>, rows: GameRow[]) => Promise<ChangeSet>;
}

const toJson = (rows: GameRow[]): string => JSON.stringify(rows.map(({ partition_key: _p, ...rest }) => rest));

const backends: Backend[] = [
  {
    name: 'sqlite, synchronous overwrite',
    make: () => {
      const conn = createSqlJsConnection({ capabilities: 'full' });
      const table = createSqliteRowTable(games, conn);
      table.init();
      return { table, conn };
    },
    replace: async (table, rows) => table.overwrite({ partition_key: 'w1' }, rows).changes,
  },
  {
    name: 'sqlite, JS parse',
    make: () => {
      const conn = createSqlJsConnection({ capabilities: 'full' });
      const table = createSqliteRowTable(games, conn);
      table.init();
      return { table, conn };
    },
    replace: async (table, rows) => (await table.shred({ partition_key: 'w1' }, toJson(rows), () => rows)).changes,
  },
  {
    name: 'sqlite, native shred',
    make: () => {
      const conn = createSqlJsConnection({ capabilities: 'full' });
      const table = createSqliteRowTable(games, conn, nativeSpec);
      table.init();
      return { table, conn };
    },
    replace: async (table, rows) =>
      (
        await table.shred({ partition_key: 'w1' }, toJson(rows), () => {
          throw new Error('the native shred should have handled this body');
        })
      ).changes,
  },
  {
    name: 'sqlite, execute only',
    make: () => {
      const conn = createSqlJsConnection({ capabilities: 'minimal' });
      const table = createSqliteRowTable(games, conn);
      table.init();
      return { table, conn };
    },
    replace: async (table, rows) => (await table.shred({ partition_key: 'w1' }, toJson(rows), () => rows)).changes,
  },
];

beforeAll(async () => {
  await initSqlJs();
});

describe.each(backends)('change sets — $name', ({ make, replace }) => {
  it('reports every entity on a first load', async () => {
    const { table } = make();
    expect(entityIds(await replace(table, week))).toEqual(['p1', 'p2', 'p3']);
    expect(table.find({ partition_key: 'w1' })).toHaveLength(4);
  });

  it('reports nothing for a payload the table already holds', async () => {
    const { table } = make();
    await replace(table, week);
    expect(entityIds(await replace(table, week))).toEqual([]);
    expect(table.find({ partition_key: 'w1' })).toHaveLength(4);
  });

  it('reports only the entity whose row moved, even when it is one row of several', async () => {
    const { table } = make();
    await replace(table, week);
    const next = [game('p1', 'g1', 10), game('p1', 'g2', 13), game('p2', 'g1', 7), game('p3', 'g1', 3)];
    expect(entityIds(await replace(table, next))).toEqual(['p1']);
    expect(table.find({ partition_key: 'w1', player_id: 'p1' }).map((row) => row.pts).sort()).toEqual([10, 13]);
  });

  it('reports an entity that arrived and one that left', async () => {
    const { table } = make();
    await replace(table, week);
    const next = [game('p1', 'g1', 10), game('p1', 'g2', 12), game('p2', 'g1', 7), game('p4', 'g1', 1)];
    expect(entityIds(await replace(table, next))).toEqual(['p3', 'p4']);
    expect(table.find({ partition_key: 'w1', player_id: 'p3' })).toEqual([]);
    expect(table.find({ partition_key: 'w1', player_id: 'p4' })).toHaveLength(1);
  });

  it('reports an entity that lost one of its rows', async () => {
    const { table } = make();
    await replace(table, week);
    const next = [game('p1', 'g1', 10), game('p2', 'g1', 7), game('p3', 'g1', 3)];
    expect(entityIds(await replace(table, next))).toEqual(['p1']);
    expect(table.find({ partition_key: 'w1', player_id: 'p1' })).toHaveLength(1);
  });

  it('tells a null from a value in either direction, and a null from a null not at all', async () => {
    const { table } = make();
    await replace(table, week);
    expect(entityIds(await replace(table, [game('p1', 'g1', null), game('p1', 'g2', 12), game('p2', 'g1', 7), game('p3', 'g1', 3)]))).toEqual(['p1']);
    expect(entityIds(await replace(table, [game('p1', 'g1', null), game('p1', 'g2', 12), game('p2', 'g1', 7), game('p3', 'g1', 3)]))).toEqual([]);
    expect(entityIds(await replace(table, [game('p1', 'g1', null), game('p1', 'g2', 12), game('p2', 'g1', 7, 'Q'), game('p3', 'g1', 3)]))).toEqual(['p2']);
  });

  it('empties the partition and reports everyone for a payload of nothing', async () => {
    const { table } = make();
    await replace(table, week);
    expect(entityIds(await replace(table, []))).toEqual(['p1', 'p2', 'p3']);
    expect(table.find({ partition_key: 'w1' })).toEqual([]);
  });

  it('leaves other partitions alone', async () => {
    const { table } = make();
    await table.overwrite({ partition_key: 'w2' }, [game('p1', 'g9', 1, null, 'w2')]);
    await replace(table, week);
    expect(entityIds(await replace(table, []))).toEqual(['p1', 'p2', 'p3']);
    expect(table.find({ partition_key: 'w2' })).toHaveLength(1);
  });
});

describe('change sets — merging socket rows', () => {
  it('reports the entities of rows that differ, and leaves the rest of each entity where it is', async () => {
    const table = createTestRowTable(games);
    table.overwrite({ partition_key: 'w1' }, week);
    const { changes } = await table.upsert([game('p1', 'g2', 20), game('p2', 'g1', 7)]);
    expect(entityIds(changes)).toEqual(['p1']);
    expect(table.find({ partition_key: 'w1', player_id: 'p1' }).map((row) => row.pts).sort()).toEqual([10, 20]);
  });

  it('reports nothing for a push repeating what the table holds', async () => {
    const table = createTestRowTable(games);
    table.overwrite({ partition_key: 'w1' }, week);
    const { changes, rows } = await table.upsert([game('p2', 'g1', 7)]);
    expect(entityIds(changes)).toEqual([]);
    expect(rows).toBe(1);
  });
});

describe('change sets — a table without a primary key', () => {
  interface SideRow {
    [key: string]: string | number | null | undefined;
    season: string;
    team: string;
    week: number;
    opponent: string | null;
  }
  const sides: RowTableSchema<SideRow> = {
    table: 'sides',
    columns: { season: { type: 'TEXT' }, team: { type: 'TEXT' }, week: { type: 'INTEGER' }, opponent: { type: 'TEXT' } },
    primaryKey: [],
    entityId: 'team',
  };
  const side = (team: string, wk: number, opponent: string | null): SideRow => ({ season: '2026', team, week: wk, opponent });

  it('compares an entity as a multiset, so one duplicate more is a change and the same rows reordered are not', () => {
    const table = createTestRowTable(sides);
    const where = { season: '2026' };
    table.overwrite(where, [side('KC', 1, 'BUF'), side('KC', 1, 'BUF'), side('SF', 1, 'LA')]);
    expect(entityIds(table.overwrite(where, [side('SF', 1, 'LA'), side('KC', 1, 'BUF'), side('KC', 1, 'BUF')]).changes)).toEqual([]);
    expect(entityIds(table.overwrite(where, [side('KC', 1, 'BUF'), side('SF', 1, 'LA')]).changes)).toEqual(['KC']);
    expect(table.find({ season: '2026', team: 'KC' })).toHaveLength(1);
    expect(entityIds(table.overwrite(where, [side('KC', 1, 'BUF'), side('SF', 1, null)]).changes)).toEqual(['SF']);
  });
});

describe('change sets — SQLite rewrites only what changed', () => {
  it('writes a first load straight into the table, and stages only once there is something to compare against', async () => {
    const conn = createSqlJsConnection({ capabilities: 'full' });
    const table = createSqliteRowTable(games, conn, nativeSpec);
    table.init();
    const staged = () => conn.executed.filter((sql) => sql.includes('_stage_') && sql.startsWith('INSERT')).length;

    await table.shred({ partition_key: 'w1' }, toJson(week), () => week);
    expect(staged()).toBe(0);
    await table.shred({ partition_key: 'w1' }, toJson(week), () => week);
    expect(staged()).toBeGreaterThan(0);
  });

  it('leaves an unchanged entity physically untouched, so its rows keep their rowids', async () => {
    const conn = createSqlJsConnection({ capabilities: 'full' });
    const table = createSqliteRowTable(games, conn);
    table.init();
    table.overwrite({ partition_key: 'w1' }, week);
    const rowids = () =>
      Object.fromEntries(
        (conn.execute('SELECT player_id, game_id, rowid AS r FROM games;').rows?._array as Array<{ player_id: string; game_id: string; r: number }>).map(
          (row) => [`${row.player_id}/${row.game_id}`, row.r],
        ),
      );
    const before = rowids();
    table.overwrite({ partition_key: 'w1' }, [game('p1', 'g1', 10), game('p1', 'g2', 12), game('p2', 'g1', 8), game('p3', 'g1', 3)]);
    const after = rowids();
    expect(after['p1/g1']).toBe(before['p1/g1']);
    expect(after['p3/g1']).toBe(before['p3/g1']);
    expect(after['p2/g1']).not.toBe(before['p2/g1']);
  });

  it('takes concurrent ingests one at a time, so neither empties the stage the other is about to diff', async () => {
    const conn = createSqlJsConnection({ capabilities: 'full' });
    const table = createSqliteRowTable(games, conn, nativeSpec);
    table.init();
    const w2 = [game('p9', 'g1', 1, null, 'w2')];
    const [first, second] = await Promise.all([
      table.shred({ partition_key: 'w1' }, toJson(week), () => week),
      table.shred({ partition_key: 'w2' }, toJson(w2), () => w2),
    ]);
    expect(entityIds(first.changes)).toEqual(['p1', 'p2', 'p3']);
    expect(entityIds(second.changes)).toEqual(['p9']);
    expect(table.find({ partition_key: 'w1' })).toHaveLength(4);
    expect(table.find({ partition_key: 'w2' })).toHaveLength(1);
  });

  it('reports every entity when it cannot find its own diff, rather than reporting none and going stale', async () => {
    resetOnceGuards();
    const captureMessage = jest.fn();
    const captureException = jest.fn();
    configureCellar({ errors: { captureException, captureMessage } });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const conn = createSqlJsConnection({ capabilities: 'full' });
    let silence = false;
    const silent = {
      ...conn,
      execute: (sql: string, params?: ReadonlyArray<string | number | null>) => (silence && /RETURNING/.test(sql) ? { rows: { _array: [] } } : conn.execute(sql, params)),
    };
    const table = createSqliteRowTable(games, silent);
    table.init();
    table.overwrite({ partition_key: 'w1' }, week);
    silence = true;

    expect(table.overwrite({ partition_key: 'w1' }, week).changes).toBe(ALL_ENTITIES);
    const reports = [...captureMessage.mock.calls, ...captureException.mock.calls];
    expect(reports.map((call) => call[1].tags)).toContainEqual({ cellar_degradation: 'row_table.diff_lost.games' });

    configureCellar({ errors: INERT_ERRORS });
    warn.mockRestore();
  });
});
