"use strict";

/**
 * Derivations over a Redux store and Cellar's stores together, for an app whose screens read both: a hook, and a
 * `connect`-shaped wrapper for a component that can't call one. Kept behind its own entry point, and handed the app's
 * `useStore`, so Cellar depends on neither Redux nor its React binding.
 */

import React from 'react';
import { shallowEqualValue } from "../caches.js";
import { useTrackedValue } from "../reactivity/tracked_value.js";
import { memoNamed } from "../read/with_read.js";

/** The parts of a Redux store a derivation needs: its state, and a way to hear that it changed. */

export function createReduxBridge(useStore) {
  function useTrackedStores(compute, isEqual = shallowEqualValue) {
    const store = useStore();
    const subscribeExtra = React.useCallback(notify => {
      let seen = store.getState();
      return store.subscribe(() => {
        const next = store.getState();
        if (next === seen) return;
        seen = next;
        notify();
      });
    }, [store]);
    return useTrackedValue(() => compute(store.getState()), [compute], {
      enabled: true,
      isEqual,
      empty: undefined,
      subscribeExtra
    });
  }
  function withTrackedStores(mapStateToProps, options) {
    const isEqual = options?.isEqual;
    return Component => {
      function WithTrackedStores(ownProps) {
        const resolvedRef = React.useRef(null);
        const derived = useTrackedStores(state => {
          if (resolvedRef.current) return resolvedRef.current(state, ownProps);
          const first = mapStateToProps(state, ownProps);
          if (typeof first === 'function') {
            resolvedRef.current = first;
            return resolvedRef.current(state, ownProps);
          }
          return first;
        }, isEqual);
        return /*#__PURE__*/React.createElement(Component, {
          ...ownProps,
          ...derived
        });
      }
      return memoNamed('withTrackedStores', Component, WithTrackedStores);
    };
  }
  return {
    useTrackedStores,
    withTrackedStores
  };
}
//# sourceMappingURL=index.js.map