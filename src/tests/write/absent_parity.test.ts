/**
 * A native shred stores NULL for a field its element leaves out, and Cellar reads the absence back out of the
 * element's JSON in SQL. These hold that SQL to `evalShredOp`, which is how the JS path decides, for every op.
 */

import { installTestRuntime } from '../../testing/runtime';
import { createSqlJsConnection } from '../../testing/sqljs_connection';
import { defineSqliteStore } from '../../define_sqlite_store';
import { readRows } from '../../table/connection';
import { SqlValue } from '../../table/types';
import { evalShredElement, evalShredOp, ShredOp, ShredSpec } from '../../write/shred_spec';

jest.mock('../../diagnostics/telemetry', () => ({ reportStoreDegradation: jest.fn() }));

installTestRuntime();

const OPS: Record<string, ShredOp> = {
  text_a: { op: 'text', path: 'a' },
  text_ab: { op: 'text', path: 'a.b' },
  int_ab: { op: 'int', path: 'a.b' },
  real_ab: { op: 'real', path: 'a.b' },
  bool_ab: { op: 'boolInt', path: 'a.b' },
  meta_ab: { op: 'metaText', path: 'a.b' },
  json_ab: { op: 'rawJsonField', path: 'a.b' },
  real0_ab: { op: 'real0', path: 'a.b' },
  text_complete: { op: 'text', path: 'a.b', complete: 'a' },
  real_complete: { op: 'real', path: 'a.b', complete: 'a' },
  real0_complete: { op: 'real0', path: 'a.b', complete: 'a' },
  coalesce: { op: 'coalesceText', paths: ['a', 'a.b'] },
  coalesce_empty: { op: 'coalesceText', paths: ['a.b'], emptyDefault: true },
  coalesce_bind: { op: 'coalesceText', paths: ['a.b'], fallbackBindIndex: 1 },
  joined: { op: 'concat', sep: '_', parts: [{ paths: ['a'] }, { paths: ['a.b'] }] },
  bound: { op: 'bind', index: 1 },
};

const ELEMENTS: unknown[] = [
  {},
  { a: null },
  { a: 'x' },
  { a: 5 },
  { a: true },
  { a: [1] },
  { a: {} },
  { a: { b: null } },
  { a: { b: 'x' } },
  { a: { b: 7 } },
  { a: { b: '7' } },
  { a: { b: false } },
  { a: { b: ['x'] } },
];

const NAMES = Object.keys(OPS);
const SPEC: ShredSpec = { version: 1, table: 'parity', insertVerb: 'INSERT OR REPLACE', columns: ['id', ...NAMES], ops: [{ op: 'text', path: 'id' }, ...Object.values(OPS)] };
const SEED = 'seeded';
const BINDS: SqlValue[] = ['test', 'bound'];
const BODY = ELEMENTS.map((element, index) => ({ id: `e${index}`, ...(element as object) }));

/** The stored rows after writing `BODY` over seeded copies of the same rows, through the JS or the native path. */
async function written(inJs: boolean) {
  const store = defineSqliteStore({
    name: inJs ? 'parity_js' : 'parity_native',
    schema: {
      table: 'parity',
      columns: Object.fromEntries(['id', ...NAMES].map((name) => [name, { type: 'TEXT' as const }])) as Record<string, { type: 'TEXT' }>,
      uniqueBy: ['id'],
      entityId: 'id',
    },
    partition: ({ group }: { group?: string }) => (group ? { group } : null),
    nativeShredSpecs: { all: SPEC },
    build: () => ({ reads: {} }),
  });
  const conn = createSqlJsConnection({ capabilities: 'full' });
  const { table } = store.testing.over(conn);
  table.overwrite({ partition_key: 'seed' }, BODY.map(({ id }) => ({ id, ...Object.fromEntries(NAMES.map((name) => [name, SEED])) })));
  const parse = (raw: string) => (JSON.parse(raw) as unknown[]).map((element) => evalShredElement(SPEC, element, BINDS)!) as never[];
  await table.shred({ partition_key: 'test' }, JSON.stringify(BODY), parse, { variant: 'all', binds: [BINDS[1]] }, inJs);
  return { rows: readRows<Record<string, SqlValue>>(conn, `SELECT id, ${NAMES.join(', ')} FROM parity__rows ORDER BY id;`), shreds: conn.calls.shredJsonArrayAsync };
}

describe('absent columns — the native shred against the JS path', () => {
  it('stores the same rows from either path, for every op and every shape of missing', async () => {
    const js = await written(true);
    const native = await written(false);

    expect(js.shreds).toBe(0);
    expect(native.shreds).toBe(1);
    expect(native.rows).toEqual(js.rows);
  });

  it('keeps the stored value exactly where the op says the element leaves the column absent', async () => {
    const { rows } = await written(false);
    const byId = new Map(rows.map((row) => [row.id, row]));

    for (const element of BODY) {
      for (const name of NAMES) {
        const absent = evalShredOp(OPS[name], element, BINDS) === undefined;
        expect([name, element, byId.get(element.id)?.[name] === SEED]).toEqual([name, element, absent]);
      }
    }
  });
});
