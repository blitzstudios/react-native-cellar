import { createSqliteRowTable, RowTableSchema } from '../..';
import { pinnedReader, readRows, runBatch, runBatchAsync, SqliteConnection } from '../../table/connection';
import { createSqlJsConnection, initSqlJs, SqlJsConnection } from '../../testing/sqljs_connection';
import type { NativeShredSpec } from '../../write/shred_spec';

type Thing = {
  scope: string;
  id: string;
  name: string | null;
  n: number | null;
};

const schema: RowTableSchema<Thing> = {
  table: 'things',
  columns: { scope: { type: 'TEXT' }, id: { type: 'TEXT' }, name: { type: 'TEXT' }, n: { type: 'INTEGER' } },
  primaryKey: ['scope', 'id'],
  entityId: 'id',
};

const nativeShredSpec: NativeShredSpec = {
  specs: {
    all: {
      version: 1,
      table: 'things',
      insertVerb: 'INSERT OR REPLACE',
      columns: ['scope', 'id', 'name', 'n'],
      ops: [
        { op: 'bind', index: 0 },
        { op: 'text', path: 'id' },
        { op: 'text', path: 'name' },
        { op: 'int', path: 'n' },
      ],
      deleteWhere: [{ column: 'scope', bindIndex: 0 }],
    },
  },
  variant: () => 'all',
  binds: (scope) => [String(scope.scope)],
};

const rows = (count: number): Thing[] => Array.from({ length: count }, (_, index) => ({ scope: 's', id: `p${index}`, name: `n${index}`, n: index }));

beforeAll(async () => {
  await initSqlJs();
});

function withThings(conn: SqliteConnection) {
  conn.execute('CREATE TABLE things (scope TEXT, id TEXT, name TEXT, n INTEGER, PRIMARY KEY (scope, id));');
}

describe('runBatch — uses the driver transaction when there is one', () => {
  it('routes through executeBatch on a full connection, and through BEGIN/COMMIT without one', () => {
    const full = createSqlJsConnection({ capabilities: 'full' });
    const lean = createSqlJsConnection({ capabilities: 'minimal' });
    [full, lean].forEach(withThings);

    const cmds = rows(3).map(
      (row) => ['INSERT INTO things (scope, id, name, n) VALUES (?, ?, ?, ?);', [row.scope, row.id, row.name, row.n]] as [string, (string | number | null)[]],
    );
    runBatch(full, cmds);
    runBatch(lean, cmds);

    expect(full.calls.executeBatch).toBe(1);
    expect(lean.calls.executeBatch).toBe(0);
    const read = (conn: SqlJsConnection) => readRows<Thing>(conn, 'SELECT id FROM things ORDER BY id;').map((row) => row.id);
    expect(read(full)).toEqual(['p0', 'p1', 'p2']);
    expect(read(lean)).toEqual(read(full));

    full.close();
    lean.close();
  });

  it('rolls back a failed batch on both paths, so a bad row does not leave half of one behind', () => {
    for (const capabilities of ['minimal', 'full'] as const) {
      const conn = createSqlJsConnection({ capabilities });
      withThings(conn);
      const bad: [string, (string | number | null)[]][] = [
        ['INSERT INTO things (scope, id, name, n) VALUES (?, ?, ?, ?);', ['s', 'ok', 'a', 1]],
        ['INSERT INTO nonexistent_table (x) VALUES (?);', [1]],
      ];

      expect(() => runBatch(conn, bad)).toThrow();
      expect(readRows<Thing>(conn, 'SELECT id FROM things;')).toEqual([]);

      conn.close();
    }
  });
});

describe('runBatchAsync', () => {
  it('prefers executeBatchAsync, and falls all the way back to the sync path when neither async nor batch exists', async () => {
    const full = createSqlJsConnection({ capabilities: 'full' });
    const lean = createSqlJsConnection({ capabilities: 'minimal' });
    [full, lean].forEach(withThings);
    const cmds: [string, (string | number | null)[]][] = [['INSERT INTO things (scope, id, name, n) VALUES (?, ?, ?, ?);', ['s', 'a', 'x', 1]]];

    await runBatchAsync(full, cmds);
    await runBatchAsync(lean, cmds);

    expect(full.calls.executeBatchAsync).toBe(1);
    expect(full.calls.executeBatch).toBe(0);
    expect(lean.calls.executeBatchAsync).toBe(0);
    expect(readRows<Thing>(lean, 'SELECT id FROM things;')).toEqual([{ id: 'a' }]);

    full.close();
    lean.close();
  });
});

describe('readRows — the dedicated read handle', () => {
  it('sends the statement to the reader when the driver has one, and to the writer when it does not', () => {
    const full = createSqlJsConnection({ capabilities: 'full' });
    withThings(full);
    const writerStatements = full.calls.execute;

    readRows<Thing>(full, 'SELECT * FROM things;');

    expect(full.calls.readerExecute).toBe(1);
    expect(full.calls.execute).toBe(writerStatements);

    const lean = createSqlJsConnection({ capabilities: 'minimal' });
    withThings(lean);
    const before = lean.calls.execute;
    readRows<Thing>(lean, 'SELECT * FROM things;');
    expect(lean.calls.execute).toBe(before + 1);

    full.close();
    lean.close();
  });

  it('disposes every result it takes rows off', () => {
    const conn = createSqlJsConnection({ capabilities: 'full' });
    withThings(conn);
    runBatch(conn, [['INSERT INTO things (scope, id, name, n) VALUES (?, ?, ?, ?);', ['s', 'a', 'x', 1]]]);
    const before = conn.calls.dispose;

    readRows<Thing>(conn, 'SELECT * FROM things;');

    expect(conn.calls.dispose).toBe(before + 1);
    conn.close();
  });

  it('reads the rows before disposing, so a driver that frees its backing still returns them', () => {
    const conn = createSqlJsConnection({ capabilities: 'full', poisonOnDispose: true });
    withThings(conn);
    runBatch(conn, [['INSERT INTO things (scope, id, name, n) VALUES (?, ?, ?, ?);', ['s', 'a', 'x', 1]]]);

    expect(readRows<Thing>(conn, 'SELECT id FROM things;')).toEqual([{ id: 'a' }]);
    conn.close();
  });
});

describe('pinnedReader', () => {
  it('hands back a handle with no reader of its own, so a TEMP table and its SELECT stay together', () => {
    const conn = createSqlJsConnection({ capabilities: 'full' });
    const pinned = pinnedReader(conn);

    expect(pinned.reader).toBeUndefined();
    pinned.execute('CREATE TEMP TABLE t AS SELECT 1 AS x;');
    expect(readRows<{ x: number }>(pinned, 'SELECT x FROM t;')).toEqual([{ x: 1 }]);

    conn.close();
  });

  it('returns the driver reader when there is one, rather than a copy of the writer', () => {
    const full = createSqlJsConnection({ capabilities: 'full' });
    expect(pinnedReader(full)).toBe(full.reader);

    const lean = createSqlJsConnection({ capabilities: 'minimal' });
    expect(pinnedReader(lean)).not.toBe(lean);
    expect(pinnedReader(lean).reader).toBeUndefined();

    full.close();
    lean.close();
  });
});

describe('shred — the native shred branch', () => {
  const raw = JSON.stringify([
    { id: 'a', name: 'A', n: 1 },
    { id: 'b', name: 'B', n: 2 },
  ]);
  const parseRows = (): Thing[] => [
    { scope: 's', id: 'a', name: 'A', n: 1 },
    { scope: 's', id: 'b', name: 'B', n: 2 },
  ];

  it('shreds through the driver when it can, and parses in JS when it cannot — same rows either way', async () => {
    const results: Array<{ capabilities: string; shredCalls: number; rows: Thing[]; count: number }> = [];
    for (const capabilities of ['minimal', 'full'] as const) {
      const conn = createSqlJsConnection({ capabilities });
      const table = createSqliteRowTable(schema, conn, nativeShredSpec);
      table.init();

      // eslint-disable-next-line no-await-in-loop -- two shapes, sequentially, for the comparison below
      const { rows: count } = await table.shred({ scope: 's' }, raw, parseRows);
      results.push({ capabilities, shredCalls: conn.calls.shredJsonArrayAsync, rows: table.find({ scope: 's' }), count });
      conn.close();
    }

    const [lean, full] = results;
    expect(lean.shredCalls).toBe(0);
    expect(full.shredCalls).toBe(1);
    expect(full.count).toBe(lean.count);
    expect(full.rows).toEqual(lean.rows);
    expect(full.rows.map((row) => row.id)).toEqual(['a', 'b']);
  });

  it('replaces the scope rather than appending to it, which is what the spec deleteWhere is for', async () => {
    const conn = createSqlJsConnection({ capabilities: 'full' });
    const table = createSqliteRowTable(schema, conn, nativeShredSpec);
    table.init();

    await table.shred({ scope: 's' }, raw, parseRows);
    await table.shred({ scope: 's' }, JSON.stringify([{ id: 'c', name: 'C', n: 3 }]), () => [{ scope: 's', id: 'c', name: 'C', n: 3 }]);

    expect(table.find({ scope: 's' }).map((row) => row.id)).toEqual(['c']);
    conn.close();
  });

  it('falls back to the JS parse when the driver shred throws, rather than losing the ingest', async () => {
    const conn = createSqlJsConnection({ capabilities: 'full' });
    conn.shredJsonArrayAsync = () => Promise.reject(new Error('unknown op'));
    const table = createSqliteRowTable(schema, conn, nativeShredSpec);
    table.init();

    const { rows: count } = await table.shred({ scope: 's' }, raw, parseRows);

    expect(count).toBe(2);
    expect(table.find({ scope: 's' }).map((row) => row.id)).toEqual(['a', 'b']);
    conn.close();
  });
});
