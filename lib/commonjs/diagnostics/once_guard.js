"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.createOnceGuard = createOnceGuard;
exports.onGuardReset = onGuardReset;
exports.resetOnceGuards = resetOnceGuards;
var _key = require("../key.js");
/** Keys that can each be marked once, for firing a warning once. {@linkcode resetOnceGuards} clears every guard. */

const resets = [];

/** A set of keys that can each be marked once. */

/**
 * Creates a set of keys that can each be marked once, for a warning or report that would otherwise fire on every call,
 * such as a dev warning during render or a Sentry report on a path a socket hits thousands of times.
 */
function createOnceGuard() {
  const marked = new Set();
  resets.push(() => marked.clear());
  return {
    seen(...parts) {
      const key = (0, _key.cacheKey)(...parts);
      if (marked.has(key)) return true;
      marked.add(key);
      return false;
    },
    has: (...parts) => marked.has((0, _key.cacheKey)(...parts))
  };
}

/**
 * Runs `reset` whenever {@linkcode resetOnceGuards} does, for other state a warning keeps, such as a batch it collects.
 */
function onGuardReset(reset) {
  resets.push(reset);
}

/**
 * Clears every guard's marks. Marks outlast a test, so a test that expects a warning should call this first, or its
 * result depends on the tests that ran before it.
 */
function resetOnceGuards() {
  for (const reset of resets) reset();
}
//# sourceMappingURL=once_guard.js.map