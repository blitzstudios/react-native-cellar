import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import { PRIME_IDLE } from '../../prime_state';
import { createReadSurface } from '../../read/surface';
import { createVersionAtom } from '../../reactivity/version_atom';
import { useTrackedValue } from '../../reactivity/tracked_value';
import { createVersionedCache } from '../../caches';
import { describeDev } from '../../testing/dev_mode';
import { renderPhaseOwnerStack } from '../../reactivity/render_phase';
import { resetOnceGuards } from '../../diagnostics/once_guard';
import { runSubscribed, runTracked } from '../../reactivity/tracking';

/* global globalThis */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const US = ['us'];

let warn: jest.SpyInstance;

beforeEach(() => {
  resetOnceGuards();
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
});

function renderOnce(body: () => void): void {
  const Component = (): null => {
    body();
    return null;
  };
  act(() => {
    TestRenderer.create(React.createElement(Component));
  });
}

function guardWarnings(): string[] {
  return warn.mock.calls.map((args) => String(args[0])).filter((message) => message.startsWith('[off-heap]'));
}

describe('renderPhaseOwnerStack', () => {
  it('is null outside React, non-null during render, and names the component', () => {
    expect(renderPhaseOwnerStack()).toBeNull();

    let duringRender: string | null = 'unset';
    function NamedProbe(): null {
      duringRender = renderPhaseOwnerStack();
      return null;
    }
    act(() => {
      TestRenderer.create(React.createElement(NamedProbe));
    });

    expect(duringRender).not.toBeNull();
    expect(duringRender).toContain('NamedProbe');
  });

  it('is null in an effect and in an event handler, so a one-shot read there stays quiet', () => {
    let duringEffect: string | null = 'unset';
    let duringHandler: string | null = 'unset';
    function EffectProbe(): null {
      React.useEffect(() => {
        duringEffect = renderPhaseOwnerStack();
      }, []);
      React.useEffect(() => {
        setTimeout(() => {
          duringHandler = renderPhaseOwnerStack();
        }, 0);
      }, []);
      return null;
    }
    jest.useFakeTimers();
    act(() => {
      TestRenderer.create(React.createElement(EffectProbe));
    });
    act(() => {
      jest.runAllTimers();
    });
    jest.useRealTimers();

    expect(duringEffect).toBeNull();
    expect(duringHandler).toBeNull();
  });
});

describeDev('the unsubscribed-read guard', () => {
  it('warns once, naming the partition and the component, when a render read has no subscription', () => {
    const atom = createVersionAtom('guard_bare');
    function StaleReader(): null {
      atom.get(US);
      return null;
    }
    act(() => {
      TestRenderer.create(React.createElement(StaleReader));
    });

    const warnings = guardWarnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('guard_bare:us');
    expect(warnings[0]).toContain('StaleReader');
    expect(warnings[0]).toContain('useTrackedStores');
  });

  it('catches the read through a versioned getter, which is how consumers actually reach a store', () => {
    const atom = createVersionAtom('guard_getter');
    const cache = createVersionedCache<{ itemId: string }>(16);
    const getItem = (itemId: string) => cache.read(itemId, atom.get(US), () => ({ itemId }));
    renderOnce(() => {
      getItem('us_1234');
    });

    expect(guardWarnings()).toHaveLength(1);
  });

  it('stays quiet for the same read inside a tracking scope, since useTrackedStores subscribes what it collects', () => {
    const atom = createVersionAtom('guard_tracked');
    renderOnce(() => {
      runTracked(() => atom.get(US));
    });

    expect(guardWarnings()).toEqual([]);
  });

  it('stays quiet inside runSubscribed, the marker for a read the caller subscribed by hand', () => {
    const atom = createVersionAtom('guard_marked');
    renderOnce(() => {
      runSubscribed(() => atom.get(US));
    });

    expect(guardWarnings()).toEqual([]);
  });

  it('stays quiet for a reactive read, which useTrackedValue subscribes to whatever it read', () => {
    const atom = createVersionAtom('guard_reactive');
    function ReactiveReader(): null {
      useTrackedValue<number>(() => atom.get(US), ['us'], { enabled: true, isEqual: Object.is, empty: 0 });
      return null;
    }
    act(() => {
      TestRenderer.create(React.createElement(ReactiveReader));
    });

    expect(guardWarnings()).toEqual([]);
  });

  it('stays quiet for a real read surface `useValue`, whose presence probe reads the version it just subscribed', () => {
    const atom = createVersionAtom('guard_read_surface');
    const surface = createReadSurface<string>({
      version: atom,
      toParts: (region) => [region],
      has: () => true,
      ingest: { usePrime: () => PRIME_IDLE, usePrimeMany: () => PRIME_IDLE, ensure: () => {}, refetch: () => {} },
    });
    const ItemRow = surface.read<{ region: string }, number>({
      partition: (args) => args.region,
      select: () => 1,
      empty: 0,
    });
    function SurfaceReader(): null {
      ItemRow.useValue({ region: 'us' });
      return null;
    }
    act(() => {
      TestRenderer.create(React.createElement(SurfaceReader));
    });

    expect(guardWarnings()).toEqual([]);
  });

  it('still reports an imperative `getValue` called during render, which nothing subscribed', () => {
    const atom = createVersionAtom('guard_read_surface_get');
    const surface = createReadSurface<string>({
      version: atom,
      toParts: (region) => [region],
      has: () => true,
      ingest: { usePrime: () => PRIME_IDLE, usePrimeMany: () => PRIME_IDLE, ensure: () => {}, refetch: () => {} },
    });
    const ItemRow = surface.read<{ region: string }, number>({
      partition: (args) => args.region,
      select: () => 1,
      empty: 0,
    });
    function GetReader(): null {
      ItemRow.getValue({ region: 'us' });
      return null;
    }
    act(() => {
      TestRenderer.create(React.createElement(GetReader));
    });

    expect(guardWarnings()).toHaveLength(1);
    expect(guardWarnings()[0]).toContain('GetReader');
  });

  it('stays quiet outside render — a callback, thunk or socket handler reads imperatively on purpose', () => {
    const atom = createVersionAtom('guard_callback');
    atom.get(US);

    expect(guardWarnings()).toEqual([]);
  });

  it('reports a call site once, so a component that re-renders every frame does not flood the console', () => {
    const atom = createVersionAtom('guard_repeat');
    function StaleReader(_props: { tick: number }): null {
      atom.get(US);
      return null;
    }
    let renderer: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(React.createElement(StaleReader, { tick: 0 }));
    });
    act(() => {
      renderer.update(React.createElement(StaleReader, { tick: 1 }));
    });
    act(() => {
      renderer.update(React.createElement(StaleReader, { tick: 2 }));
    });

    expect(guardWarnings()).toHaveLength(1);
  });

  it('still reports a second component reading the same partition, so one known site cannot mask another', () => {
    const atom = createVersionAtom('guard_two_sites');
    function FirstReader(): null {
      atom.get(US);
      return null;
    }
    function SecondReader(): null {
      atom.get(US);
      return null;
    }
    act(() => {
      TestRenderer.create(React.createElement(FirstReader));
    });
    act(() => {
      TestRenderer.create(React.createElement(SecondReader));
    });

    const warnings = guardWarnings();
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('FirstReader');
    expect(warnings[1]).toContain('SecondReader');
  });
});
