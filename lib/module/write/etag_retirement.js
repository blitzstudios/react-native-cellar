"use strict";

/**
 * When a partition written by a push retires its ETag. A push changes rows the stored ETag vouched for, so the ETag
 * has to go, or the next fetch is answered 304 and whatever the socket missed is never corrected. Retiring it on every
 * push would turn every refetch during a live stream into a full body, so it is retired at most once per interval.
 */

/** How long a pushed-to partition keeps its ETag after one is retired: two minutes. */
export const ETAG_RETIRE_INTERVAL_MS = 2 * 60 * 1000;

/**
 * How many partitions carry a retirement time. Evicting one costs a single extra retirement the next time that
 * partition is written, which is what the interval would have allowed soon after anyway.
 */
const TRACKED_PARTITIONS_MAX = 256;

/** Wraps `clearEtag` so a burst of pushed writes retires a partition's ETag once per `intervalMs`, not once per write. */
export function createEtagRetirement(clearEtag, intervalMs = ETAG_RETIRE_INTERVAL_MS) {
  const retiredAt = new Map();
  return function retireOnPushWrite(key) {
    const now = Date.now();
    const last = retiredAt.get(key);
    if (last != null && now - last < intervalMs) return;

    // Deleted before setting because `Map.set` leaves an existing key where it was, and eviction below wants iteration
    // order to be least- to most-recently retired.
    retiredAt.delete(key);
    retiredAt.set(key, now);
    if (retiredAt.size > TRACKED_PARTITIONS_MAX) {
      const oldest = retiredAt.keys().next();
      if (!oldest.done) retiredAt.delete(oldest.value);
    }
    clearEtag(key);
  };
}
//# sourceMappingURL=etag_retirement.js.map