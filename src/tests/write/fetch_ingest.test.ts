import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import { installTestRuntime } from '../../testing/runtime';
import { configureCellar, INERT_ERRORS, queryRuntime } from '../../runtime';
import { createFetchIngest, FetchIngestConfig, RawFetchResponse, RAW_TEXT_RESPONSE_TRANSFORM } from '../../write/fetch_ingest';
import { resetOnceGuards } from '../../diagnostics/once_guard';
import { VersionAtom } from '../../reactivity/version_atom';
import { clearIngestTimings, getIngestTimings, rollupIngestTimings } from '../../diagnostics/ingest_timing';
import { ALL_ENTITIES, NO_CHANGES, WriteResult } from '../../table/change_set';

/** An ingest that landed `rows` rows and, like every ingest before change sets, reports every entity changed. */
const ingested = (rows: number): WriteResult => ({ changes: ALL_ENTITIES, rows });

/* global globalThis */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Probe<T> = { current: T; rerender: () => void; unmount: () => void };
function renderHook<T>(useHook: () => T): Probe<T> {
  const probe: Probe<T> = { current: undefined as unknown as T, rerender: () => {}, unmount: () => {} };
  const Component = () => {
    probe.current = useHook();
    return null;
  };
  let renderer: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(React.createElement(Component));
  });
  probe.rerender = () =>
    act(() => {
      renderer.update(React.createElement(Component));
    });
  probe.unmount = () =>
    act(() => {
      renderer.unmount();
    });
  return probe;
}

const runtime = installTestRuntime();
const fetchQueryMock = runtime.fetchQuery;
const useFocusGatedQueryMock = runtime.useQuery;
const useFocusGatedQueriesMock = runtime.useQueries;

function makeCfg(over: Partial<FetchIngestConfig<string>> = {}) {
  const state = { etag: undefined as string | undefined, version: 0 };
  let queryResponse: RawFetchResponse | undefined = { data: '[]', etag: undefined };
  let queryReject: unknown;

  const rawQueryFn = jest.fn(async (): Promise<RawFetchResponse | undefined> => {
    if (queryReject !== undefined) throw queryReject;
    return queryResponse;
  });

  const version = {
    get: jest.fn(() => state.version),
    bump: jest.fn(() => {
      state.version += 1;
      return state.version;
    }),
  } as unknown as VersionAtom;

  const cfg: FetchIngestConfig<string> = {
    ingestKeyRoot: 'test_ingest',
    toParts: (key) => [key],
    version,
    rawQuery: jest.fn(() => ({ queryFn: rawQueryFn, staleTime: 1000, cacheTime: 2000 })),
    getEtag: jest.fn(() => state.etag),
    setEtag: jest.fn((_key, etag) => {
      state.etag = etag;
    }),
    ingestRaw: jest.fn(async () => ingested(5)),
    // Present by default: the unchanged-body guard only runs for a store taking concurrent socket writes.
    holdWrites: jest.fn(() => () => {}),
    ...over,
  };

  return {
    cfg,
    version,
    state,
    rawQueryFn,
    setResponse: (response: RawFetchResponse | undefined) => {
      queryResponse = response;
      queryReject = undefined;
    },
    setReject: (error: unknown) => {
      queryReject = error;
    },
  };
}

beforeEach(() => {
  fetchQueryMock.mockClear();
  useFocusGatedQueryMock.mockClear();
  useFocusGatedQueriesMock.mockClear();
  clearIngestTimings();
  // The oversized-partition report fires once per partition per session, so it has to be re-armed between tests.
  resetOnceGuards();
});

describe('createFetchIngest — timings never reach React Query as present-but-undefined', () => {
  /**
   * React Query reads `staleTime` off the observer with a `= 0` default and merges options by spread, so a key that is
   * present and `undefined` overrides the configured default and lands on 0 — stale on arrival. The focus gate builds
   * each observer once from its first render's options, so a prime that mounts disabled would bake that in and then
   * fetch as soon as it is enabled, however fresh the cache is. That is one full body per mount.
   */
  const timingKeysOf = (options: Record<string, unknown>): string[] => Object.keys(options).filter((key) => key === 'staleTime' || key === 'cacheTime');

  it('carries the partition timings even while the caller is disabled, since that is when the observer is built', () => {
    const harness = makeCfg();
    const ingest = createFetchIngest(harness.cfg);

    renderHook(() => ingest.usePrime('week', false));

    const options = useFocusGatedQueryMock.mock.calls[0][0];
    expect(options.enabled).toBe(false);
    expect(options.staleTime).toBe(1000);
    expect(options.cacheTime).toBe(2000);
  });

  it('omits the timing keys entirely for a hook addressing nothing, rather than passing undefined', () => {
    const harness = makeCfg();
    const ingest = createFetchIngest(harness.cfg);

    renderHook(() => ingest.usePrime(undefined));

    expect(timingKeysOf(useFocusGatedQueryMock.mock.calls[0][0])).toEqual([]);
  });

  // A store with an interned key resolves `rawQuery` through `describe`, which reports a key it cannot resolve as
  // evicted. The gap key was never interned, so asking for its timings filed a false eviction on every render.
  it('never asks the store to describe a key that addresses no partition', () => {
    const harness = makeCfg();
    const ingest = createFetchIngest(harness.cfg);

    renderHook(() => ingest.usePrime(''));

    expect(harness.cfg.rawQuery).not.toHaveBeenCalled();
    expect(timingKeysOf(useFocusGatedQueryMock.mock.calls[0][0])).toEqual([]);
  });

  it('takes only the timings off the request, never the request itself', async () => {
    // `rawQuery` hands back the whole request, `queryFn` included. Spreading that into the query spec replaces the
    // ingest with the bare request: the body is fetched and then dropped, and no rows are ever shredded.
    const harness = makeCfg();
    harness.setResponse({ data: '[{"x":1}]' });
    const ingest = createFetchIngest(harness.cfg);

    renderHook(() => ingest.usePrime('week'));
    await useFocusGatedQueryMock.mock.calls[0][0].queryFn();

    expect(harness.cfg.ingestRaw).toHaveBeenCalledWith('week', '[{"x":1}]', expect.objectContaining({ queryFn: expect.any(Function) }));
  });

  it('omits them when the store cannot describe the request, rather than forcing every mount to fetch', () => {
    const harness = makeCfg({
      rawQuery: jest.fn(() => {
        throw new Error('locator not ready');
      }),
    });
    const ingest = createFetchIngest(harness.cfg);

    renderHook(() => ingest.usePrime('week'));

    expect(timingKeysOf(useFocusGatedQueryMock.mock.calls[0][0])).toEqual([]);
  });
});

describe('createFetchIngest — unchanged body short-circuit', () => {
  it('shreds the first body it sees and bumps, since nothing is known about the partition yet', async () => {
    const harness = makeCfg();
    harness.setResponse({ data: '[{"id":"a","pts":1}]' });
    const ingest = createFetchIngest(harness.cfg);

    const out = await ingest.prefetch('week');

    expect(harness.cfg.ingestRaw).toHaveBeenCalledTimes(1);
    expect(harness.version.bump).toHaveBeenCalledTimes(1);
    expect(out.count).toBe(5);
  });

  it('skips the shred and the bump when a refetch brings the same body back', async () => {
    const harness = makeCfg();
    harness.setResponse({ data: '[{"id":"a","pts":1}]' });
    const ingest = createFetchIngest(harness.cfg);
    await ingest.prefetch('week');
    harness.state.version = 9;

    const out = await ingest.prefetch('week');

    expect(harness.cfg.ingestRaw).toHaveBeenCalledTimes(1);
    expect(harness.version.bump).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ version: 9, count: -2 });
  });

  it('shreds again as soon as the body differs, however slightly', async () => {
    const harness = makeCfg();
    harness.setResponse({ data: '[{"id":"a","pts":1}]' });
    const ingest = createFetchIngest(harness.cfg);
    await ingest.prefetch('week');

    // One digit of one stat, which is what a live scoring update looks like.
    harness.setResponse({ data: '[{"id":"a","pts":2}]' });
    const out = await ingest.prefetch('week');

    expect(harness.cfg.ingestRaw).toHaveBeenCalledTimes(2);
    expect(harness.version.bump).toHaveBeenCalledTimes(2);
    expect(out.count).toBe(5);
  });

  it('tracks bodies per partition, so one partition cannot suppress another', async () => {
    const harness = makeCfg();
    harness.setResponse({ data: '[{"id":"a"}]' });
    const ingest = createFetchIngest(harness.cfg);
    await ingest.prefetch('w1');

    // Same body, different partition: it has never been shredded there.
    const out = await ingest.prefetch('w2');

    expect(harness.cfg.ingestRaw).toHaveBeenCalledTimes(2);
    expect(out.count).toBe(5);
  });

  it('keeps the etag from an unchanged body, so the next fetch can still go conditional', async () => {
    // A pushed write retires the stored ETag; a refetch that turns out unchanged puts it back.
    const harness = makeCfg();
    harness.setResponse({ data: '[{"id":"a"}]', etag: 'W/"1"' });
    const ingest = createFetchIngest(harness.cfg);
    await ingest.prefetch('week');
    (harness.cfg.setEtag as jest.Mock).mockClear();

    const out = await ingest.prefetch('week');

    expect(out.count).toBe(-2);
    expect(harness.cfg.setEtag).toHaveBeenCalledWith('week', 'W/"1"');
  });

  it('takes a body with the ETag it was shredded under as unchanged, without reading the body', async () => {
    const harness = makeCfg();
    harness.setResponse({ data: '[{"id":"a","pts":1}]', etag: 'W/"1"' });
    const ingest = createFetchIngest(harness.cfg);
    await ingest.prefetch('week');

    // The bytes differ but the server names the same body: the ETag decides, so nothing hashes the body.
    harness.setResponse({ data: '[{"id":"a","pts":1} ]', etag: 'W/"1"' });
    const out = await ingest.prefetch('week');

    expect(out.count).toBe(-2);
    expect(harness.cfg.ingestRaw).toHaveBeenCalledTimes(1);
  });

  it('shreds a body whose ETag differs from the one shredded last', async () => {
    const harness = makeCfg();
    harness.setResponse({ data: '[{"id":"a","pts":1}]', etag: 'W/"1"' });
    const ingest = createFetchIngest(harness.cfg);
    await ingest.prefetch('week');

    harness.setResponse({ data: '[{"id":"a","pts":2}]', etag: 'W/"2"' });
    const out = await ingest.prefetch('week');

    expect(out.count).toBe(5);
    expect(harness.cfg.ingestRaw).toHaveBeenCalledTimes(2);
  });

  it('shreds a body with an ETag after one that had none, since nothing names the earlier body', async () => {
    const harness = makeCfg();
    harness.setResponse({ data: '[{"id":"a"}]' });
    const ingest = createFetchIngest(harness.cfg);
    await ingest.prefetch('week');

    harness.setResponse({ data: '[{"id":"a"}]', etag: 'W/"1"' });
    const out = await ingest.prefetch('week');

    expect(out.count).toBe(5);
  });

  it('records the skip, so a session can tell a no-op refetch from one that landed rows', async () => {
    const harness = makeCfg();
    harness.setResponse({ data: '[{"id":"a"}]' });
    const ingest = createFetchIngest(harness.cfg);
    await ingest.prefetch('week');
    await ingest.prefetch('week');

    const rows = getIngestTimings().map((timing) => timing.rows);
    expect(rows).toEqual([5, -2]);
  });

  it('does not hash bodies for a store with no concurrent writes, where re-shredding one is only a repaint', async () => {
    const harness = makeCfg({ holdWrites: undefined });
    harness.setResponse({ data: '[{"id":"a","pts":1}]' });
    const ingest = createFetchIngest(harness.cfg);
    await ingest.prefetch('week');

    const out = await ingest.prefetch('week');

    expect(harness.cfg.ingestRaw).toHaveBeenCalledTimes(2);
    expect(out.count).toBe(5);
  });

  it('does not hash bodies when a store has a hold but no pushes to hold', async () => {
    const harness = makeCfg({ holdWrites: () => undefined });
    harness.setResponse({ data: '[{"id":"a","pts":1}]' });
    const ingest = createFetchIngest(harness.cfg);
    await ingest.prefetch('week');

    const out = await ingest.prefetch('week');

    expect(harness.cfg.ingestRaw).toHaveBeenCalledTimes(2);
    expect(out.count).toBe(5);
  });
});

describe('createFetchIngest — a 200 carrying no body', () => {
  it('does not bump, since no rows changed and a bump would repaint every read for nothing', async () => {
    const harness = makeCfg();
    harness.state.version = 4;
    harness.setResponse({ data: undefined });
    const ingest = createFetchIngest(harness.cfg);

    const out = await ingest.prefetch('week');

    expect(harness.cfg.ingestRaw).not.toHaveBeenCalled();
    expect(harness.version.bump).not.toHaveBeenCalled();
    expect(out).toEqual({ version: 4, count: 0 });
  });
});

describe('createFetchIngest — a body that changed nothing', () => {
  it('bumps nothing when the ingest reports no entities changed, so no reader wakes to republish what it holds', async () => {
    const harness = makeCfg({ ingestRaw: jest.fn(async () => ({ changes: NO_CHANGES, rows: 3 })) });
    harness.setResponse({ data: '[{"x":1}]', etag: 'e2' });

    const result = await createFetchIngest(harness.cfg).prefetch('week');

    expect(harness.version.bump).not.toHaveBeenCalled();
    expect(result).toEqual({ version: harness.state.version, count: 3 });
    // The etag still moves: the body was real and ingested, it just matched what the table held.
    expect(harness.cfg.setEtag).toHaveBeenCalledWith('week', 'e2');
  });

  it('bumps with the entities the ingest reports', async () => {
    const changes = new Set(['p7']);
    const harness = makeCfg({ ingestRaw: jest.fn(async () => ({ changes, rows: 3 })) });
    harness.setResponse({ data: '[{"x":1}]' });

    await createFetchIngest(harness.cfg).prefetch('week');

    expect(harness.version.bump).toHaveBeenCalledWith(['week'], changes);
  });
});

describe('createFetchIngest — 304 / etag short-circuit', () => {
  it('skips the shred, etag persist, and version bump when the API reports __etagMatch', async () => {
    const harness = makeCfg();
    harness.state.etag = 'W/"prev"';
    harness.state.version = 7;
    harness.setResponse({ __etagMatch: true });
    const ingest = createFetchIngest(harness.cfg);

    const out = await ingest.prefetch('us');

    expect(harness.cfg.ingestRaw).not.toHaveBeenCalled();
    expect(harness.cfg.setEtag).not.toHaveBeenCalled();
    expect(harness.version.bump).not.toHaveBeenCalled();
    expect(out).toEqual({ version: 7, count: -1 });
  });

  it('forwards the persisted etag into the raw query (conditional fetch)', async () => {
    const harness = makeCfg();
    harness.state.etag = 'W/"abc"';
    harness.setResponse({ __etagMatch: true });
    const ingest = createFetchIngest(harness.cfg);

    await ingest.prefetch('us');

    expect(harness.cfg.getEtag).toHaveBeenCalledWith('us');
    expect(harness.cfg.rawQuery).toHaveBeenCalledWith('us', 'W/"abc"');
  });
});

describe('createFetchIngest — ingest timing', () => {
  /** `Date.now()` is read at the start, after the fetch, and after the shred. */
  const mockClock = (...times: number[]) => {
    let index = 0;
    return jest.spyOn(Date, 'now').mockImplementation(() => times[Math.min(index++, times.length - 1)]);
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('splits the wait into the fetch and the shred that follows it', async () => {
    mockClock(1_000, 1_120, 2_020);
    const harness = makeCfg();
    harness.setResponse({ data: '[{"id":1}]', etag: 'W/"new"' });
    const ingest = createFetchIngest(harness.cfg);

    await ingest.prefetch('us');

    const [timing] = getIngestTimings();
    expect(timing.fetchMs).toBe(120);
    expect(timing.ingestMs).toBe(900);
  });

  it('records the body size and row count, so a slow shred can be read against how much it shredded', async () => {
    const harness = makeCfg();
    harness.setResponse({ data: '[{"id":1}]' });
    const ingest = createFetchIngest(harness.cfg);

    await ingest.prefetch('us');

    const [timing] = getIngestTimings();
    expect(timing.chars).toBe('[{"id":1}]'.length);
    expect(timing.rows).toBe(5);
    expect(timing.store).toBe('test_ingest');
    expect(timing.partition).toBe('us');
  });

  it('reports an oversized partition once, since every read of it pays for the whole partition', async () => {
    const captureMessage = jest.fn();
    configureCellar({ errors: { captureException: jest.fn(), captureMessage } });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const harness = makeCfg({ ingestRaw: jest.fn(async () => ingested(31_430)) });
    harness.setResponse({ data: '[{"id":1}]' });
    const ingest = createFetchIngest(harness.cfg);

    await ingest.prefetch('cfb');
    await ingest.prefetch('cfb');

    expect(captureMessage).toHaveBeenCalledTimes(1);
    const [message, ctx] = captureMessage.mock.calls[0];
    expect(message).toContain('31430 rows');
    expect(ctx.level).toBe('debug');
    expect(ctx.extra).toMatchObject({ store: 'test_ingest', partition: 'cfb', rows: 31_430 });

    configureCellar({ errors: INERT_ERRORS });
    warn.mockRestore();
  });

  it('says nothing when a caller asked for the whole partition, since those rows are what it wanted', async () => {
    const captureMessage = jest.fn();
    configureCellar({ errors: { captureException: jest.fn(), captureMessage } });
    const harness = makeCfg({ ingestRaw: jest.fn(async () => ingested(31_430)) });
    harness.setResponse({ data: '[{"id":1}]' });
    const ingest = createFetchIngest(harness.cfg);

    // A prime hook with no `slice` intent — what `usePrimeSport` and the lifecycle hooks are.
    renderHook(() => ingest.usePrime('cfb'));
    await ingest.prefetch('cfb');

    expect(captureMessage).not.toHaveBeenCalled();

    configureCellar({ errors: INERT_ERRORS });
  });

  it('still reports when only a slice-selecting read primed it, which is the case the advice fits', async () => {
    const captureMessage = jest.fn();
    configureCellar({ errors: { captureException: jest.fn(), captureMessage } });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const harness = makeCfg({ ingestRaw: jest.fn(async () => ingested(31_430)) });
    harness.setResponse({ data: '[{"id":1}]' });
    const ingest = createFetchIngest(harness.cfg);

    renderHook(() => ingest.usePrime('cfb', true, { slice: true }));
    await ingest.prefetch('cfb');

    expect(captureMessage).toHaveBeenCalledTimes(1);

    configureCellar({ errors: INERT_ERRORS });
    warn.mockRestore();
  });

  it('leaves an ordinary partition alone, so the report stays worth reading', async () => {
    const captureMessage = jest.fn();
    configureCellar({ errors: { captureException: jest.fn(), captureMessage } });
    const harness = makeCfg({ ingestRaw: jest.fn(async () => ingested(12)) });
    harness.setResponse({ data: '[{"id":1}]' });

    await createFetchIngest(harness.cfg).prefetch('us');

    expect(captureMessage).not.toHaveBeenCalled();
    configureCellar({ errors: INERT_ERRORS });
  });

  it('records a 304 as a fetch that shred nothing, so a cheap launch is not mistaken for a missing ingest', async () => {
    mockClock(1_000, 1_120, 1_120);
    const harness = makeCfg();
    harness.setResponse({ __etagMatch: true });
    const ingest = createFetchIngest(harness.cfg);

    await ingest.prefetch('us');

    const [timing] = getIngestTimings();
    expect(timing.ingestMs).toBe(0);
    expect(timing.rows).toBe(-1);
    expect(timing.chars).toBeNull();
  });

  it('rolls up totals per store', async () => {
    const harness = makeCfg();
    harness.setResponse({ data: '[{"id":1}]' });
    const ingest = createFetchIngest(harness.cfg);

    await ingest.prefetch('us');
    await ingest.prefetch('eu');

    const [roll] = rollupIngestTimings();
    expect(roll.store).toBe('test_ingest');
    expect(roll.fetches).toBe(2);
    expect(roll.rows).toBe(10);
  });

  it('does not count an etag match toward rows, which would iusate what the store actually shredded', async () => {
    const harness = makeCfg();
    harness.setResponse({ __etagMatch: true });
    const ingest = createFetchIngest(harness.cfg);

    await ingest.prefetch('us');

    const [roll] = rollupIngestTimings();
    expect(roll.rows).toBe(0);
    expect(roll.fetches).toBe(1);
  });
});

describe('createFetchIngest — holdWrites', () => {
  function makeHeld() {
    const order: string[] = [];
    const release = jest.fn(() => {
      order.push('release');
    });
    const holdWrites = jest.fn(() => {
      order.push('hold');
      return release;
    });
    return { order, release, holdWrites };
  }

  it('holds before the request goes out and releases only after the rows are in', async () => {
    const held = makeHeld();
    const harness = makeCfg({ holdWrites: held.holdWrites });
    harness.cfg.rawQuery = jest.fn(() => ({
      queryFn: async () => {
        held.order.push('request');
        return { data: '[{"item_id":"a"}]' };
      },
    }));
    harness.cfg.ingestRaw = jest.fn(async () => {
      held.order.push('ingest');
      return ingested(1);
    });

    await createFetchIngest(harness.cfg).prefetch('us');

    expect(held.holdWrites).toHaveBeenCalledWith('us');
    expect(held.order).toEqual(['hold', 'request', 'ingest', 'release']);
  });

  it('releases on a 304, which ingests nothing but still held the partition', async () => {
    const held = makeHeld();
    const harness = makeCfg({ holdWrites: held.holdWrites });
    harness.setResponse({ __etagMatch: true });

    await createFetchIngest(harness.cfg).prefetch('us');

    expect(held.order).toEqual(['hold', 'release']);
  });

  it('releases on a failed request, so a dead partition does not wedge the other writer', async () => {
    const held = makeHeld();
    const harness = makeCfg({ holdWrites: held.holdWrites });
    harness.setReject(new Error('offline'));

    await expect(createFetchIngest(harness.cfg).prefetch('us')).rejects.toThrow('offline');

    expect(held.release).toHaveBeenCalledTimes(1);
  });
});

describe('createFetchIngest — successful ingest (200)', () => {
  it('shreds the raw text, persists the new etag, and bumps the version once', async () => {
    const harness = makeCfg();
    harness.setResponse({ data: '[{"item_id":"a"}]', etag: 'W/"new"' });
    const ingest = createFetchIngest(harness.cfg);

    const out = await ingest.prefetch('us');

    expect(harness.cfg.ingestRaw).toHaveBeenCalledWith('us', '[{"item_id":"a"}]', expect.objectContaining({ queryFn: expect.any(Function) }));
    expect(harness.cfg.setEtag).toHaveBeenCalledWith('us', 'W/"new"');
    expect(harness.version.bump).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ version: 1, count: 5 });
  });

  it('coerces a non-string (object) body to JSON text before shredding', async () => {
    const harness = makeCfg();
    harness.setResponse({ data: { items: [1, 2] }, etag: 'e' });
    const ingest = createFetchIngest(harness.cfg);

    await ingest.prefetch('us');

    expect(harness.cfg.ingestRaw).toHaveBeenCalledWith('us', JSON.stringify({ items: [1, 2] }), expect.objectContaining({ queryFn: expect.any(Function) }));
  });

  it('refuses the etag from a 200 that carried no body, so the next launch is a real fetch', async () => {
    const harness = makeCfg();
    harness.setResponse({ etag: 'e' });
    const ingest = createFetchIngest(harness.cfg);

    await ingest.prefetch('us');

    expect(harness.cfg.ingestRaw).not.toHaveBeenCalled();
    expect(harness.cfg.setEtag).not.toHaveBeenCalled();
  });

  it('persists the etag for a body that held no rows, which is a partition that is genuinely empty', async () => {
    const harness = makeCfg();
    harness.setResponse({ data: '[]', etag: 'e' });
    const ingest = createFetchIngest(harness.cfg);

    await ingest.prefetch('us');

    expect(harness.cfg.ingestRaw).toHaveBeenCalledWith('us', '[]', expect.objectContaining({ queryFn: expect.any(Function) }));
    expect(harness.cfg.setEtag).toHaveBeenCalledWith('us', 'e');
  });

  it('refuses the etag for an empty-string body too, which is the same nothing as a missing one', async () => {
    const harness = makeCfg();
    harness.setResponse({ data: '', etag: 'e' });
    const ingest = createFetchIngest(harness.cfg);

    await ingest.prefetch('us');

    expect(harness.cfg.setEtag).not.toHaveBeenCalled();
  });

  it('does not persist an etag the response omitted', async () => {
    const harness = makeCfg();
    harness.setResponse({ data: '[]' });
    const ingest = createFetchIngest(harness.cfg);

    await ingest.prefetch('us');

    expect(harness.cfg.setEtag).not.toHaveBeenCalled();
    expect(harness.version.bump).toHaveBeenCalledTimes(1);
  });
});

describe('createFetchIngest — prefetch / ensure gating', () => {
  it('short-circuits (no fetch) when any partition part is falsy', async () => {
    const harness = makeCfg();
    harness.state.version = 3;
    const ingest = createFetchIngest(harness.cfg);

    const out = await ingest.prefetch('');

    expect(harness.rawQueryFn).not.toHaveBeenCalled();
    expect(fetchQueryMock).not.toHaveBeenCalled();
    expect(out).toEqual({ version: 3, count: 0 });
  });

  it('passes the store staleTime by default and a caller override when given', async () => {
    const harness = makeCfg();
    harness.setResponse({ data: '[]', etag: 'e' });
    const ingest = createFetchIngest(harness.cfg);

    await ingest.prefetch('us');
    expect(fetchQueryMock.mock.calls[0][0].staleTime).toBe(1000);

    await ingest.prefetch('us', { staleTime: 50 });
    expect(fetchQueryMock.mock.calls[1][0].staleTime).toBe(50);
  });

  it('ensure runs the same flow and swallows a fetch error (best-effort auto-prime)', async () => {
    const harness = makeCfg();
    harness.setReject(new Error('network down'));
    const ingest = createFetchIngest(harness.cfg);

    expect(() => ingest.ensure('us')).not.toThrow();
    await new Promise((response) => {
      setTimeout(response, 0);
    });
    expect(fetchQueryMock).toHaveBeenCalledTimes(1);

    await expect(ingest.prefetch('us')).rejects.toThrow('network down');
  });
});

describe('createFetchIngest — usePrime (reactive wiring)', () => {
  it('wires the focus-gated query with the partition key, timings, and narrow notify props', () => {
    const harness = makeCfg();
    const ingest = createFetchIngest(harness.cfg);

    const res = ingest.usePrime('us');

    const config = useFocusGatedQueryMock.mock.calls[0][0];
    expect(config.queryKey).toEqual(['test_ingest', 'us']);
    expect(config.enabled).toBe(true);
    expect(config.staleTime).toBe(1000);
    expect(config.cacheTime).toBe(2000);
    // Must include `isError`, or a failed fetch never re-renders the read that would report it. Must exclude
    // `isFetching`, which toggles twice per fetch and would wake every reader on the partition to say nothing changed.
    expect(config.notifyOnChangeProps).toEqual(['isInitialLoading', 'isError']);
    expect(res).toEqual({ isInitialLoading: false, isFetching: false, isError: false });
  });

  it("puts a caller's meta on its query, and on no other caller's", () => {
    const harness = makeCfg();
    const ingest = createFetchIngest(harness.cfg);

    ingest.usePrime('us', true, { meta: { bypassFocusGate: true } });
    ingest.usePrime('us');
    renderHook(() => ingest.usePrimeMany(['us', 'eu'], true, { meta: { bypassFocusGate: true } }));

    expect(useFocusGatedQueryMock.mock.calls[0][0].meta).toEqual({ bypassFocusGate: true });
    expect(useFocusGatedQueryMock.mock.calls[1][0]).not.toHaveProperty('meta');
    const many = useFocusGatedQueriesMock.mock.calls[0][0].queries;
    expect(many.map((query: { meta?: unknown }) => query.meta)).toEqual([{ bypassFocusGate: true }, { bypassFocusGate: true }]);
  });

  it('keeps a set of queries when its caller passes the same meta again, as a new object', () => {
    const harness = makeCfg();
    const ingest = createFetchIngest(harness.cfg);

    const probe = renderHook(() => ingest.usePrimeMany(['us', 'eu'], true, { meta: { bypassFocusGate: true } }));
    probe.rerender();

    const calls = useFocusGatedQueriesMock.mock.calls;
    expect(calls[calls.length - 1][0].queries).toBe(calls[0][0].queries);
  });

  it('disables the query when a part is falsy, or when explicitly disabled', () => {
    const harness = makeCfg();
    const ingest = createFetchIngest(harness.cfg);

    ingest.usePrime('');
    expect(useFocusGatedQueryMock.mock.calls[0][0].enabled).toBe(false);

    ingest.usePrime('us', false);
    expect(useFocusGatedQueryMock.mock.calls[1][0].enabled).toBe(false);
  });

  it("the query's queryFn runs the same ingest flow (shred + bump)", async () => {
    const harness = makeCfg();
    harness.setResponse({ data: '[{"x":1}]', etag: 'e' });
    const ingest = createFetchIngest(harness.cfg);

    ingest.usePrime('us');
    const { queryFn } = useFocusGatedQueryMock.mock.calls[0][0];
    const out = await queryFn();

    expect(harness.cfg.ingestRaw).toHaveBeenCalledWith('us', '[{"x":1}]', expect.objectContaining({ queryFn: expect.any(Function) }));
    expect(out).toEqual({ version: 1, count: 5 });
  });

  it('renders on default timings when `rawQuery` throws, and still fails the fetch itself', async () => {
    const unknown = new Error('unknown partition');
    const harness = makeCfg({
      rawQuery: jest.fn(() => {
        throw unknown;
      }),
    });
    const ingest = createFetchIngest(harness.cfg);

    expect(() => ingest.usePrime('us')).not.toThrow();

    const config = useFocusGatedQueryMock.mock.calls[0][0];
    expect(config.staleTime).toBeUndefined();
    expect(config.cacheTime).toBeUndefined();
    await expect(config.queryFn()).rejects.toThrow(unknown);
  });
});

describe('createFetchIngest — usePrimeMany (a partition set whose size varies per render)', () => {
  it('runs one query per partition through a single hook, so the count can change between renders', () => {
    const harness = makeCfg();
    const ingest = createFetchIngest(harness.cfg);

    renderHook(() => ingest.usePrimeMany(['us', 'eu']));
    const first = useFocusGatedQueriesMock.mock.calls[0][0].queries;
    expect(first.map((query: { queryKey: string[] }) => query.queryKey)).toEqual([
      ['test_ingest', 'us'],
      ['test_ingest', 'eu'],
    ]);
    expect(first[0].notifyOnChangeProps).toEqual(['isInitialLoading', 'isError']);

    renderHook(() => ingest.usePrimeMany(['us']));
    expect(useFocusGatedQueriesMock.mock.calls[1][0].queries).toHaveLength(1);
  });

  it('skips a partition with a falsy part rather than fetching a nonsense key', () => {
    const harness = makeCfg();
    const ingest = createFetchIngest(harness.cfg);

    renderHook(() => ingest.usePrimeMany(['us', '']));

    expect(useFocusGatedQueriesMock.mock.calls[0][0].queries).toHaveLength(1);
  });

  it('disables every query at once when the read is disabled', () => {
    const harness = makeCfg();
    const ingest = createFetchIngest(harness.cfg);

    renderHook(() => ingest.usePrimeMany(['us', 'eu'], false));

    expect(useFocusGatedQueriesMock.mock.calls[0][0].queries.every((query: { enabled: boolean }) => !query.enabled)).toBe(true);
  });

  it('reports loading while any one partition is still on its first fetch', () => {
    const harness = makeCfg();
    const ingest = createFetchIngest(harness.cfg);
    useFocusGatedQueriesMock.mockReturnValueOnce([{ isInitialLoading: false }, { isInitialLoading: true }]);

    expect(renderHook(() => ingest.usePrimeMany(['us', 'eu'])).current).toEqual({ isInitialLoading: true, isFetching: false, isError: false });
  });

  it('reports fetching while any one partition refreshes, even though none is initially loading', () => {
    const harness = makeCfg();
    const ingest = createFetchIngest(harness.cfg);
    useFocusGatedQueriesMock.mockReturnValueOnce([
      { isInitialLoading: false, isFetching: false },
      { isInitialLoading: false, isFetching: true },
    ]);

    expect(renderHook(() => ingest.usePrimeMany(['us', 'eu'])).current).toEqual({ isInitialLoading: false, isFetching: true, isError: false });
  });

  it('reports error only when every partition failed, so one bad partition degrades to a gap', () => {
    const harness = makeCfg();
    const ingest = createFetchIngest(harness.cfg);

    useFocusGatedQueriesMock.mockReturnValueOnce([{ isError: true }, { isError: false }]);
    expect(renderHook(() => ingest.usePrimeMany(['us', 'eu'])).current.isError).toBe(false);

    useFocusGatedQueriesMock.mockReturnValueOnce([{ isError: true }, { isError: true }]);
    expect(renderHook(() => ingest.usePrimeMany(['us', 'eu'])).current.isError).toBe(true);
  });

  it('reports no error for an empty partition set, so a list with nothing live is not an error', () => {
    const harness = makeCfg();
    const ingest = createFetchIngest(harness.cfg);
    useFocusGatedQueriesMock.mockReturnValueOnce([]);

    expect(renderHook(() => ingest.usePrimeMany([''])).current).toEqual({ isInitialLoading: false, isFetching: false, isError: false });
  });

  it('hands the same queries array back across a re-render with an equal partition set', () => {
    const harness = makeCfg();
    const ingest = createFetchIngest(harness.cfg);

    // A fresh array each render, as `def.partitions(args)` produces.
    const probe = renderHook(() => ingest.usePrimeMany(['us', 'eu']));
    probe.rerender();
    probe.rerender();

    const [first, second, third] = useFocusGatedQueriesMock.mock.calls.map((call) => call[0].queries);
    expect(second).toBe(first);
    expect(third).toBe(first);
    probe.unmount();
  });

  it('builds each partition’s raw query once, not once per render', () => {
    const harness = makeCfg();
    const ingest = createFetchIngest(harness.cfg);

    const probe = renderHook(() => ingest.usePrimeMany(['us', 'eu']));
    (harness.cfg.rawQuery as jest.Mock).mockClear();
    probe.rerender();

    expect(harness.cfg.rawQuery).not.toHaveBeenCalled();
    probe.unmount();
  });

  it('rebuilds when the partition set actually changes, so a new partition is still fetched', () => {
    const harness = makeCfg();
    const ingest = createFetchIngest(harness.cfg);

    let partitions: string[] = ['us'];
    const probe = renderHook(() => ingest.usePrimeMany(partitions));
    partitions = ['us', 'eu'];
    probe.rerender();

    const [first, second] = useFocusGatedQueriesMock.mock.calls.map((call) => call[0].queries);
    expect(second).not.toBe(first);
    expect(second.map((query: { queryKey: string[] }) => query.queryKey)).toEqual([
      ['test_ingest', 'us'],
      ['test_ingest', 'eu'],
    ]);
    probe.unmount();
  });

  it('rebuilds when `enabled` flips, which is carried on the query objects themselves', () => {
    const harness = makeCfg();
    const ingest = createFetchIngest(harness.cfg);

    let enabled = true;
    const probe = renderHook(() => ingest.usePrimeMany(['us'], enabled));
    enabled = false;
    probe.rerender();

    const [first, second] = useFocusGatedQueriesMock.mock.calls.map((call) => call[0].queries);
    expect(second).not.toBe(first);
    expect(second[0].enabled).toBe(false);
    probe.unmount();
  });

  it("each query's queryFn runs the same ingest flow as usePrime's", async () => {
    const harness = makeCfg();
    harness.setResponse({ data: '[{"x":1}]', etag: 'e' });
    const ingest = createFetchIngest(harness.cfg);

    renderHook(() => ingest.usePrimeMany(['us']));
    const out = await useFocusGatedQueriesMock.mock.calls[0][0].queries[0].queryFn();

    expect(harness.cfg.ingestRaw).toHaveBeenCalledWith('us', '[{"x":1}]', expect.objectContaining({ queryFn: expect.any(Function) }));
    expect(out).toEqual({ version: 1, count: 5 });
  });
});

describe('forget', () => {
  it('drops every partition this store has fetched, not just one', () => {
    const harness = makeCfg();
    createFetchIngest(harness.cfg).forget();

    expect(runtime.removeQueries).toHaveBeenCalledWith({ queryKey: ['test_ingest'] });
  });

  it('removes rather than invalidates, so a mounted reader stops showing rows the store no longer has', () => {
    const harness = makeCfg();
    createFetchIngest(harness.cfg).forget();

    expect(runtime.invalidateQueries).not.toHaveBeenCalled();
  });
});

describe('RAW_TEXT_RESPONSE_TRANSFORM', () => {
  it('is a single identity transform (keeps the raw body as text for the native shred)', () => {
    expect(RAW_TEXT_RESPONSE_TRANSFORM).toHaveLength(1);
    const body = '{"big":"payload"}';
    expect(RAW_TEXT_RESPONSE_TRANSFORM[0](body)).toBe(body);
  });
});
