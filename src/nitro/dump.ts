/**
 * A copy of every store's database in one SQLite file, for a developer to open in a desktop SQLite browser. It needs
 * no file system library: nitro opens, attaches and deletes databases by name in its own directory, and SQLite says
 * where that is.
 */

import { NitroSQLite, open } from 'react-native-nitro-sqlite';
import { getOpenSqliteConnections } from './nitro_connection';

/** A dump of the stores' databases. */
export interface SqliteDump {
  /** The dump's database name, in nitro's directory. */
  name: string;
  /** Its absolute path on the device; on a simulator, a path on the Mac running it. */
  path: string;
  /** Its size in bytes. */
  bytes: number;
  /** Each table copied, with the database it came from, and its row count. */
  tables: Array<{ database: string; table: string; rows: number }>;
}

const quote = (name: string): string => `"${name.replace(/"/g, '""')}"`;
const baseName = (database: string): string => database.replace(/\.db$/i, '').replace(/[^a-z0-9_]/gi, '_');

type Session = ReturnType<typeof open>;
const rowsOf = async <T>(session: Session, sql: string): Promise<T[]> => ((await session.executeAsync(sql)).rows?._array ?? []) as T[];

/**
 * Copies the tables of every database a store runs on into one new database, `name` in nitro's directory (replacing
 * a dump already there under that name), and resolves with where it is and what it holds. A table keeps its name
 * unless an earlier database had one of the same name, when it takes its database's name as a prefix. Only the rows
 * are copied, not indexes or keys. Stores on the in-memory fallback aren't included: their rows are visible only to
 * their own connection.
 *
 * Each database is attached to the dump's own connection, so the copy reads a committed snapshot alongside the
 * store's writes rather than through the store's connection.
 */
export async function dumpSqliteStores(options: { name?: string } = {}): Promise<SqliteDump> {
  const name = options.name ?? 'cellar-dump.db';
  const databases = getOpenSqliteConnections()
    .map((connection) => connection.name)
    .filter((database) => !database.startsWith(':memory:') && database !== name);
  if (!databases.length) throw new Error('No store is on a database file to dump.');

  try {
    NitroSQLite.native.close(name);
  } catch {
    /* not open */
  }
  try {
    NitroSQLite.native.drop(name);
  } catch {
    /* not there */
  }

  const session = open({ name });
  try {
    const used = new Set<string>();
    const tables: SqliteDump['tables'] = [];
    for (const database of databases) {
      session.attach(database, 'src');
      try {
        // eslint-disable-next-line no-await-in-loop
        const names = await rowsOf<{ name: string }>(session, "SELECT name FROM src.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
        for (const { name: table } of names) {
          const as = used.has(table) ? `${baseName(database)}_${table}` : table;
          used.add(as);
          // eslint-disable-next-line no-await-in-loop
          await session.executeAsync(`CREATE TABLE main.${quote(as)} AS SELECT * FROM src.${quote(table)}`);
          // eslint-disable-next-line no-await-in-loop
          const [count] = await rowsOf<{ rows: number }>(session, `SELECT COUNT(*) AS rows FROM main.${quote(as)}`);
          tables.push({ database, table: as, rows: Number(count?.rows ?? 0) });
        }
      } finally {
        session.detach('src');
      }
    }
    const [main] = (await rowsOf<{ name: string; file: string }>(session, 'PRAGMA database_list')).filter((entry) => entry.name === 'main');
    const [pages] = await rowsOf<{ page_count: number }>(session, 'PRAGMA page_count');
    const [size] = await rowsOf<{ page_size: number }>(session, 'PRAGMA page_size');
    return { name, path: main?.file ?? name, bytes: Number(pages?.page_count ?? 0) * Number(size?.page_size ?? 0), tables };
  } finally {
    session.close();
  }
}
