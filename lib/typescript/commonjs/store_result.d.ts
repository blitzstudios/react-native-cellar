/**
 * {@linkcode DataResult}, what every store read's hook returns: its value and the state of the fetch behind it. Its
 * fields are a subset of React Query's `UseQueryResult`, so a React Query result can be used wherever a
 * {@linkcode DataResult} is expected.
 */
import { PrimeState } from './prime_state';
import type { CommonDef, Read, ReadDef } from './read/surface';
import type { QueryRuntime } from './runtime';
/**
 * A read's status: `loading` while its first fetch is in flight with no rows yet, `error` if that fetch failed, and
 * otherwise `success`. The same names as React Query's, so a screen handles both the same way.
 */
export type DataStatus = 'loading' | 'success' | 'error';
/**
 * What a read's {@linkcode Read.useValue | useValue} hook returns: the read's value, and the state of the fetch of its
 * partitions (a partition is the set of rows one fetch returns and replaces). These are the fields of React Query's
 * result that screens use, so a call site can switch between a {@linkcode QueryRuntime.useQuery | useQuery} and a store
 * read without changes.
 */
export interface DataResult<T> {
    /**
     * The read's value: what its {@linkcode ReadDef.select | select} computed from the partition's rows, or the read's
     * {@linkcode CommonDef.empty | empty} while the partition has no rows yet, the read is disabled, or its args are
     * missing a value.
     */
    data: T;
    /**
     * `loading` while the partition's first fetch is in flight and it has no rows yet, `error` if that fetch failed and
     * it still has no rows, and otherwise `success`. Rows already stored count as `success` even while a refetch runs or
     * fails, and a disabled read is always `success`.
     */
    status: DataStatus;
    /**
     * Whether {@linkcode DataResult.status | status} is `loading`: the first fetch is in flight and the partition has
     * no rows yet.
     */
    isLoading: boolean;
    /**
     * Whether a fetch of the partition is in flight, including a refetch of rows already shown. Correct whenever the
     * component renders, but a change in it doesn't cause a render by itself: a refetch starting and finishing would
     * otherwise re-render every reader of the partition twice. A spinner that must track a background refetch needs its
     * own trigger.
     */
    isFetching: boolean;
    /**
     * Whether {@linkcode DataResult.status | status} is `success`: the partition has rows, or the read is disabled, or
     * there is nothing to fetch.
     */
    isSuccess: boolean;
    /**
     * Whether {@linkcode DataResult.status | status} is `error`: the partition's first fetch failed and it has no rows.
     */
    isError: boolean;
    /** Fetches the read's partitions again now, however recently they were fetched. */
    refetch: () => void;
}
/**
 * The names of every {@linkcode DataResult} field. The app's lint rule reads this list to check which fields a screen
 * takes from a read, so the rule and the type can't drift apart.
 */
export declare const DATA_RESULT_KEYS: readonly ["data", "status", "isLoading", "isFetching", "isSuccess", "isError", "refetch"];
/**
 * Builds a {@linkcode DataResult} from a value and a status, setting {@linkcode DataResult.isLoading | isLoading},
 * {@linkcode DataResult.isSuccess | isSuccess} and {@linkcode DataResult.isError | isError} from the status. For a hook
 * that returns a {@linkcode DataResult} without being a declared read, such as one that returns a result per item in a
 * list; declared reads already return one.
 */
export declare function makeResult<T>(data: T, status: DataStatus, opts?: {
    /**
     * The result's {@linkcode DataResult.isFetching | isFetching}: whether a fetch is in flight. Defaults to
     * whether `status` is `loading`.
     */
    isFetching?: boolean;
    /**
     * The function the result's {@linkcode DataResult.refetch | refetch} calls. Defaults to a function that does
     * nothing.
     */
    refetch?: () => void;
}): DataResult<T>;
/**
 * A read's status from its state: `success` when it is disabled or has rows (whatever its fetch is doing), otherwise
 * `error` if the fetch failed, `loading` if the first fetch is in flight, and `success` if there is no fetch (a store
 * fed only by pushes).
 */
export declare function readStatus(enabled: boolean, hasData: boolean, prime: PrimeState): DataStatus;
export type { CommonDef, QueryRuntime, Read, ReadDef };
//# sourceMappingURL=store_result.d.ts.map