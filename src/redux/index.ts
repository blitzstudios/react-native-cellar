/**
 * Derivations over a Redux store and Cellar's stores together, for an app whose screens read both: a hook, and a
 * `connect`-shaped wrapper for a component that can't call one. Kept behind its own entry point, and handed the app's
 * `useStore`, so Cellar depends on neither Redux nor its React binding.
 */

import React from 'react';

import { shallowEqualValue } from '../caches';
import { useTrackedValue } from '../reactivity/tracked_value';
import { memoNamed } from '../read/with_read';

/** The parts of a Redux store a derivation needs: its state, and a way to hear that it changed. */
export interface ReduxStoreLike<State> {
  getState(): State;
  subscribe(listener: () => void): () => void;
}

export type MapStateToProps<State, OwnProps, Derived> = (state: State, ownProps: OwnProps) => Derived;
export type MapStateToPropsFactory<State, OwnProps, Derived> = (state: State, ownProps: OwnProps) => MapStateToProps<State, OwnProps, Derived>;

export interface WithTrackedStoresOptions<Derived> {
  /** Compares a derivation's previous result with a new one; an equal result keeps the previous props. */
  isEqual?: (left: Derived, right: Derived) => boolean;
}

export interface ReduxBridge<State> {
  /**
   * Runs `compute` over the Redux state and whatever store entities or partitions it reads, and runs it again when
   * either changes. What it read is found by running it, so the subscriptions follow it when it reads something else.
   * A dispatch that leaves the state object as it was runs nothing, the same as `connect`.
   *
   * `compute` closes over the caller's props, so it also runs on every render, which is what a `connect` selector
   * does; an equal result keeps the previous reference.
   */
  useTrackedStores<T>(compute: (state: State) => T, isEqual?: (left: T, right: T) => boolean): T;
  /**
   * `connect(mapStateToProps)` for a derivation that reads stores as well as Redux. A factory that returns a function
   * on its first call is used the way `connect` uses one: the function it returns is the selector from then on.
   */
  withTrackedStores<OwnProps extends object, Derived extends object>(
    mapStateToProps: MapStateToProps<State, OwnProps, Derived> | MapStateToPropsFactory<State, OwnProps, Derived>,
    options?: WithTrackedStoresOptions<Derived>,
  ): (Component: React.ComponentType<OwnProps & Derived>) => React.MemoExoticComponent<React.FC<OwnProps>>;
}

export function createReduxBridge<State>(useStore: () => ReduxStoreLike<State>): ReduxBridge<State> {
  function useTrackedStores<T>(compute: (state: State) => T, isEqual: (left: T, right: T) => boolean = shallowEqualValue): T {
    const store = useStore();
    const subscribeExtra = React.useCallback(
      (notify: () => void) => {
        let seen = store.getState();
        return store.subscribe(() => {
          const next = store.getState();
          if (next === seen) return;
          seen = next;
          notify();
        });
      },
      [store],
    );
    return useTrackedValue(() => compute(store.getState()), [compute], { enabled: true, isEqual, empty: undefined as T, subscribeExtra });
  }

  function withTrackedStores<OwnProps extends object, Derived extends object>(
    mapStateToProps: MapStateToProps<State, OwnProps, Derived> | MapStateToPropsFactory<State, OwnProps, Derived>,
    options?: WithTrackedStoresOptions<Derived>,
  ): (Component: React.ComponentType<OwnProps & Derived>) => React.MemoExoticComponent<React.FC<OwnProps>> {
    const isEqual = options?.isEqual;
    return (Component) => {
      function WithTrackedStores(ownProps: OwnProps) {
        const resolvedRef = React.useRef<MapStateToProps<State, OwnProps, Derived> | null>(null);
        const derived = useTrackedStores((state) => {
          if (resolvedRef.current) return resolvedRef.current(state, ownProps);
          const first = mapStateToProps(state, ownProps);
          if (typeof first === 'function') {
            resolvedRef.current = first as MapStateToProps<State, OwnProps, Derived>;
            return resolvedRef.current(state, ownProps);
          }
          return first as Derived;
        }, isEqual);
        return React.createElement(Component, { ...ownProps, ...derived });
      }
      return memoNamed('withTrackedStores', Component, WithTrackedStores);
    };
  }

  return { useTrackedStores, withTrackedStores };
}
