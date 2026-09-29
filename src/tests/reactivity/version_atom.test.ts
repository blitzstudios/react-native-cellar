import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import { createVersionAtom } from '../../reactivity/version_atom';
import { runTracked } from '../../reactivity/tracking';
import { useTrackedValue } from '../../reactivity/tracked_value';
import { NO_CHANGES } from '../../table/change_set';

/* global globalThis */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Probe<T> = { current: T; renders: number; unmount: () => void };

function renderHook<T>(useHook: () => T): Probe<T> {
  const probe: Probe<T> = { current: undefined as unknown as T, renders: 0, unmount: () => {} };
  const Component = () => {
    probe.current = useHook();
    probe.renders += 1;
    return null;
  };
  let renderer: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(React.createElement(Component));
  });
  probe.unmount = () =>
    act(() => {
      renderer.unmount();
    });
  return probe;
}

const US = ['us', '2024', 'regular', '5'];
const EU = ['eu', '2025', 'regular', 'g_1815'];

describe('createVersionAtom — imperative surface', () => {
  it('reads 0 until written, then reflects bumps', () => {
    const atom = createVersionAtom('test_store_version');
    expect(atom.get(US)).toBe(0);
    expect(atom.bump(US)).toBe(1);
    expect(atom.bump(US)).toBe(2);
    expect(atom.get(US)).toBe(2);
    expect(atom.get(EU)).toBe(0);
  });

  it('namespaces key by root', () => {
    const atom = createVersionAtom('test_store_version');
    expect(atom.key(['a', 'b'])).toEqual(['test_store_version', 'a\u0000b']);
  });

  it('keeps part lists distinct when a part contains the separator character used elsewhere', () => {
    const atom = createVersionAtom('test_store_version');
    atom.bump(['region:us-west', 'x']);
    expect(atom.get(['region', 'epl:x'])).toBe(0);
    expect(atom.get(['region:us-west', 'x'])).toBe(1);
  });

  it('retains a written version across unsubscribe, so a cached value stamped with it cannot read as current', () => {
    const atom = createVersionAtom('test_store_version');
    const unsub = atom.subscribe(US, () => {});
    atom.bump(US);
    expect(atom.get(US)).toBe(1);

    unsub();
    expect(atom.get(US)).toBe(1);
    expect(atom.bump(US)).toBe(2);
  });

  it('subscribe fires on a bump to its partition and stops after unsubscribe', () => {
    const atom = createVersionAtom('test_store_version');
    const listener = jest.fn();
    const unsub = atom.subscribe(US, listener);

    atom.bump(US);
    expect(listener).toHaveBeenCalledTimes(1);
    atom.bump(EU);
    expect(listener).toHaveBeenCalledTimes(1);

    unsub();
    atom.bump(US);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('records a dependency via runTracked when get() runs inside a tracking scope', () => {
    const atom = createVersionAtom('test_store_version');
    const { deps } = runTracked(() => atom.get(US));
    expect(deps).toHaveLength(1);
    const listener = jest.fn();
    deps[0].subscribe(listener);
    atom.bump(US);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('reports one descriptor per partition instead of building a fresh one on every read', () => {
    const atom = createVersionAtom('test_store_version');
    const first = runTracked(() => atom.get(US)).deps[0];

    expect(runTracked(() => atom.get(US)).deps[0]).toBe(first);
    expect(runTracked(() => atom.get(EU)).deps[0]).not.toBe(first);
  });

  it('keeps a held descriptor live, so the version read through it follows later bumps', () => {
    const atom = createVersionAtom('test_store_version');
    const dep = runTracked(() => atom.get(US)).deps[0];
    expect(dep.getVersion()).toBe(0);

    atom.bump(US);
    expect(dep.getVersion()).toBe(1);
  });

  it('keeps a descriptor handed out earlier working after its entry was dropped', () => {
    const atom = createVersionAtom('test_store_version');
    const dep = runTracked(() => atom.get(US)).deps[0];
    // Subscribing and leaving with nothing written drops the entry, and the descriptor along with it.
    atom.subscribe(US, () => {})();
    expect(runTracked(() => atom.get(US)).deps[0]).not.toBe(dep);

    // The one already handed out resolves its partition on each call, so it is still wired to it.
    const listener = jest.fn();
    const unsub = dep.subscribe(listener);
    atom.bump(US);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(dep.getVersion()).toBe(1);
    unsub();
  });
});

describe('createVersionAtom — reactive hooks', () => {

});

describe('createVersionAtom — entities', () => {
  /** A written partition: its first write counts every entity changed, which is not what these cases are about. */
  const written = () => {
    const atom = createVersionAtom('test_store_version');
    atom.bump(US);
    return atom;
  };
  const listenTo = (atom: ReturnType<typeof createVersionAtom>, read: () => unknown) => {
    const listener = jest.fn();
    for (const dep of runTracked(read).deps) dep.subscribe(listener);
    return listener;
  };

  it('moves an entity version only when a write changed that entity', () => {
    const atom = written();
    const before = atom.getEntity(US, 'p1');
    atom.bump(US, new Set(['p2']));
    expect(atom.getEntity(US, 'p1')).toBe(before);
    atom.bump(US, new Set(['p1']));
    expect(atom.getEntity(US, 'p1')).toBe(atom.get(US));
  });

  it('wakes an entity reader for its entity and no other, and a partition reader for every write', () => {
    const atom = written();
    const entityReader = listenTo(atom, () => atom.getEntity(US, 'p1'));
    const partitionReader = listenTo(atom, () => atom.get(US));

    atom.bump(US, new Set(['p2']));
    expect(entityReader).not.toHaveBeenCalled();
    expect(partitionReader).toHaveBeenCalledTimes(1);

    atom.bump(US, new Set(['p1', 'p3']));
    expect(entityReader).toHaveBeenCalledTimes(1);
    expect(partitionReader).toHaveBeenCalledTimes(2);
  });

  it('wakes a listener on several changed entities once per write', () => {
    const atom = written();
    const listener = listenTo(atom, () => [atom.getEntity(US, 'p1'), atom.getEntity(US, 'p2')]);

    atom.bump(US, new Set(['p1', 'p2']));

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('wakes every entity reader for a write that could not say which entities it changed', () => {
    const atom = written();
    const entityReader = listenTo(atom, () => atom.getEntity(US, 'p1'));

    atom.bump(US);

    expect(entityReader).toHaveBeenCalledTimes(1);
    expect(atom.getEntity(US, 'p1')).toBe(atom.get(US));
  });

  it('counts a partition first write as every entity changed, since nothing was held before it', () => {
    const atom = createVersionAtom('test_store_version');
    const entityReader = listenTo(atom, () => atom.getEntity(US, 'p1'));

    atom.bump(US, new Set(['p2']));

    expect(entityReader).toHaveBeenCalledTimes(1);
  });

  it('does nothing for a write that changed nothing', () => {
    const atom = written();
    const partitionReader = listenTo(atom, () => atom.get(US));
    const version = atom.get(US);

    expect(atom.bump(US, NO_CHANGES)).toBe(version);
    expect(partitionReader).not.toHaveBeenCalled();
  });

  it('moves presence on a first write and on a write of every entity, and not for a write of named entities', () => {
    const atom = createVersionAtom('test_store_version');
    const presence = listenTo(atom, () => atom.getPresence(US));

    atom.bump(US, new Set(['p1']));
    expect(presence).toHaveBeenCalledTimes(1);
    atom.bump(US, new Set(['p1']));
    expect(presence).toHaveBeenCalledTimes(1);
    atom.bump(US);
    expect(presence).toHaveBeenCalledTimes(2);
  });

  it('keeps entity, presence and partition descriptors apart, so tracking one never stands in for another', () => {
    const atom = written();
    const ids = [
      runTracked(() => atom.get(US)).deps[0].id,
      runTracked(() => atom.getEntity(US, 'p1')).deps[0].id,
      runTracked(() => atom.getPresence(US)).deps[0].id,
    ];
    expect(new Set(ids).size).toBe(3);
  });

  it('forgets which entities changed past its bound by counting every entity changed, which wakes rather than strands', () => {
    const atom = written();
    const entityReader = listenTo(atom, () => atom.getEntity(US, 'untouched'));

    atom.bump(US, new Set(Array.from({ length: 9000 }, (_, index) => `p${index}`)));

    expect(entityReader).toHaveBeenCalledTimes(1);
  });
});

describe('useTrackedValue', () => {
  it('re-renders only when an entity it read changes, and not for a write to another entity', () => {
    const atom = createVersionAtom('test_store_version');
    atom.bump(US);
    const scores = new Map([
      ['me', 10],
      ['other', 1],
    ]);
    const readMine = () => {
      atom.getEntity(US, 'me');
      return scores.get('me');
    };

    const probe = renderHook(() => useTrackedValue(readMine, [], { enabled: true, isEqual: Object.is, empty: undefined }));
    expect(probe.current).toBe(10);
    const rendersAfterMount = probe.renders;

    act(() => {
      scores.set('other', 99);
      atom.bump(US, new Set(['other']));
    });
    expect(probe.renders).toBe(rendersAfterMount);

    act(() => {
      scores.set('me', 20);
      atom.bump(US, new Set(['me']));
    });
    expect(probe.current).toBe(20);
    expect(probe.renders).toBe(rendersAfterMount + 1);

    probe.unmount();
  });

  it('bails the render when a recompute returns an equal value', () => {
    const atom = createVersionAtom('test_store_version');
    const entryA = { id: 'a' };
    const read = () => {
      atom.get(US);
      return { a: entryA };
    };
    const shallow = (left: Record<string, unknown>, right: Record<string, unknown>) => Object.keys(left).every((key) => Object.is(left[key], right[key]));

    const probe = renderHook(() => useTrackedValue(read, [], { enabled: true, isEqual: shallow, empty: {} }));
    const rendersAfterMount = probe.renders;

    act(() => {
      atom.bump(US);
    });
    expect(probe.renders).toBe(rendersAfterMount);

    probe.unmount();
  });

  it('follows what it reads: an entity it stops reading no longer wakes it', () => {
    const atom = createVersionAtom('test_store_version');
    atom.bump(US);
    let entityId = 'p1';
    const read = () => atom.getEntity(US, entityId);
    let rerender = () => {};
    const probe = renderHook(() => {
      const [, setTick] = React.useState(0);
      rerender = () => setTick((tick) => tick + 1);
      return useTrackedValue(read, [entityId], { enabled: true, isEqual: Object.is, empty: 0 });
    });

    act(() => {
      entityId = 'p2';
      rerender();
    });
    const rendersAfterSwitch = probe.renders;
    act(() => {
      atom.bump(US, new Set(['p1']));
    });
    expect(probe.renders).toBe(rendersAfterSwitch);
    act(() => {
      atom.bump(US, new Set(['p2']));
    });
    expect(probe.renders).toBe(rendersAfterSwitch + 1);

    probe.unmount();
  });

  it('returns `empty` and subscribes to nothing while disabled', () => {
    const atom = createVersionAtom('test_store_version');
    const read = jest.fn(() => atom.get(US));

    const probe = renderHook(() => useTrackedValue(read, [], { enabled: false, isEqual: Object.is, empty: -1 }));
    act(() => {
      atom.bump(US);
    });

    expect(probe.current).toBe(-1);
    expect(read).not.toHaveBeenCalled();
    probe.unmount();
  });
});
