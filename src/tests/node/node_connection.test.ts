import fs from 'fs';
import os from 'os';
import path from 'path';
import ts from 'typescript';

import { defineSqliteStore } from '../../define_sqlite_store';
import { byEntity } from '../../read/derived_values';
import { pairRead } from '../../read/facade';
import { dehydrateReads, readCall } from '../../read/hydration';
import { openNodeConnection, type NodeConnection } from '../../node/node_connection';
import { readRows } from '../../table/connection';
import type { ShredCommand } from '../../table/connection';
import { StoreTableSchema } from '../../table/partitioned';
import { installTestRuntime } from '../../testing/runtime';
import { createSqlJsConnection } from '../../testing/sqljs_connection';
import type { ShredSpec } from '../../write/shred_spec';

jest.mock('../../diagnostics/telemetry', () => ({ reportStoreDegradation: jest.fn() }));

installTestRuntime();

const SRC = path.join(__dirname, '..', '..');

/** The writer and what it imports, compiled to CommonJS: a worker runs plain Node, which can't load this TypeScript. */
function buildWriter(): string {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'cellar-writer-'));
  for (const file of ['node/writer.ts', 'write/js_shred.ts', 'write/shred_spec.ts']) {
    const { outputText } = ts.transpileModule(fs.readFileSync(path.join(SRC, file), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    });
    const dest = path.join(out, file.replace(/\.ts$/, '.js'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, outputText);
  }
  return path.join(out, 'node', 'writer.js');
}

const writerFile = buildWriter();
const open: NodeConnection[] = [];
const connect = (): NodeConnection => {
  const conn = openNodeConnection({ writerFile });
  open.push(conn);
  return conn;
};

afterEach(async () => {
  await Promise.all(open.splice(0).map((conn) => conn.close()));
});

describe('openNodeConnection', () => {
  it('writes on the writer and reads what it committed on the main thread', async () => {
    const conn = connect();
    conn.execute('CREATE TABLE things (id TEXT PRIMARY KEY, n INTEGER);');
    await conn.executeBatchAsync?.([
      ['INSERT INTO things VALUES (?, ?);', ['a', 1]],
      ['INSERT INTO things VALUES (?, ?);', ['b', 2]],
    ]);

    expect(readRows(conn, 'SELECT id, n FROM things ORDER BY id;')).toEqual([
      { id: 'a', n: 1 },
      { id: 'b', n: 2 },
    ]);
  });

  it('keeps the writer’s temp tables across its calls, where a store stages a write', async () => {
    const conn = connect();
    conn.execute('CREATE TEMP TABLE stage (id TEXT);');
    await conn.executeAsync?.('INSERT INTO stage VALUES (?);', ['x']);

    expect(conn.execute('SELECT id FROM temp.stage;').rows?._array).toEqual([{ id: 'x' }]);
  });

  it('answers a call in the order it was made, behind the writes queued before it', async () => {
    const conn = connect();
    conn.execute('CREATE TABLE things (id TEXT);');
    const queued = conn.executeBatchAsync?.([['INSERT INTO things VALUES (?);', ['a']]]);

    expect(conn.execute('SELECT COUNT(*) AS n FROM things;').rows?._array).toEqual([{ n: 1 }]);
    await queued;
  });

  it('rolls a failed batch back whole, and rejects it', async () => {
    const conn = connect();
    conn.execute('CREATE TABLE things (id TEXT PRIMARY KEY);');

    await expect(
      conn.executeBatchAsync?.([
        ['INSERT INTO things VALUES (?);', ['a']],
        ['INSERT INTO things VALUES (?);', ['a']],
      ]),
    ).rejects.toThrow(/UNIQUE/);
    expect(readRows(conn, 'SELECT id FROM things;')).toEqual([]);
  });

  it('throws a failing statement on a blocking call', () => {
    const conn = connect();

    expect(() => conn.execute('SELECT * FROM nowhere;')).toThrow(/no such table/);
  });

  it('shreds a body into the rows the reference interpreter builds', async () => {
    const spec: ShredSpec = {
      version: 1,
      table: 'players',
      insertVerb: 'INSERT OR REPLACE',
      source: 'objectValues',
      deleteWhere: [{ column: 'sport', bindIndex: 0 }],
      columns: ['sport', 'player_id', 'team'],
      ops: [
        { op: 'bind', index: 0 },
        { op: 'text', path: 'player_id' },
        { op: 'text', path: 'team' },
      ],
    };
    const command: ShredCommand = { shred: spec, rawJson: JSON.stringify({ p1: { player_id: 'p1', team: 'SF' }, p2: { player_id: 'p2' } }), binds: ['nfl'] };
    const ddl = 'CREATE TABLE players (sport TEXT, player_id TEXT PRIMARY KEY, team TEXT);';
    const node = connect();
    const reference = createSqlJsConnection({ capabilities: 'full' });
    node.execute(ddl);
    reference.execute(ddl);

    await node.shredBatchAsync?.([command]);
    await reference.shredBatchAsync?.([command]);

    const select = 'SELECT sport, player_id, team FROM players ORDER BY player_id;';
    expect(readRows(node, select)).toEqual(readRows(reference, select));
    expect(readRows(node, select)).toHaveLength(2);
  });
});

type Player = { sport: string; player_id: string; team: string | null };

const PLAYERS: StoreTableSchema<Player> = {
  table: 'players',
  columns: { sport: { type: 'TEXT', notNull: true }, player_id: { type: 'TEXT', notNull: true }, team: { type: 'TEXT' } },
  uniqueBy: ['sport', 'player_id'],
  entityId: 'player_id',
};

const PLAYERS_NATIVE: Record<string, ShredSpec> = {
  all: {
    version: 1,
    table: 'players',
    insertVerb: 'INSERT OR REPLACE',
    source: 'objectValues',
    columns: ['sport', 'player_id', 'team'],
    ops: [
      { op: 'bind', index: 1 },
      { op: 'text', path: 'player_id' },
      { op: 'text', path: 'team' },
    ],
  },
};

function playerStore(body: () => string) {
  const store = defineSqliteStore({
    name: 'node_players',
    schema: PLAYERS,
    partition: ({ sport }: { sport?: string | null }) => (sport ? { sport } : null),
    fetch: ({ sport }: { sport: string }) => ({
      query: { queryFn: async () => ({ data: body() }) },
      toRows: (raw: string) => Object.values(JSON.parse(raw) as Record<string, { player_id: string; team: string }>).map((one) => ({ sport, ...one })),
      native: { variant: 'all', binds: [sport] },
    }),
    nativeShredSpecs: PLAYERS_NATIVE,
    build: (cellar) => {
      const { cards } = cellar.defineCaches({
        cards: byEntity({ max: 64, fromRows: ([row]) => (row ? { id: row.player_id, team: row.team } : undefined) }),
      });
      return {
        reads: {
          Card: cellar.defineRead<{ sport: string; playerId: string }, { id: string; team: string | null } | undefined>({
            select: (args, key) => cards.at(key, args.playerId),
            empty: undefined,
          }),
        },
      };
    },
  });
  return { store, Card: pairRead(() => store.reads.Card) };
}

/** The longest the event loop goes without a turn while `run` is in flight. */
async function longestBlock(run: () => Promise<unknown>): Promise<number> {
  let last = performance.now();
  let longest = 0;
  let running = true;
  const tick = () => {
    const now = performance.now();
    longest = Math.max(longest, now - last);
    last = now;
    if (running) setImmediate(tick);
  };
  setImmediate(tick);
  await run();
  running = false;
  return Math.max(longest, performance.now() - last);
}

describe('a store bound to node:sqlite', () => {
  it('fetches, writes through its writer, and reads on the main thread', async () => {
    let teams = { p1: { player_id: 'p1', team: 'SF' }, p2: { player_id: 'p2', team: 'KC' } } as Record<string, { player_id: string; team: string }>;
    const { store, Card } = playerStore(() => JSON.stringify(teams));
    store.bindSqlite(connect());

    await store.lifecycle.fetch({ sport: 'nfl' });
    expect(Card.getValue({ params: { sport: 'nfl', playerId: 'p1' } })).toEqual({ id: 'p1', team: 'SF' });

    teams = { p1: { player_id: 'p1', team: 'LV' } };
    await store.lifecycle.fetch({ sport: 'nfl' }, { staleTime: 0 });
    expect(Card.getValue({ params: { sport: 'nfl', playerId: 'p1' } })).toEqual({ id: 'p1', team: 'LV' });
    expect(Card.getValue({ params: { sport: 'nfl', playerId: 'p2' } })).toBeUndefined();
  });

  it('captures a read for a server render', async () => {
    const { store, Card } = playerStore(() => JSON.stringify({ p1: { player_id: 'p1', team: 'SF' } }));
    store.bindSqlite(connect());

    const snapshot = await dehydrateReads([readCall(Card.useValue, { sport: 'nfl', playerId: 'p1' })]);

    expect(Object.values(snapshot.reads)).toEqual([{ value: { id: 'p1', team: 'SF' } }]);
  });

  it('keeps the main thread free while a large body is parsed and written', async () => {
    const many = JSON.stringify(Object.fromEntries(Array.from({ length: 30_000 }, (_, i) => [`p${i}`, { player_id: `p${i}`, team: `T${i % 32}` }])));
    const onNode = playerStore(() => many);
    const onMainThread = playerStore(() => many);
    onNode.store.bindSqlite(connect());
    onMainThread.store.bindSqlite(createSqlJsConnection({ capabilities: 'full' }));

    const node = await longestBlock(() => onNode.store.lifecycle.fetch({ sport: 'nfl' }));
    const sqljs = await longestBlock(() => onMainThread.store.lifecycle.fetch({ sport: 'nfl' }));

    expect(onNode.Card.getValue({ params: { sport: 'nfl', playerId: 'p29999' } })).toEqual({ id: 'p29999', team: 'T15' });
    expect(node).toBeLessThan(sqljs / 4);
    fs.writeFileSync(path.join(os.tmpdir(), 'cellar-node-block.txt'), `node ${node.toFixed(1)}ms sqljs ${sqljs.toFixed(1)}ms\n`);
  });
});
