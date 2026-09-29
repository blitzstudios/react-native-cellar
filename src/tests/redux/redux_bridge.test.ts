import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import { createReduxBridge, ReduxStoreLike } from '../../redux';
import { withRead } from '../../read/with_read';

/* global globalThis */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type State = { count: number; other: string };

function fakeStore(initial: State): ReduxStoreLike<State> & { set: (next: State) => void; dispatchNoop: () => void } {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set: (next) => {
      state = next;
      listeners.forEach((listener) => listener());
    },
    dispatchNoop: () => listeners.forEach((listener) => listener()),
  };
}

function mount(element: React.ReactElement): TestRenderer.ReactTestRenderer {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(element);
  });
  return renderer;
}

describe('createReduxBridge', () => {
  it('runs a derivation over the state it is handed, and again when a dispatch replaces the state', () => {
    const store = fakeStore({ count: 1, other: 'a' });
    const { useTrackedStores } = createReduxBridge(() => store);
    const seen: number[] = [];
    const Probe = () => {
      seen.push(useTrackedStores((state) => state.count));
      return null;
    };

    mount(React.createElement(Probe));
    act(() => store.set({ count: 2, other: 'a' }));

    expect(seen[seen.length - 1]).toBe(2);
  });

  it('runs nothing for a dispatch that leaves the state object as it was, the same as connect', () => {
    const store = fakeStore({ count: 1, other: 'a' });
    const { useTrackedStores } = createReduxBridge(() => store);
    const compute = jest.fn((state: State) => state.count);
    const Probe = () => {
      useTrackedStores(compute);
      return null;
    };

    mount(React.createElement(Probe));
    const runs = compute.mock.calls.length;
    act(() => store.dispatchNoop());

    expect(compute.mock.calls.length).toBe(runs);
  });

  it('uses the function a mapStateToProps factory returns as the selector from then on', () => {
    const store = fakeStore({ count: 3, other: 'a' });
    const { withTrackedStores } = createReduxBridge(() => store);
    const factory = jest.fn(() => (state: State, own: { add: number }) => ({ total: state.count + own.add }));
    const rendered: number[] = [];
    const Inner = (props: { add: number; total: number }) => {
      rendered.push(props.total);
      return null;
    };
    const Wrapped = withTrackedStores<{ add: number }, { total: number }>(factory)(Inner);

    mount(React.createElement(Wrapped, { add: 1 }));
    act(() => store.set({ count: 5, other: 'a' }));

    expect(factory).toHaveBeenCalledTimes(1);
    expect(rendered[rendered.length - 1]).toBe(6);
    expect(Wrapped.displayName).toBe('withTrackedStores(Inner)');
  });
});

describe('withRead', () => {
  it('hands the read’s value to the component as the named prop, read with params from its props', () => {
    const useRead = jest.fn(({ params }: { params: { id: string } }) => ({ data: `player ${params.id}` }));
    const rendered: (string | undefined)[] = [];
    const Inner = (props: { playerId: string; player?: string }) => {
      rendered.push(props.player);
      return null;
    };
    const Wrapped = withRead(useRead, { prop: 'player', useParams: (props: { playerId: string }) => ({ id: props.playerId }) })(Inner);

    mount(React.createElement(Wrapped, { playerId: '4046' }));

    expect(rendered).toEqual(['player 4046']);
    expect(useRead).toHaveBeenCalledWith({ params: { id: '4046' } });
    expect(Wrapped.displayName).toBe('withPlayer(Inner)');
  });
});
