import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import { createReadSurface } from '../../read/surface';
import { setLogLevel } from '../../diagnostics/log_level';
import { describeDev } from '../../testing/dev_mode';
import { resetOnceGuards } from '../../diagnostics/once_guard';
import { createVersionAtom } from '../../reactivity/version_atom';

/* global globalThis */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let warn: jest.SpyInstance;

beforeEach(() => {
  jest.useFakeTimers();
  resetOnceGuards();
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  // Guidance is above the default level; a host raises it from its dev menu when hunting.
  setLogLevel('warn');
});

afterEach(() => {
  setLogLevel('error');
  warn.mockRestore();
  jest.useRealTimers();
});

function fanoutWarnings(): string[] {
  return warn.mock.calls.map((args) => String(args[0])).filter((message) => message.includes('separate reads in one tick'));
}

function makeSurface(name?: string) {
  const atom = createVersionAtom('fanout_test_version');
  const present = new Set<string>(['us']);
  const surface = createReadSurface<string>({
    name,
    version: atom,
    toParts: (region) => [region],
    has: (region) => present.has(region),
    ingest: {
      usePrime: () => ({ isInitialLoading: false, isFetching: false, isError: false }),
      usePrimeMany: () => ({ isInitialLoading: false, isFetching: false, isError: false }),
      ensure: () => {},
      refetch: () => {},
    },
  });

  return surface.read<{ region: string; id: string }, string>({
    partition: (args) => args.region,
    select: (args) => args.id,
    empty: '',
  });
}

function renderRows(surface: { useValue: (args: { region: string; id: string } | undefined) => unknown }, rows: number): void {
  const Row = ({ id }: { id: string }): null => {
    surface.useValue({ region: 'us', id });
    return null;
  };
  const List = (): React.ReactElement =>
    React.createElement(
      React.Fragment,
      null,
      Array.from({ length: rows }, (_value, index) => React.createElement(Row, { key: index, id: `p${index}` })),
    );
  act(() => {
    TestRenderer.create(React.createElement(List));
  });
  act(() => {
    jest.advanceTimersByTime(1);
  });
}

describeDev('per-row fan-out tripwire', () => {
  it('warns when many rows each read for themselves, naming the store and sampling the args', () => {
    const surface = makeSurface('item');
    renderRows(surface, 60);

    const warnings = fanoutWarnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('[item_store]');
    expect(warnings[0]).toContain('60 separate reads');
    expect(warnings[0]).toContain('id\u0000"p0"');
  });

  it('tells a per-row reader to batch, since that is the fix when each row names one thing', () => {
    const surface = makeSurface('item');
    renderRows(surface, 60);

    const [warning] = fanoutWarnings();
    expect(warning).toContain('A list is reading per row');
    expect(warning).toContain('plural `*ByIds` read');
  });

  it('tells an already-plural reader to lift the read instead, rather than describing what it does', () => {
    const atom = createVersionAtom('fanout_batched_version');
    const surface = createReadSurface<string>({
      name: 'batched',
      version: atom,
      toParts: (region) => [region],
      has: () => true,
      ingest: {
        usePrime: () => ({ isInitialLoading: false, isFetching: false, isError: false }),
        usePrimeMany: () => ({ isInitialLoading: false, isFetching: false, isError: false }),
        ensure: () => {},
        refetch: () => {},
      },
    }).read<{ region: string; ids: string[] }, string>({
      partition: (args) => args.region,
      select: (args) => args.ids.join(),
      empty: '',
    });

    // 60 rows, each already asking for a set of 5 — the matchup-screen shape.
    const Row = ({ base }: { base: number }): null => {
      surface.useValue({ region: 'us', ids: [`p${base}`, `p${base + 1}`, `p${base + 2}`, `p${base + 3}`, `p${base + 4}`] });
      return null;
    };
    act(() => {
      TestRenderer.create(
        React.createElement(
          React.Fragment,
          null,
          Array.from({ length: 60 }, (_value, index) => React.createElement(Row, { key: index, base: index * 5 })),
        ),
      );
    });
    act(() => {
      jest.advanceTimersByTime(1);
    });

    const [warning] = fanoutWarnings();
    expect(warning).toContain('already plural');
    expect(warning).toContain('lift it to the parent');
    expect(warning).not.toContain('A list is reading per row');
  });

  it('stays quiet for a list whose reads are batched, because one batched read is one arg key', () => {
    const surface = makeSurface('item');
    const Parent = (): null => {
      surface.useValue({ region: 'us', id: Array.from({ length: 40 }, (_value, index) => `p${index}`).join(',') });
      return null;
    };
    act(() => {
      TestRenderer.create(React.createElement(Parent));
    });
    act(() => {
      jest.advanceTimersByTime(1);
    });

    expect(fanoutWarnings()).toEqual([]);
  });

  it('says nothing at the default level, since guidance a caller cannot act on is not worth a launch of console', () => {
    setLogLevel('error');
    const surface = makeSurface('item');
    renderRows(surface, 60);

    expect(fanoutWarnings()).toEqual([]);
  });

  it('stays quiet below the threshold, so an ordinary screen with a few reads is not flagged', () => {
    const surface = makeSurface('item');
    renderRows(surface, 8);

    expect(fanoutWarnings()).toEqual([]);
  });

  it('stays quiet for a virtualized list reading once per visible row, which is bounded by the viewport', () => {
    const surface = makeSurface('item');
    renderRows(surface, 30);

    expect(fanoutWarnings()).toEqual([]);
  });

  it('warns when each row reads several times over, which scales past a viewport', () => {
    const surface = makeSurface('item');
    const Row = ({ id }: { id: string }): null => {
      surface.useValue({ region: 'us', id: `${id}:metric` });
      surface.useValue({ region: 'us', id: `${id}:proj` });
      surface.useValue({ region: 'us', id: `${id}:event` });
      return null;
    };
    const List = (): React.ReactElement =>
      React.createElement(
        React.Fragment,
        null,
        Array.from({ length: 25 }, (_value, index) => React.createElement(Row, { key: index, id: `p${index}` })),
      );
    act(() => {
      TestRenderer.create(React.createElement(List));
    });
    act(() => {
      jest.advanceTimersByTime(1);
    });

    expect(fanoutWarnings()).toHaveLength(1);
    expect(fanoutWarnings()[0]).toContain('75 separate reads');
  });

  it('warns once per store, so a scrolling list cannot spam the console', () => {
    const surface = makeSurface('item');
    renderRows(surface, 60);
    renderRows(surface, 60);

    expect(fanoutWarnings()).toHaveLength(1);
  });

  it('counts distinct args rather than calls, so many rows sharing one arg key are not fan-out', () => {
    const surface = makeSurface('item');
    const Row = (): null => {
      surface.useValue({ region: 'us', id: 'same' });
      return null;
    };
    const List = (): React.ReactElement =>
      React.createElement(
        React.Fragment,
        null,
        Array.from({ length: 60 }, (_value, index) => React.createElement(Row, { key: index })),
      );
    act(() => {
      TestRenderer.create(React.createElement(List));
    });
    act(() => {
      jest.advanceTimersByTime(1);
    });

    expect(fanoutWarnings()).toEqual([]);
  });

  it('falls back to a generic name when a store did not set one', () => {
    const surface = makeSurface();
    renderRows(surface, 60);

    expect(fanoutWarnings()[0]).toContain('[cellar_store]');
  });
});
