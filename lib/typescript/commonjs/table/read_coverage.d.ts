import type { ReadDef } from '../read/surface';
/** Called by every row table read. */
export declare function noteTableRead(): void;
/** Runs `read` as one whose dependencies are reported by its caller, so its table reads do not count as uncovered. */
export declare function covered<T>(read: () => T): T;
/** A running count of uncovered table reads: compare it before and after a derivation to learn whether it made one. */
export declare function uncoveredReads(): number;
export type { ReadDef };
//# sourceMappingURL=read_coverage.d.ts.map