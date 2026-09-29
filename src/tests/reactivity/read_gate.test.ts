import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import { createVersionAtom } from '../../reactivity/version_atom';
import { useTrackedValue } from '../../reactivity/tracked_value';
import { configureCellar, INERT_GATE, ReadGate } from '../../runtime';

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

/** A host gate policy under test control. One stable gate, as the runtime contract requires. */
function controllableGate() {
  let live = true;
  const listeners = new Set<() => void>();
  const gate: ReadGate = {
    isLive: () => live,
    onChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    install: () => configureCellar({ gate: { useReadGate: () => gate } }),
    set: (next: boolean) =>
      act(() => {
        live = next;
        listeners.forEach((listener) => listener());
      }),
    /** How many reads are watching the gate — a mounted read registers exactly one. */
    watchers: () => listeners.size,
  };
}

const US = ['us', '2024', 'regular', '5'];

afterEach(() => configureCellar({ gate: INERT_GATE }));

describe('the read gate on a subscription', () => {
  /** A read whose value moves with the partition version, counting how often the expensive part runs. */
  function scenario() {
    const atom = createVersionAtom('test_store_version');
    const state = { value: 'first' };
    const computes = { count: 0 };
    const compute = () => {
      computes.count += 1;
      atom.get(US);
      return state.value;
    };
    const write = (next: string) =>
      act(() => {
        state.value = next;
        atom.bump(US);
      });
    return { atom, computes, write, read: () => useTrackedValue(compute, ['k'], { enabled: true, isEqual: Object.is, empty: 'empty' }) };
  }

  it('holds the value a gated read already had, and does not recompute it', () => {
    const gate = controllableGate();
    gate.install();
    const { computes, write, read } = scenario();

    const probe = renderHook(read);
    expect(probe.current).toBe('first');

    write('second');
    expect(probe.current).toBe('second');
    const rendersWhileLive = probe.renders;
    const computesWhileLive = computes.count;

    gate.set(false);
    write('third');

    // The write landed in the store; what the gated read shows is deliberately behind it.
    expect(probe.current).toBe('second');
    expect(probe.renders).toBe(rendersWhileLive);
    expect(computes.count).toBe(computesWhileLive);
  });

  it('catches up in a single render when the gate goes live', () => {
    const gate = controllableGate();
    gate.install();
    const { write, read } = scenario();

    const probe = renderHook(read);
    gate.set(false);
    write('third');
    const rendersWhileGated = probe.renders;

    gate.set(true);

    expect(probe.current).toBe('third');
    expect(probe.renders).toBe(rendersWhileGated + 1);
  });

  it('spends no render coming back to a partition nothing wrote while it was gated', () => {
    const gate = controllableGate();
    gate.install();
    const { read } = scenario();

    const probe = renderHook(read);
    gate.set(false);
    const rendersWhileGated = probe.renders;

    gate.set(true);

    expect(probe.renders).toBe(rendersWhileGated);
  });

  it('shows what is current when it mounts gated, then holds from there', () => {
    const gate = controllableGate();
    gate.install();
    const { write, read } = scenario();
    gate.set(false);

    // Written before this read ever mounts, so there is no earlier value to hold.
    write('second');
    const probe = renderHook(read);
    expect(probe.current).toBe('second');
    const rendersAtMount = probe.renders;

    write('third');

    expect(probe.current).toBe('second');
    expect(probe.renders).toBe(rendersAtMount);
  });

  it('stops watching the gate once the read unmounts', () => {
    const gate = controllableGate();
    gate.install();
    const { read } = scenario();

    const probe = renderHook(read);
    expect(gate.watchers()).toBe(1);

    probe.unmount();

    expect(gate.watchers()).toBe(0);
  });

  it('gates useVersion the same way, so a gated reader of the raw counter also holds', () => {
    const gate = controllableGate();
    gate.install();
    const atom = createVersionAtom('test_store_version');

    const probe = renderHook(() => atom.useVersion(US));
    act(() => {
      atom.bump(US);
    });
    expect(probe.current).toBe(1);

    gate.set(false);
    act(() => {
      atom.bump(US);
    });
    expect(probe.current).toBe(1);

    gate.set(true);
    expect(probe.current).toBe(2);
  });

  it('keeps a read that bypasses the gate live while the gate is closed', () => {
    const gate = controllableGate();
    gate.install();
    const atom = createVersionAtom('test_store_version');
    const state = { value: 'first' };
    const compute = () => {
      atom.get(US);
      return state.value;
    };
    const bypassing = renderHook(() => useTrackedValue(compute, ['k'], { enabled: true, isEqual: Object.is, empty: 'empty', bypassGate: true }));
    const gated = renderHook(() => useTrackedValue(compute, ['k'], { enabled: true, isEqual: Object.is, empty: 'empty' }));

    gate.set(false);
    act(() => {
      state.value = 'second';
      atom.bump(US);
    });

    expect(bypassing.current).toBe('second');
    expect(gated.current).toBe('first');
  });

  it('keeps useVersion live for a caller that bypasses the gate', () => {
    const gate = controllableGate();
    gate.install();
    const atom = createVersionAtom('test_store_version');

    const probe = renderHook(() => atom.useVersion(US, true, true));
    gate.set(false);
    act(() => {
      atom.bump(US);
    });

    expect(probe.current).toBe(1);
  });

  it('keeps every read live when the host configures no gate', () => {
    // INERT_GATE is the default, so this is the behaviour of a host that never opted in — and of every other test in
    // this package that does not install one.
    const { write, read } = scenario();

    const probe = renderHook(read);
    write('second');

    expect(probe.current).toBe('second');
  });
});
