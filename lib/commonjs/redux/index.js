"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.createReduxBridge = createReduxBridge;
var _react = _interopRequireDefault(require("react"));
var _caches = require("../caches.js");
var _tracked_value = require("../reactivity/tracked_value.js");
var _with_read = require("../read/with_read.js");
function _interopRequireDefault(e) { return e && e.__esModule ? e : { default: e }; }
/**
 * Derivations over a Redux store and Cellar's stores together, for an app whose screens read both: a hook, and a
 * `connect`-shaped wrapper for a component that can't call one. Kept behind its own entry point, and handed the app's
 * `useStore`, so Cellar depends on neither Redux nor its React binding.
 */

/** The parts of a Redux store a derivation needs: its state, and a way to hear that it changed. */

function createReduxBridge(useStore) {
  function useTrackedStores(compute, isEqual = _caches.shallowEqualValue) {
    const store = useStore();
    const subscribeExtra = _react.default.useCallback(notify => {
      let seen = store.getState();
      return store.subscribe(() => {
        const next = store.getState();
        if (next === seen) return;
        seen = next;
        notify();
      });
    }, [store]);
    return (0, _tracked_value.useTrackedValue)(() => compute(store.getState()), [compute], {
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
        const resolvedRef = _react.default.useRef(null);
        const derived = useTrackedStores(state => {
          if (resolvedRef.current) return resolvedRef.current(state, ownProps);
          const first = mapStateToProps(state, ownProps);
          if (typeof first === 'function') {
            resolvedRef.current = first;
            return resolvedRef.current(state, ownProps);
          }
          return first;
        }, isEqual);
        return /*#__PURE__*/_react.default.createElement(Component, {
          ...ownProps,
          ...derived
        });
      }
      return (0, _with_read.memoNamed)('withTrackedStores', Component, WithTrackedStores);
    };
  }
  return {
    useTrackedStores,
    withTrackedStores
  };
}
//# sourceMappingURL=index.js.map