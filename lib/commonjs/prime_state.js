"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.PRIME_IDLE = exports.NO_PRIMING = void 0;
/**
 * The state of the fetch of a read's partitions (a partition is the set of rows one fetch returns and replaces),
 * as the fetch hooks return it: whether the first fetch is in flight, whether any fetch is, and whether it failed. For
 * several partitions, loading or fetching if any is, and failed only if all failed.
 */

/**
 * The fetch state of a partition that nothing fetches (in a store fed only by pushes, or a stub in a test): not
 * loading, not fetching, not failed. A read of such a partition reports `success`, even while it has no rows.
 */
const PRIME_IDLE = exports.PRIME_IDLE = {
  isInitialLoading: false,
  isFetching: false,
  isError: false
};

/**
 * The fetch hook used in place of a real one by a store fed only by pushes: fetches nothing and returns
 * {@linkcode PRIME_IDLE}. Chosen once when the store is built, so every render calls the same hook.
 */
const NO_PRIMING = () => PRIME_IDLE;
exports.NO_PRIMING = NO_PRIMING;
//# sourceMappingURL=prime_state.js.map