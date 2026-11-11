import path from 'path';

import { configureCellar } from '../index';
import { defineSqliteStore } from '../define_sqlite_store';
import { RowTableSchema } from '../table/types';
import type { StoreTableSchema } from '../table/partitioned';
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

const storeSchema: StoreTableSchema<Item> = {
  table: 'items',
  columns: schema.columns,
  uniqueBy: ['group_id', 'id'],
  entityId: 'id',
  indexes: schema.indexes,
};

let SQL: SqlJsModule;

beforeAll(async () => {
  // eslint-disable-next-line global-require
  const factory = require('sql.js') as (config: { locateFile: (file: string) => string }) => Promise<SqlJsModule>;
  const dist = path.dirname(require.resolve('sql.js'));
  SQL = await factory({ locateFile: (file) => path.join(dist, file) });
});

/** sql.js, counting how often each statement is prepared and how many statements are freed. */
function countingModule() {
  const prepares = new Map<string, number>();
  let frees = 0;
  const module = {
    Database: class {
      private readonly db = new SQL.Database();

      prepare(sql: string) {
        prepares.set(sql, (prepares.get(sql) ?? 0) + 1);
        const statement = this.db.prepare(sql);
        const free = statement.free.bind(statement);
        statement.free = () => {
          frees += 1;
          free();
        };
        return statement;
      }
    },
  } as unknown as SqlJsModule;
  return { module, prepared: (sql: string) => prepares.get(sql) ?? 0, freed: () => frees };
}

function itemStore() {
  return defineSqliteStore({
    name: 'items_store',
    schema: storeSchema,
    partition: ({ group_id }: { group_id?: string }) => (group_id ? { group_id } : null),
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

    createSqliteRowTable<Item & PartitionKeyColumn>(partitionedSchema(storeSchema), conn).overwrite({ partition_key: 'g' }, [
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

  it('prepares a statement once, however many times it runs', () => {
    const counted = countingModule();
    const conn = openSqlJsConnection(counted.module);
    conn.execute('CREATE TABLE t (x INTEGER);');

    for (let x = 0; x < 50; x++) conn.execute('INSERT INTO t VALUES (?);', [x]);

    expect(counted.prepared('INSERT INTO t VALUES (?);')).toBe(1);
    expect(conn.execute('SELECT count(*) AS n FROM t;').rows?._array).toEqual([{ n: 50 }]);
  });

  it('runs a statement again after it failed partway', () => {
    const conn = openSqlJsConnection(SQL);
    conn.execute('CREATE TABLE t (x INTEGER PRIMARY KEY);');
    conn.execute('INSERT INTO t VALUES (?);', [1]);

    expect(() => conn.execute('INSERT INTO t VALUES (?);', [1])).toThrow();
    conn.execute('INSERT INTO t VALUES (?);', [2]);
    expect(conn.execute('SELECT x FROM t ORDER BY x;').rows?._array).toEqual([{ x: 1 }, { x: 2 }]);
  });

  it('leaves no statement holding a table, so the table can still be dropped and rebuilt', () => {
    const conn = openSqlJsConnection(SQL);
    conn.execute('CREATE TABLE t (x INTEGER);');
    conn.execute('INSERT INTO t VALUES (?);', [1]);
    conn.execute('SELECT x FROM t;');

    conn.execute('DROP TABLE t;');
    conn.execute('CREATE TABLE t (x INTEGER, y TEXT);');
    conn.execute('INSERT INTO t VALUES (?, ?);', [2, 'two']);

    expect(conn.execute('SELECT x, y FROM t;').rows?._array).toEqual([{ x: 2, y: 'two' }]);
  });

  it('keeps a bounded number of statements, freeing the least recently used', () => {
    const counted = countingModule();
    const conn = openSqlJsConnection(counted.module);
    conn.execute('CREATE TABLE t (x INTEGER);');

    for (let x = 0; x < 300; x++) conn.execute(`SELECT ${x} AS n FROM t;`);

    expect(counted.freed()).toBe(300 + 1 - 256);
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
