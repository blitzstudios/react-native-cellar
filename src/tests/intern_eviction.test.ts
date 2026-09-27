/**
 * The record⇄key table is bounded, and `describe` is the one place in Cellar where a bound could fail a
 * read outright rather than only slow it down. A store whose keys are parseable declares `key.from` and is
 * immune; a store whose keys are not gets a report saying so.
 */

import { createTestRowTable } from '../testing/row_table';
import { createVersionAtom } from '../reactivity/version_atom';
import { definePartitions } from '../define_partitions';
import { resetOnceGuards } from '../diagnostics/once_guard';
import { installTestRuntime } from '../testing/runtime';
import { RowTableSchema } from '../table/types';

type GameRow = { partition_key: string; game_id: string };

const SCHEMA: RowTableSchema<GameRow> = {
  table: 'games',
  columns: { partition_key: { type: 'TEXT' }, game_id: { type: 'TEXT' } },
  primaryKey: ['partition_key', 'game_id'],
  entityId: 'game_id',
  meta: { table: 'games_meta', keyColumns: ['partition_key'], column: 'etag' },
};

/** A parseable key: `sport:season`, which is what makes `from` possible. */
interface Game {
  sport: string;
  season: string;
}

function makeGames(over: { from?: boolean } = {}) {
  const table = createTestRowTable<GameRow>(SCHEMA);
  table.init();
  const query = jest.fn(() => ({ queryFn: async () => ({ data: '["g1"]', etag: undefined }) }));

  const games = definePartitions<GameRow, string, { game?: Game }, Game>({
    name: 'games',
    table,
    version: createVersionAtom('intern_eviction_test'),
    // One entry, so the next distinct partition evicts the previous one.
    internMax: 1,
    key: {
      of: (args) => args.game ?? null,
      id: ({ sport, season }) => `${sport}:${season}`,
      from: over.from
        ? (key) => {
            const [sport, season] = key.split(':');
            return sport && season ? { sport, season } : null;
          }
        : undefined,
      where: (key) => ({ partition_key: key }),
    },
    fetch: {
      query,
      parse: (partition, raw, key) => (JSON.parse(raw) as string[]).map((game_id) => ({ partition_key: key, game_id: `${partition.sport}-${game_id}` })),
    },
  });

  return { games, table, query };
}

const NFL: { game: Game } = { game: { sport: 'nfl', season: '2026' } };
const NBA: { game: Game } = { game: { sport: 'nba', season: '2026' } };

describe('a partition evicted from the key table', () => {
  const { captureException, fetchQuery } = installTestRuntime();
  let warn: jest.SpyInstance;
  let random: jest.SpyInstance;

  beforeEach(() => {
    resetOnceGuards();
    captureException.mockClear();
    // Cleared too: each case replays a closure by index, and a leftover call makes that the wrong closure.
    fetchQuery.mockClear();
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    // Reporting is sampled, so an assertion about one needs the dice fixed.
    random = jest.spyOn(Math, 'random').mockReturnValue(0);
  });

  afterEach(() => {
    warn.mockRestore();
    random.mockRestore();
  });

  /**
   * `lifecycle.fetch(args)` re-interns the key on its way in, so eviction cannot bite there. What holds only
   * the key is react-query re-running a `queryFn` it mounted earlier — a background refetch of a partition
   * nothing is reading — so the tests below re-invoke exactly that closure.
   */
  const refetchAsQueryRuntimeWould = async (call: number) => {
    const spec = fetchQuery.mock.calls[call][0] as { queryFn: () => Promise<unknown> };
    return spec.queryFn();
  };

  it('is fetched again when the store can parse its own key', async () => {
    const harness = makeGames({ from: true });

    await harness.games.lifecycle.fetch(NFL);
    // Evicts the NFL pairing, since the table holds one.
    await harness.games.lifecycle.fetch(NBA);

    await expect(refetchAsQueryRuntimeWould(0)).resolves.not.toThrow();
    // Re-derived rather than remembered, and the descriptor still reached `parse`.
    expect(harness.table.find({ partition_key: 'nfl:2026' })[0]?.game_id).toBe('nfl-g1');
    expect(captureException).not.toHaveBeenCalled();
  });

  it('reports when the store cannot, rather than only failing', async () => {
    const harness = makeGames();

    await harness.games.lifecycle.fetch(NFL);
    await harness.games.lifecycle.fetch(NBA);

    await expect(refetchAsQueryRuntimeWould(0)).rejects.toThrow('unknown partition');
    // A degradation rather than a notice, so it lands on the exception channel with a per-scope fingerprint.
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(String(captureException.mock.calls[0][0])).toContain('left the key table');
    expect(captureException.mock.calls[0][1]).toMatchObject({ tags: { cellar_degradation: 'partitions.intern_evicted.games' } });
  });
});
