import path from 'path';

import { configureCellar } from '../index';
import { defineSqliteStore } from '../define_sqlite_store';
import { RowTableSchema } from '../table/types';
import { createSqliteRowTable } from '../table/sqlite';
import { PartitionKeyColumn, partitionedSchema } from '../table/partitioned';
import { bindSqlJsStore, openSqlJsConnection, SqlJsModule } from './sqljs_connection';

type Item = { id: string; group_id: string; score: number | null };

const schema: RowTableSchema<Item> = {
  table: 'items',
  columns: { id: { type: 'TEXT', notNull: true }, group_id: { type: 'TEXT', notNull: true }, score: { type: 'REAL' } },
  primaryKey: ['group_id', 'id'],
  entityId: 'id',
  indexes: [{ name: 'idx_items_group', columns: ['group_id'] }],
};

let SQL: SqlJsModule;

beforeAll(async () => {
  // eslint-disable-next-line global-require
  const factory = require('sql.js') as (config: { locateFile: (file: string) => string }) => Promise<SqlJsModule>;
  const dist = path.dirname(require.resolve('sql.js'));
  SQL = await factory({ locateFile: (file) => path.join(dist, file) });
});

function itemStore() {
  return defineSqliteStore({
    name: 'items_store',
    schema,
    partition: { fields: ['group_id'] },
    build: (cellar) => ({ reads: { group: (groupId: string) => cellar.rows(groupId, undefined, { orderBy: 'score' }).rows } }),
  });
}

describe('sql.js on the web', () => {
  it('runs a store over the same SQL a device runs, on a database no other store shares', () => {
    const store = itemStore();
    const other = itemStore();
    const conn = openSqlJsConnection(SQL);
    store.bindSqlite(conn);
    bindSqlJsStore('items_other', SQL, other);

    createSqliteRowTable<Item & PartitionKeyColumn>(partitionedSchema(schema), conn).overwrite({ partition_key: 'g' }, [
      { partition_key: 'g', id: 'a', group_id: 'g', score: 2 },
      { partition_key: 'g', id: 'b', group_id: 'g', score: 1 },
    ]);

    expect(store.reads.group('g').map((item) => item.id)).toEqual(['b', 'a']);
    expect(other.reads.group('g')).toEqual([]);
  });

  it('creates a temporary side table with its record column', () => {
    const conn = openSqlJsConnection(SQL);
    const withMeta = { ...schema, meta: { table: 'items_meta', keyColumns: ['group_id' as const], column: 'etag', recordColumn: 'partition' } };
    const table = () => createSqliteRowTable(withMeta, conn, undefined, { temporary: true });
    const first = table();
    first.init();
    first.setMeta({ group_id: 'g' }, 'etag-1', '{"group_id":"g"}');

    const second = table();
    second.init();
    expect(second.getMetaRecord({ group_id: 'g' })).toBe('{"group_id":"g"}');
  });

  it('commits a batch whole, or rolls it back whole', () => {
    const conn = openSqlJsConnection(SQL);
    conn.execute('CREATE TABLE t (x INTEGER PRIMARY KEY);');

    expect(() => conn.executeBatch!([['INSERT INTO t VALUES (1);', []], ['INSERT INTO t VALUES (1);', []]])).toThrow();
    expect(conn.execute('SELECT count(*) AS n FROM t;').rows?._array).toEqual([{ n: 0 }]);
    conn.executeBatch!([['INSERT INTO t VALUES (?);', [1]], ['INSERT INTO t VALUES (?);', [2]]]);
    expect(conn.execute('SELECT count(*) AS n FROM t;').rows?._array).toEqual([{ n: 2 }]);
  });

  it('reports a bind that fails and leaves the store reading empty, rather than taking the page down', () => {
    const captureException = jest.fn();
    configureCellar({ errors: { captureException, captureMessage: jest.fn() } });
    const broken = { Database: jest.fn(() => { throw new Error('wasm failed to instantiate'); }) } as unknown as SqlJsModule;
    const store = itemStore();

    expect(() => bindSqlJsStore('items', broken, store)).not.toThrow();
    expect(store.reads.group('g')).toEqual([]);
    expect(captureException.mock.calls[0][1].tags).toEqual({ cellar_degradation: 'sqljs.bind.items' });
  });
});
