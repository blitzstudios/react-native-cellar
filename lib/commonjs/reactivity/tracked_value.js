"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.useTrackedValue = useTrackedValue;
var _react = require("react");
var _withSelector = require("use-sync-external-store/shim/with-selector");
var _runtime = require("../runtime.js");
var _tracking = require("./tracking.js");
/**
 * {@linkcode useTrackedValue}, the hook behind every {@linkcode Read.useValue | useValue} read: it runs a computation,
 * subscribes to exactly the store data it read, and runs it again when that data changes.
 *
 * Dependencies are found by running the computation, not declared: every partition version, entity version and presence
 * it reads is subscribed to. A read of three players subscribes to those three, so a write to a fourth doesn't re-run
 * it. When the computation reads something different the next time, the subscriptions change to match.
 */

/** Options for {@linkcode useTrackedValue}. */

const NOOP = () => {};
const NO_DEPS = Object.freeze([]);
const NO_VERSIONS = Object.freeze([]);
const createInstance = () => ({
  epoch: 0,
  notify: NOOP,
  subscribed: new Map(),
  last: null,
  live: true
});
const sameDeps = (left, right) => left.length === right.length && left.every((dep, index) => dep.id === right[index].id);
const moved = tracked => tracked.deps.some((dep, index) => dep.getVersion() !== tracked.versions[index]);
function unsubscribeAll(inst) {
  for (const unsub of inst.subscribed.values()) unsub();
  inst.subscribed.clear();
}

/** Brings the subscriptions in line with what the last derivation read, dropping what it no longer reads. */
function subscribeTo(inst, deps) {
  const next = new Map(deps.map(dep => [dep.id, dep]));
  for (const [id, unsub] of inst.subscribed) {
    if (!next.has(id)) {
      unsub();
      inst.subscribed.delete(id);
    }
  }
  for (const [id, dep] of next) if (!inst.subscribed.has(id)) inst.subscribed.set(id, dep.subscribe(() => inst.notify()));
}

/**
 * A hook that runs `compute` as a tracking scope (recording every store version number it reads), subscribes to what it
 * read, and returns its value. When any of that data changes, it runs `compute` again, and re-renders the component
 * only if the new value isn't equal (by {@linkcode TrackedValueOptions.isEqual | isEqual}) to the previous one.
 * `inputs` are the values `compute` closes over, such as the read's args, as a React dependency list; a change in them
 * also re-runs it.
 *
 * It follows the app's read gate: while the component's gate isn't live (its screen is hidden, say), it unsubscribes
 * and keeps returning its last value, so a hidden screen doesn't re-render. When the gate is live again, it re-runs and
 * re-renders once, if anything changed meanwhile. {@linkcode TrackedValueOptions.bypassGate | bypassGate} opts out.
 */
function useTrackedValue(compute, inputs, options) {
  const {
    enabled,
    isEqual,
    empty,
    subscribeExtra,
    bypassGate
  } = options;
  const gate = (0, _runtime.useReadGateFor)(bypassGate);
  const [inst] = (0, _react.useState)(createInstance);
  const subscribe = (0, _react.useCallback)(onChange => {
    inst.notify = () => {
      inst.epoch += 1;
      onChange();
    };
    const offExtra = subscribeExtra?.(inst.notify);
    const syncGate = () => {
      const live = gate.isLive();
      if (live === inst.live) return;
      inst.live = live;
      if (!live) {
        // Held at what the last derivation saw, so a write landing now cannot move what the screen shows.
        unsubscribeAll(inst);
        return;
      }
      if (inst.last) {
        subscribeTo(inst, inst.last.deps);
        if (moved(inst.last)) inst.notify();
      }
    };
    inst.live = gate.isLive();
    const offGate = gate.onChange(syncGate);
    return () => {
      offExtra?.();
      offGate();
      inst.notify = NOOP;
    };
  }, [inst, gate, subscribeExtra]);
  const getSnapshot = (0, _react.useCallback)(() => inst.epoch, [inst]);
  const selector = (0, _react.useCallback)(() => {
    if (!enabled) return {
      value: empty,
      deps: NO_DEPS,
      versions: NO_VERSIONS
    };
    const {
      value,
      deps
    } = (0, _tracking.runTracked)(compute);
    return {
      value,
      deps,
      versions: deps.map(dep => dep.getVersion())
    };
  },
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `inputs` is what `compute` closes over; `empty` is stable per call site
  [enabled, ...inputs]);

  // Comparing values alone would bail the render and leave the hook subscribed to what `compute` stopped reading.
  const selectionEqual = (0, _react.useCallback)((left, right) => sameDeps(left.deps, right.deps) && isEqual(left.value, right.value), [isEqual]);
  const tracked = (0, _withSelector.useSyncExternalStoreWithSelector)(subscribe, getSnapshot, getSnapshot, selector, selectionEqual);
  (0, _react.useEffect)(() => {
    inst.last = tracked;
    if (!inst.live) return;
    subscribeTo(inst, tracked.deps);
    // Catches a write that landed between the derivation running and this effect subscribing to what it read.
    if (moved(tracked)) inst.notify();
  });
  (0, _react.useEffect)(() => () => unsubscribeAll(inst), [inst]);
  return tracked.value;
}

// Exported so the built declaration files keep these names in scope for the doc links above; an import that only a
// doc comment uses is dropped from them.
//# sourceMappingURL=tracked_value.js.map