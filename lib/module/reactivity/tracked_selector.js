"use strict";

/**
 * {@linkcode createTrackedSelector}, a replacement for Reselect's `createSelector` for a Redux selector that reads
 * store data, usually by calling a service getter in its `resultFn`. Reselect caches on its inputs only, so such a
 * selector would keep returning its old result after a store write. This one also records every store version
 * `resultFn` read, and recomputes when one of those changes.
 */

import { isTracking, runTracked, trackDependency } from "./tracking.js";

/**
 * One entry in a tracked selector's `inputs`: a function called with the selector's own arguments (such as Redux state
 * and props), whose return value is passed to `resultFn`. The selector recomputes when any input's value changes.
 */

/** Compares an input's previous and new value; when every input is equal, the selector can return its cached result. */

/** Options for {@linkcode createTrackedSelector}. */

const DEFAULT_CACHE_MAX = 8;

/**
 * Creates a selector, like Reselect's `createSelector`, that calls `resultFn` with the values of `inputs` and caches
 * the result per set of arguments. The cached result is reused until an input's value changes or a store version
 * `resultFn` read changes (a partition or entity it looked at was written).
 *
 * Each call also reports the store data `resultFn` read to the enclosing tracking scope, so a component calling it
 * inside `useTrackedStores` or a {@linkcode Read.useValue | useValue} computation re-renders when that data changes.
 * Called outside any tracking scope, its results are still correct, but nothing re-renders on a write; dev logs a
 * warning.
 */

export function createTrackedSelector(inputs, resultFn, options) {
  const inputEqual = options?.inputEqual ?? Object.is;
  const cacheMax = options?.cacheMax ?? DEFAULT_CACHE_MAX;

  // Emits into the scope *outside* this selector — its own nested scope is already popped by now.
  const forwardDeps = deps => {
    for (const dep of deps) trackDependency(dep);
  };
  let warnedOutsideScope = false;
  const warnIfOrphanedDeps = deps => {
    if (!__DEV__ || warnedOutsideScope || deps.length === 0 || isTracking()) return;
    warnedOutsideScope = true;
    const label = options?.debugLabel ?? `[${deps.map(dep => dep.id).join(', ')}]`;
    // eslint-disable-next-line no-console
    console.warn(`[tracked-selector] ${label} read store partitions but ran outside a tracking scope, so its consumer ` + `won't repaint when they change. Wrap the consuming component in withTrackedStores/useTrackedStores ` + `(or read via a *.useValue hook). Safe to ignore for one-shot imperative reads.`);
  };
  const sameInputs = (left, right) => left.length === right.length && left.every((value, index) => inputEqual(value, right[index]));
  const depsUnchanged = entry => entry.deps.every((dep, index) => dep.getVersion() === entry.depVersions[index]);

  // Most-recently-used first, so the common alternating-args case settles at the head.
  const cache = [];
  return (...args) => {
    const inputValues = inputs.map(select => select(...args));
    const hit = cache.findIndex(entry => sameInputs(entry.inputValues, inputValues));
    if (hit !== -1) {
      const entry = cache[hit];
      if (depsUnchanged(entry)) {
        if (hit > 0) {
          cache.splice(hit, 1);
          cache.unshift(entry);
        }
        // Forward on a hit too, or a consumer whose first call hits subscribes to nothing.
        forwardDeps(entry.deps);
        warnIfOrphanedDeps(entry.deps);
        return entry.result;
      }
      cache.splice(hit, 1);
    }
    const {
      value,
      deps
    } = runTracked(() => resultFn(...inputValues));
    cache.unshift({
      inputValues,
      deps,
      depVersions: deps.map(dep => dep.getVersion()),
      result: value
    });
    if (cache.length > cacheMax) cache.length = cacheMax;
    forwardDeps(deps);
    warnIfOrphanedDeps(deps);
    return value;
  };
}

// Exported so the built declaration files keep these names in scope for the doc links above; an import that only a
// doc comment uses is dropped from them.
//# sourceMappingURL=tracked_selector.js.map