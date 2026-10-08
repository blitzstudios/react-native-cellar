/**
 * What a shared-rows write costs against the per-partition write it replaced, through the native shred, on a body
 * shaped like a live NFL stats week: 2,184 lines, each with a player block and a stats map that fills 202 of 372 stat
 * columns, and two fields no line sends. Opt-in, since it is a measurement and not a check:
 * `KERNEL_BENCH=1 yarn jest shared_rows.bench`.
 *
 * sql.js is SQLite compiled to WASM and the shred is emulated in JS, so only the SQL after the shred is compared, and
 * only as a ratio: both tables run on the same engine, over the same body, in the same process.
 */

import { createSqliteRowTable } from '../../table/sqlite';
import { createStoreTable } from '../../testing/row_table';
import { createSqlJsConnection, initSqlJs } from '../../testing/sqljs_connection';
import { ColumnDef, RowShape, RowTableSchema } from '../../table/types';
import { ShredOp, ShredSpec } from '../../write/shred_spec';

const bench = process.env.KERNEL_BENCH ? describe : describe.skip;

const ROWS = 2184;
const STATS = 372;
const FILLED = 202;

const BASE: Array<[string, ColumnDef['type'], ShredOp]> = [
  ['player_id', 'TEXT', { op: 'text', path: 'player_id' }],
  ['game_id', 'TEXT', { op: 'text', path: 'game_id' }],
  ['week', 'INTEGER', { op: 'int', path: 'week' }],
  ['updated_at', 'INTEGER', { op: 'int', path: 'updated_at' }],
  ['team', 'TEXT', { op: 'text', path: 'team' }],
  ['position', 'TEXT', { op: 'text', path: 'player.position' }],
  ['first_name', 'TEXT', { op: 'metaText', path: 'player.first_name' }],
  ['last_name', 'TEXT', { op: 'metaText', path: 'player.last_name' }],
  ['injury_status', 'TEXT', { op: 'text', path: 'player.injury_status' }],
  ['fantasy_positions', 'TEXT', { op: 'rawJsonField', path: 'player.fantasy_positions' }],
  ['status', 'TEXT', { op: 'metaText', path: 'player.status' }],
  ['team_changed_at', 'INTEGER', { op: 'int', path: 'team_changed_at' }],
  ['stats_json', 'TEXT', { op: 'rawJsonField', path: 'stats' }],
];
const STAT_COLUMNS: Array<[string, ColumnDef['type'], ShredOp]> = Array.from({ length: STATS }, (_, stat) => [
  `s_${stat}`,
  'REAL',
  { op: 'real', path: `stats.k${stat}`, complete: 'stats' },
]);
const COLUMNS = [...BASE, ...STAT_COLUMNS];
const columnDefs = Object.fromEntries(COLUMNS.map(([name, type]) => [name, { type }])) as Record<string, ColumnDef>;

const line = (index: number, bump: number) => ({
  player_id: `p${index}`,
  game_id: `g${index % 16}`,
  week: 4,
  updated_at: 100,
  team: 'KC',
  player: { position: 'WR', first_name: `F${index}`, last_name: `L${index}`, injury_status: null, fantasy_positions: ['WR'] },
  stats: Object.fromEntries(Array.from({ length: FILLED }, (_, stat) => [`k${stat}`, stat * 0.5 + index + bump])),
});
const body = (changed: number): string => JSON.stringify(Array.from({ length: ROWS }, (_, index) => line(index, index < changed ? 1 : 0)));

const sharedSpec: ShredSpec = { version: 1, table: 'stats_shared', insertVerb: 'INSERT OR REPLACE', columns: COLUMNS.map(([name]) => name), ops: COLUMNS.map(([, , op]) => op) };
const plainSpec: ShredSpec = {
  version: 1,
  table: 'stats_plain',
  insertVerb: 'INSERT OR REPLACE',
  columns: ['partition_key', ...COLUMNS.map(([name]) => name)],
  ops: [{ op: 'bind', index: 0 }, ...COLUMNS.map(([, , op]) => op)],
  deleteWhere: [{ column: 'partition_key', bindIndex: 0 }],
};
const plainSchema: RowTableSchema<RowShape> = {
  table: 'stats_plain',
  columns: { partition_key: { type: 'TEXT', notNull: true }, ...columnDefs },
  primaryKey: ['partition_key', 'week', 'game_id', 'player_id'],
  entityId: 'player_id',
};

type Timings = { sql: number; calls: number };

/** Writes `bodies` in turn through a fresh table, and times the SQL after each shred: the batches and the read-back. */
async function write(kind: 'shared' | 'plain', bodies: readonly string[]): Promise<Timings[]> {
  const conn = createSqlJsConnection({ capabilities: 'full' });
  const table =
    kind === 'shared'
      ? createStoreTable({ table: 'stats_shared', columns: columnDefs, uniqueBy: ['week', 'game_id', 'player_id'], entityId: 'player_id', newerBy: 'updated_at' }, conn, { all: sharedSpec })
      : createSqliteRowTable(plainSchema, conn, { specs: { all: plainSpec }, variant: () => 'all', binds: () => ['w4'] });
  table.init();
  const batch = conn.executeBatchAsync!.bind(conn);
  const execute = conn.execute.bind(conn);
  let current: Timings = { sql: 0, calls: 0 };
  conn.executeBatchAsync = async (commands) => {
    const started = performance.now();
    await batch(commands);
    current.sql += performance.now() - started;
    current.calls += 1;
  };
  conn.execute = (sql, params) => {
    const started = performance.now();
    const result = execute(sql, params);
    if (/RETURNING/.test(sql)) current.sql += performance.now() - started;
    return result;
  };
  const out: Timings[] = [];
  for (const raw of bodies) {
    current = { sql: 0, calls: 0 };
    // eslint-disable-next-line no-await-in-loop -- one write at a time, as the table's queue runs them
    await table.shred({ partition_key: 'w4' }, raw, () => [], { variant: 'all', binds: [] });
    out.push(current);
  }
  return out;
}

bench('write cost — shared rows vs the per-partition write', () => {
  beforeAll(async () => {
    await initSqlJs();
  });

  it('measures a first load and refetches of 0, 4 and every line changed', async () => {
    const bodies = [body(0), body(0), body(4), body(ROWS)];
    const labels = ['first load', 'refetch, 0 changed', 'refetch, 4 changed', 'refetch, all changed'];
    const runs = 3;
    const samples: Record<string, Array<{ shared: number; plain: number }>> = {};
    for (let run = 0; run < runs; run += 1) {
      // eslint-disable-next-line no-await-in-loop
      const [shared, plain] = [await write('shared', bodies), await write('plain', bodies)];
      labels.forEach((label, index) => (samples[label] ??= []).push({ shared: shared[index].sql, plain: plain[index].sql }));
    }
    const median = (values: number[]) => [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)];
    // eslint-disable-next-line no-console
    console.log(
      labels
        .map((label) => {
          const shared = median(samples[label].map((sample) => sample.shared));
          const plain = median(samples[label].map((sample) => sample.plain));
          return `${label.padEnd(22)} shared ${shared.toFixed(1).padStart(7)}ms   per-partition ${plain.toFixed(1).padStart(7)}ms   ×${(shared / plain).toFixed(2)}`;
        })
        .join('\n'),
    );
  }, 300000);
});
