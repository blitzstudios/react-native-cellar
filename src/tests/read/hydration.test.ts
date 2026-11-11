import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import { defineSqliteStore } from '../../define_sqlite_store';
import { byEntity } from '../../read/derived_values';
import { pairRead } from '../../read/facade';
import { CellarHydrate, dehydrateReads, readCall, ReadSnapshot } from '../../read/hydration';
import { configureCellar } from '../../runtime';
import { reportStoreDegradation } from '../../diagnostics/telemetry';
import { StoreTableSchema } from '../../table/partitioned';
import { installTestRuntime } from '../../testing/runtime';
import { createSqlJsConnection } from '../../testing/sqljs_connection';
import type { DataResult } from '../../store_result';

jest.mock('../../diagnostics/telemetry', () => ({ reportStoreDegradation: jest.fn() }));

const runtime = installTestRuntime();

type Player = { sport: string; player_id: string; team: string | null };
type Card = { id: string; team: string | null };

const PLAYERS: StoreTableSchema<Player> = {
  table: 'players',
  columns: { sport: { type: 'TEXT', notNull: true }, player_id: { type: 'TEXT', notNull: true }, team: { type: 'TEXT' } },
  uniqueBy: ['sport', 'player_id'],
  entityId: 'player_id',
};

const NO_CARDS: readonly (Card | undefined)[] = Object.freeze([]);

/** A player store whose fetch serves `server`, published through `pairRead` the way a service publishes its reads. */
function playerService() {
  const server: Record<string, Record<string, { player_id: string; team: string }> | Error> = {
    nfl: { p1: { player_id: 'p1', team: 'SF' }, p2: { player_id: 'p2', team: 'KC' } },
    nba: { p1: { player_id: 'p1', team: 'LAL' } },
    mlb: {},
  };
  const store = defineSqliteStore({
    name: 'players',
    schema: PLAYERS,
    partition: ({ sport }: { sport?: string | null }) => (sport ? { sport } : null),
    fetch: ({ sport }: { sport: string }) => ({
      query: {
        queryFn: async () => {
          const body = server[sport];
          if (body instanceof Error) throw body;
          return { data: JSON.stringify(body) };
        },
      },
      toRows: (raw: string) => Object.values(JSON.parse(raw) as Record<string, { player_id: string; team: string }>).map((one) => ({ sport, ...one })),
    }),
    build: (cellar) => {
      const { cards } = cellar.defineCaches({
        cards: byEntity({ max: 64, fromRows: ([row]): Card | undefined => (row ? { id: row.player_id, team: row.team } : undefined) }),
      });
      return {
        reads: {
          Card: cellar.defineRead<{ sport: string; playerId: string }, Card | undefined>({
            select: (args, key) => cards.at(key, args.playerId),
            empty: undefined,
          }),
          CardAcross: cellar.defineReadAcross<{ sports: readonly string[]; playerId: string }, readonly (Card | undefined)[]>({
            partitions: (args) => args.sports.map((sport) => ({ sport })),
            select: (args, keys) => keys.map((key) => cards.at(key, args.playerId)),
            empty: NO_CARDS,
          }),
        },
      };
    },
  });
  const Card = pairRead(() => store.reads.Card);
  const CardAcross = pairRead(() => store.reads.CardAcross);
  const bind = () => store.bindSqlite(createSqlJsConnection({ capabilities: 'full' }));
  return { store, server, bind, useCard: Card.useValue, getCard: Card.getValue, useCardAcross: CardAcross.useValue, useEachCard: CardAcross.useEach };
}

type Probe<T> = { current: () => T; rerender: () => void; unmount: () => void };

/** Renders `useHook` under a `CellarHydrate` holding `snapshot`, and hands back what it returned. */
function render<T>(useHook: () => T, snapshot?: ReadSnapshot): Probe<T> {
  let latest: T | undefined;
  function Component(): null {
    latest = useHook();
    return null;
  }
  const tree = () => React.createElement(CellarHydrate, { snapshot }, React.createElement(Component));
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    renderer = TestRenderer.create(tree());
  });
  return {
    current: () => latest as T,
    rerender: () => act(() => renderer?.update(tree())),
    unmount: () => act(() => renderer?.unmount()),
  };
}

const lastPrimeSpec = () => runtime.useQuery.mock.calls[runtime.useQuery.mock.calls.length - 1]?.[0] as { enabled?: boolean } | undefined;

const SF: Card = { id: 'p1', team: 'SF' };

/** The snapshot a server would hand the page, after a round trip through the HTML it travels in. */
async function serverSnapshot(build: (service: ReturnType<typeof playerService>) => Parameters<typeof dehydrateReads>[0]) {
  const service = playerService();
  service.bind();
  const snapshot = await dehydrateReads(build(service));
  return { snapshot: JSON.parse(JSON.stringify(snapshot)) as ReadSnapshot, service };
}

beforeEach(() => {
  runtime.useQuery.mockClear();
  runtime.fetchQuery.mockClear();
  (reportStoreDegradation as jest.Mock).mockClear();
  configureCellar({ serverRendering: false });
});

describe('dehydrateReads — on the server', () => {
  it('fetches each read’s partition and files its value under the read and its args', async () => {
    const { snapshot } = await serverSnapshot((s) => [readCall(s.useCard, { sport: 'nfl', playerId: 'p1' })]);

    expect(Object.values(snapshot.reads)).toEqual([{ value: SF }]);
    expect(runtime.fetchQuery).toHaveBeenCalledTimes(1);
  });

  it('takes the getter as readily as the hook, and keys both the same', async () => {
    const byHook = await serverSnapshot((s) => [readCall(s.useCard, { sport: 'nfl', playerId: 'p1' })]);
    const byGetter = await serverSnapshot((s) => [readCall(s.getCard, { playerId: 'p1', sport: 'nfl' })]);

    expect(Object.keys(byGetter.snapshot.reads)).toEqual(Object.keys(byHook.snapshot.reads));
  });

  it('files a partition that came back empty as the read’s empty value, so the browser has nothing to fetch for it', async () => {
    const { snapshot } = await serverSnapshot((s) => [readCall(s.useCard, { sport: 'mlb', playerId: 'p1' })]);

    expect(Object.values(snapshot.reads)).toEqual([{ value: undefined }]);
  });

  it('marks a live read, so the browser goes on to fetch it', async () => {
    const { snapshot } = await serverSnapshot((s) => [readCall(s.useCard, { sport: 'nfl', playerId: 'p1' }, { live: true })]);

    expect(Object.values(snapshot.reads)).toEqual([{ value: SF, live: true }]);
  });

  it('captures nothing for a call that is still missing an arg', async () => {
    const { snapshot } = await serverSnapshot((s) => [readCall(s.useCard, { sport: 'nfl', playerId: null })]);

    expect(snapshot.reads).toEqual({});
    expect(runtime.fetchQuery).not.toHaveBeenCalled();
  });

  it('leaves out a read whose fetch failed, reports it, and still captures the others', async () => {
    const { snapshot } = await serverSnapshot((s) => {
      s.server.nba = new Error('upstream 503');
      return [readCall(s.useCard, { sport: 'nba', playerId: 'p1' }), readCall(s.useCard, { sport: 'nfl', playerId: 'p1' })];
    });

    expect(Object.values(snapshot.reads)).toEqual([{ value: SF }]);
    expect(reportStoreDegradation).toHaveBeenCalledWith(expect.objectContaining({ scope: 'hydration.capture' }));
  });

  it('records which partitions held rows for a read across several', async () => {
    const { snapshot } = await serverSnapshot((s) => [readCall(s.useCardAcross, { sports: ['nfl', 'mlb'], playerId: 'p1' })]);

    // JSON carries a list's missing entry as null.
    expect(Object.values(snapshot.reads)).toEqual([{ value: [SF, null], present: [true, false] }]);
  });

  it('refuses a function no pairRead published', () => {
    expect(() => readCall(((_args: { params: { id: string } }) => undefined) as never, { id: 'x' })).toThrow('pairRead');
  });
});

describe('a hook under CellarHydrate — in the browser', () => {
  it('answers from the snapshot, as a success, while its store is not yet bound', async () => {
    const { snapshot } = await serverSnapshot((s) => [readCall(s.useCard, { sport: 'nfl', playerId: 'p1' })]);
    const browser = playerService();

    const probe = render(() => browser.useCard({ params: { sport: 'nfl', playerId: 'p1' } }), snapshot);

    expect(probe.current()).toMatchObject({ data: SF, status: 'success' });
  });

  it('does not fetch a partition the snapshot answered', async () => {
    const { snapshot } = await serverSnapshot((s) => [readCall(s.useCard, { sport: 'nfl', playerId: 'p1' })]);
    const browser = playerService();
    browser.bind();

    render(() => browser.useCard({ params: { sport: 'nfl', playerId: 'p1' } }), snapshot);

    expect(lastPrimeSpec()?.enabled).toBe(false);
  });

  it('fetches a live read, and moves to the store’s value once its rows land', async () => {
    const { snapshot } = await serverSnapshot((s) => [readCall(s.useCard, { sport: 'nfl', playerId: 'p1' }, { live: true })]);
    const browser = playerService();
    browser.bind();
    browser.server.nfl = { p1: { player_id: 'p1', team: 'LV' } };

    const probe = render(() => browser.useCard({ params: { sport: 'nfl', playerId: 'p1' } }), snapshot);
    expect(lastPrimeSpec()?.enabled).toBe(true);
    expect(probe.current().data).toEqual(SF);

    await act(async () => {
      await browser.store.lifecycle.fetch({ sport: 'nfl' });
    });

    expect(probe.current()).toMatchObject({ data: { id: 'p1', team: 'LV' }, status: 'success' });
  });

  it('prefers the store once it holds the partition, whoever fetched it', async () => {
    const { snapshot } = await serverSnapshot((s) => [readCall(s.useCard, { sport: 'nfl', playerId: 'p1' })]);
    const browser = playerService();
    browser.bind();
    browser.server.nfl = { p1: { player_id: 'p1', team: 'LV' } };
    await browser.store.lifecycle.fetch({ sport: 'nfl' });

    const probe = render(() => browser.useCard({ params: { sport: 'nfl', playerId: 'p1' } }), snapshot);

    expect(probe.current().data).toEqual({ id: 'p1', team: 'LV' });
  });

  it('reads and fetches as usual for a call the snapshot does not hold', async () => {
    const { snapshot } = await serverSnapshot((s) => [readCall(s.useCard, { sport: 'nfl', playerId: 'p1' })]);
    const browser = playerService();
    browser.bind();

    const probe = render(() => browser.useCard({ params: { sport: 'nfl', playerId: 'p2' } }), snapshot);

    expect(probe.current().data).toBeUndefined();
    expect(lastPrimeSpec()?.enabled).toBe(true);
  });

  it('reports each partition of a read across several from the snapshot', async () => {
    const { snapshot } = await serverSnapshot((s) => [readCall(s.useEachCard, { sports: ['nfl', 'mlb'], playerId: 'p1' })]);
    const browser = playerService();

    const probe = render(() => browser.useEachCard({ params: { sports: ['nfl', 'mlb'], playerId: 'p1' } }), snapshot);
    const whole = render(() => browser.useCardAcross({ params: { sports: ['nfl', 'mlb'], playerId: 'p1' } }), snapshot);

    expect(probe.current().map((result) => [result.data, result.status])).toEqual([
      [SF, 'success'],
      [null, 'success'],
    ]);
    expect(whole.current()).toMatchObject({ data: [SF, null], status: 'success' });
  });

  it('adds a nested snapshot to the one above it', async () => {
    const outer = await serverSnapshot((s) => [readCall(s.useCard, { sport: 'nfl', playerId: 'p1' })]);
    const inner = await serverSnapshot((s) => [readCall(s.useCard, { sport: 'nfl', playerId: 'p2' })]);
    const browser = playerService();
    const results: Record<string, DataResult<Card | undefined>> = {};
    function Both(): null {
      results.p1 = browser.useCard({ params: { sport: 'nfl', playerId: 'p1' } });
      results.p2 = browser.useCard({ params: { sport: 'nfl', playerId: 'p2' } });
      return null;
    }

    act(() => {
      TestRenderer.create(
        React.createElement(CellarHydrate, { snapshot: outer.snapshot }, React.createElement(CellarHydrate, { snapshot: inner.snapshot }, React.createElement(Both))),
      );
    });

    expect(results.p1.data).toEqual(SF);
    expect(results.p2.data).toEqual({ id: 'p2', team: 'KC' });
  });
});

describe('a hook — when the process renders on the server', () => {
  it('answers from the snapshot even when the store holds newer rows, so the HTML matches the snapshot the browser gets', async () => {
    const { snapshot, service } = await serverSnapshot((s) => [readCall(s.useCard, { sport: 'nfl', playerId: 'p1' })]);
    service.server.nfl = { p1: { player_id: 'p1', team: 'LV' } };
    await service.store.lifecycle.fetch({ sport: 'nfl' }, { staleTime: 0 });
    configureCellar({ serverRendering: true });

    const probe = render(() => service.useCard({ params: { sport: 'nfl', playerId: 'p1' } }), snapshot);

    expect(probe.current()).toMatchObject({ data: SF, status: 'success' });
  });

  it('answers empty, as loading, for a call the snapshot does not hold, the way the browser first renders it', async () => {
    const { service } = await serverSnapshot((s) => [readCall(s.useCard, { sport: 'nfl', playerId: 'p1' })]);
    configureCellar({ serverRendering: true });

    const probe = render(() => service.useCard({ params: { sport: 'nfl', playerId: 'p1' } }));

    expect(probe.current()).toMatchObject({ data: undefined, status: 'loading' });
    expect(lastPrimeSpec()?.enabled).toBe(false);
  });

  it('reports a disabled call as a success, as the browser does', async () => {
    const { service } = await serverSnapshot(() => []);
    configureCellar({ serverRendering: true });

    const probe = render(() => service.useCard({ params: { sport: 'nfl', playerId: 'p1' }, options: { enabled: false } }));

    expect(probe.current()).toMatchObject({ data: undefined, status: 'success' });
  });

  it('still lets getValue read the store, which is how a server fills a snapshot', async () => {
    const { service } = await serverSnapshot((s) => [readCall(s.useCard, { sport: 'nfl', playerId: 'p1' })]);
    configureCellar({ serverRendering: true });

    expect(service.getCard({ params: { sport: 'nfl', playerId: 'p1' } })).toEqual(SF);
  });
});
