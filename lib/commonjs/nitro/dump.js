"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.dumpSqliteStores = dumpSqliteStores;
var _reactNativeNitroSqlite = require("react-native-nitro-sqlite");
var _nitro_connection = require("./nitro_connection.js");
/**
 * A copy of every store's database in one SQLite file, for a developer to open in a desktop SQLite browser. It needs
 * no file system library: nitro opens, attaches and deletes databases by name in its own directory, and SQLite says
 * where that is.
 */

/** A dump of the stores' databases. */

const quote = name => `"${name.replace(/"/g, '""')}"`;
const baseName = database => database.replace(/\.db$/i, '').replace(/[^a-z0-9_]/gi, '_');
const rowsOf = async (session, sql) => (await session.executeAsync(sql)).rows?._array ?? [];

/**
 * Copies the tables of every database a store runs on into one new database, `name` in nitro's directory (replacing
 * a dump already there under that name), and resolves with where it is and what it holds. A table keeps its name
 * unless an earlier database had one of the same name, when it takes its database's name as a prefix. Only the rows
 * are copied, not indexes or keys, and a store's table is copied as it reads, one row per partition holding it, with
 * `partition_key` first. Stores on the in-memory fallback aren't included: their rows are visible only to their own
 * connection.
 *
 * Each database is attached to the dump's own connection, so the copy reads a committed snapshot alongside the
 * store's writes rather than through the store's connection.
 */
async function dumpSqliteStores(options = {}) {
  const name = options.name ?? 'cellar-dump.db';
  const databases = (0, _nitro_connection.getOpenSqliteConnections)().map(connection => connection.name).filter(database => !database.startsWith(':memory:') && database !== name);
  if (!databases.length) throw new Error('No store is on a database file to dump.');
  try {
    _reactNativeNitroSqlite.NitroSQLite.native.close(name);
  } catch {
    /* not open */
  }
  try {
    _reactNativeNitroSqlite.NitroSQLite.native.drop(name);
  } catch {
    /* not there */
  }
  const session = (0, _reactNativeNitroSqlite.open)({
    name
  });
  try {
    const used = new Set();
    const tables = [];
    for (const database of databases) {
      session.attach(database, 'src');
      try {
        // eslint-disable-next-line no-await-in-loop
        const objects = await rowsOf(session, "SELECT name, type FROM src.sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name");
        // A store's rows are read through its view, which the dump keeps as one flat table under the store's name, in
        // place of the rows and membership tables beneath it.
        const views = new Set(objects.filter(object => object.type === 'view').map(object => object.name));
        const names = objects.filter(object => {
          const beneath = /^(.+)__(rows|members)$/.exec(object.name);
          return !(object.type === 'table' && beneath && views.has(beneath[1]));
        });
        for (const {
          name: table
        } of names) {
          const as = used.has(table) ? `${baseName(database)}_${table}` : table;
          used.add(as);
          // eslint-disable-next-line no-await-in-loop
          await session.executeAsync(`CREATE TABLE main.${quote(as)} AS SELECT * FROM src.${quote(table)}`);
          // eslint-disable-next-line no-await-in-loop
          const [count] = await rowsOf(session, `SELECT COUNT(*) AS rows FROM main.${quote(as)}`);
          tables.push({
            database,
            table: as,
            rows: Number(count?.rows ?? 0)
          });
        }
      } finally {
        session.detach('src');
      }
    }
    const [main] = (await rowsOf(session, 'PRAGMA database_list')).filter(entry => entry.name === 'main');
    const [pages] = await rowsOf(session, 'PRAGMA page_count');
    const [size] = await rowsOf(session, 'PRAGMA page_size');
    return {
      name,
      path: main?.file ?? name,
      bytes: Number(pages?.page_count ?? 0) * Number(size?.page_size ?? 0),
      tables
    };
  } finally {
    session.close();
  }
}
//# sourceMappingURL=dump.js.map