"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.DATA_RESULT_KEYS = void 0;
exports.makeResult = makeResult;
exports.readStatus = readStatus;
/**
 * {@linkcode DataResult}, what every store read's hook returns: its value and the state of the fetch behind it. Its
 * fields are a subset of React Query's `UseQueryResult`, so a React Query result can be used wherever a
 * {@linkcode DataResult} is expected.
 */

/**
 * A read's status: `loading` while its first fetch is in flight with no rows yet, `error` if that fetch failed, and
 * otherwise `success`. The same names as React Query's, so a screen handles both the same way.
 */

/**
 * What a read's {@linkcode Read.useValue | useValue} hook returns: the read's value, and the state of the fetch of its
 * partitions (a partition is the set of rows one fetch returns and replaces). These are the fields of React Query's
 * result that screens use, so a call site can switch between a {@linkcode QueryRuntime.useQuery | useQuery} and a store
 * read without changes.
 */

/**
 * The names of every {@linkcode DataResult} field. The app's lint rule reads this list to check which fields a screen
 * takes from a read, so the rule and the type can't drift apart.
 */
const DATA_RESULT_KEYS = exports.DATA_RESULT_KEYS = ['data', 'status', 'isLoading', 'isFetching', 'isSuccess', 'isError', 'refetch'];
const NOOP_REFETCH = () => {};

/**
 * Builds a {@linkcode DataResult} from a value and a status, setting {@linkcode DataResult.isLoading | isLoading},
 * {@linkcode DataResult.isSuccess | isSuccess} and {@linkcode DataResult.isError | isError} from the status. For a hook
 * that returns a {@linkcode DataResult} without being a declared read, such as one that returns a result per item in a
 * list; declared reads already return one.
 */
function makeResult(data, status, opts) {
  const isLoading = status === 'loading';
  return {
    data,
    status,
    isLoading,
    isFetching: opts?.isFetching ?? isLoading,
    isSuccess: status === 'success',
    isError: status === 'error',
    refetch: opts?.refetch ?? NOOP_REFETCH
  };
}

/**
 * A read's status from its state: `success` when it is disabled or has rows (whatever its fetch is doing), otherwise
 * `error` if the fetch failed, `loading` if the first fetch is in flight, and `success` if there is no fetch (a store
 * fed only by pushes).
 */
function readStatus(enabled, hasData, prime) {
  if (!enabled) return 'success';
  if (hasData) return 'success';
  if (prime.isError) return 'error';
  return prime.isInitialLoading ? 'loading' : 'success';
}

// Exported so the built declaration files keep these names in scope for the doc links above; an import that only a
// doc comment uses is dropped from them.
//# sourceMappingURL=store_result.js.map