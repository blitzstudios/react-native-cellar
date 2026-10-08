/** Type-level tests, run by `tsc`: each `@ts-expect-error` fails typecheck if its guarantee stops holding. */

import { defineSqliteStore } from '../define_sqlite_store';
import type { StoreTableSchema } from '../table/partitioned';

type Game = { team: string; sport: string };
type Season = { sport: string; season: number };

const seasonOf = ({ sport, season }: { sport?: string | null; season?: number | null }): Season | null => (sport && season ? { sport, season } : null);

const schema: StoreTableSchema<Game> = {
  table: 'games',
  columns: { team: { type: 'TEXT', notNull: true }, sport: { type: 'TEXT' } },
  uniqueBy: ['team'],
  entityId: 'team',
};

const pushed = defineSqliteStore({
  name: 'pushed',
  schema,
  partition: seasonOf,
  push: {
    idOf: (game: Game) => game.team,
    partitionsOf: (game: Game): Season[] => [{ sport: game.sport, season: 2025 }],
    toRows: (key, games) => games.map((game) => ({ ...game, partition_key: key })),
  },
  build: () => ({ reads: {} }),
});

const fetched = defineSqliteStore({
  name: 'fetched',
  schema,
  partition: seasonOf,
  build: () => ({ reads: {} }),
});

/** A store that declares `push` takes its items, and nothing else. */
export const ingestsItsItems = () => {
  pushed.push.ingest([{ team: 'a', sport: 'nfl' }]);
  pushed.push.ingest(null);
  // @ts-expect-error a push takes the items its spec's `idOf` does
  pushed.push.ingest([{ id: 'a' }]);
};

/** A store that declares no `push` has none to call. */
export const noPushWithoutASpec = () => {
  const none: undefined = fetched.push;
  return none;
};

/** Pushes are declared beside `fetch`, not built. */
export const pushIsNotBuilt = () =>
  defineSqliteStore({
    name: 'built_push',
    schema,
    partition: seasonOf,
    // @ts-expect-error `build` returns no `push`
    build: () => ({ reads: {}, push: { ingest: () => {} } }),
  });
