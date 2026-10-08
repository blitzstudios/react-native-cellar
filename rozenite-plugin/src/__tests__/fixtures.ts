import { createRequire } from 'node:module';
import path from 'node:path';
import { byPartition, defineSqliteStore } from '@sleeperhq/react-native-cellar';
import type { Loose, StoreTableSchema } from '@sleeperhq/react-native-cellar';
import { bindSqlJsStore } from '@sleeperhq/react-native-cellar/sqljs';
import type { SqlJsModule } from '@sleeperhq/react-native-cellar/sqljs';
import initSqlJs from 'sql.js';

export type Game = { team: string; sport: string; score: number | null };
export type Season = { sport: string; season: string };

const SCHEMA: StoreTableSchema<Game> = {
  table: 'games',
  columns: { team: { type: 'TEXT', notNull: true }, sport: { type: 'TEXT', notNull: true }, score: { type: 'INTEGER' } },
  uniqueBy: ['sport', 'team'],
  entityId: 'team',
};

let SQL: SqlJsModule | undefined;

export async function loadSqlJs(): Promise<SqlJsModule> {
  if (SQL) return SQL;
  const dist = path.dirname(createRequire(import.meta.url).resolve('sql.js'));
  SQL = (await initSqlJs({ locateFile: (file: string) => path.join(dist, file) })) as unknown as SqlJsModule;
  return SQL;
}

/** A store of games by season, bound to its own sql.js database, with a `put` that writes a season's games. */
export async function gamesStore(name: string) {
  const store = defineSqliteStore({
    name,
    schema: SCHEMA,
    partition: (args: Loose<Season>) => (args.sport && args.season ? { sport: args.sport, season: args.season } : null),
    build: (cellar) => ({
      reads: {
        teams: cellar.defineRead<Season, string[]>({ empty: [], select: (_args, key) => cellar.rows(key).map((row) => row.team, []) }),
      },
      lifecycle: {
        put: (season: Season, games: Game[]) => {
          const key = cellar.keyOf(season);
          const result = cellar.table.overwrite(cellar.where(key), games.map((game) => ({ ...game, partition_key: key })));
          return cellar.bump(key, result.changes);
        },
        setEtag: (season: Season, etag: string) => cellar.table.setMeta(cellar.where(cellar.keyOf(season)), etag),
      },
    }),
  });
  bindSqlJsStore(name, await loadSqlJs(), store);
  return store;
}

export const NFL: Season = { sport: 'nfl', season: '2026' };
export const NBA: Season = { sport: 'nba', season: '2026' };

export const NFL_GAMES: Game[] = [
  { team: 'KC', sport: 'nfl', score: 27 },
  { team: 'BUF', sport: 'nfl', score: 24 },
  { team: 'MIA', sport: 'nfl', score: null },
];

/** A store with one `byPartition` cache of each season's teams, filled by `teamsOf`. */
export async function cachedStore(name: string) {
  const store = defineSqliteStore({
    name,
    schema: SCHEMA,
    partition: (args: Loose<Season>) => (args.sport && args.season ? { sport: args.sport, season: args.season } : null),
    build: (cellar) => {
      const { teams } = cellar.defineCaches({ teams: byPartition<string[]>({ max: 8 }) });
      return {
        reads: {},
        lifecycle: {
          teamsOf: (season: Season, names: string[]) => teams.for(cellar.keyOf(season)).read(() => names),
        },
      };
    },
  });
  bindSqlJsStore(name, await loadSqlJs(), store);
  return store;
}
