/**
 * When a partition written by a push retires its ETag. A push changes rows the stored ETag vouched for, so the ETag
 * has to go, or the next fetch is answered 304 and whatever the socket missed is never corrected. Retiring it on every
 * push would turn every refetch during a live stream into a full body, so it is retired at most once per interval.
 */
/** How long a pushed-to partition keeps its ETag after one is retired: two minutes. */
export declare const ETAG_RETIRE_INTERVAL_MS: number;
/** Wraps `clearEtag` so a burst of pushed writes retires a partition's ETag once per `intervalMs`, not once per write. */
export declare function createEtagRetirement(clearEtag: (key: string) => void, intervalMs?: number): (key: string) => void;
//# sourceMappingURL=etag_retirement.d.ts.map