/**
 * The state of the fetch of a read's partitions (a partition is the set of rows one fetch returns and replaces),
 * as the fetch hooks return it: whether the first fetch is in flight, whether any fetch is, and whether it failed. For
 * several partitions, loading or fetching if any is, and failed only if all failed.
 */
export interface PrimeState {
  /** Whether the partition's first fetch is in flight, with nothing fetched yet. */
  isInitialLoading: boolean;
  /**
   * Whether a fetch of the partition is in flight, including a refetch of rows already fetched. Correct whenever the
   * component renders, but a change in it doesn't cause a render by itself: a refetch starting and finishing would
   * otherwise re-render every reader of the partition twice. A spinner shown only before anything has loaded should use
   * {@linkcode PrimeState.isInitialLoading | isInitialLoading}; one that must track a background refetch needs its own
   * trigger.
   */
  isFetching: boolean;
  /** Whether the partition's last fetch failed. */
  isError: boolean;
}

/**
 * The fetch state of a partition that nothing fetches (in a store fed only by pushes, or a stub in a test): not
 * loading, not fetching, not failed. A read of such a partition reports `success`, even while it has no rows.
 */
export const PRIME_IDLE: PrimeState = { isInitialLoading: false, isFetching: false, isError: false };

/**
 * The fetch hook used in place of a real one by a store fed only by pushes: fetches nothing and returns
 * {@linkcode PRIME_IDLE}. Chosen once when the store is built, so every render calls the same hook.
 */
export const NO_PRIMING = (): PrimeState => PRIME_IDLE;
