/**
 * {@linkcode useTrackedValue}, the hook behind every {@linkcode Read.useValue | useValue} read: it runs a computation,
 * subscribes to exactly the store data it read, and runs it again when that data changes.
 *
 * Dependencies are found by running the computation, not declared: every partition version, entity version and presence
 * it reads is subscribed to. A read of three players subscribes to those three, so a write to a fourth doesn't re-run
 * it. When the computation reads something different the next time, the subscriptions change to match.
 */
import { DependencyList } from 'react';
import type { Read } from '../read/surface';
/** Options for {@linkcode useTrackedValue}. */
export interface TrackedValueOptions<T> {
    /**
     * Whether to run the computation; while false, the hook returns {@linkcode TrackedValueOptions.empty | empty}, runs
     * nothing and subscribes to nothing.
     */
    enabled: boolean;
    /**
     * Compares a recomputed value with the previous one. When they're equal, the hook keeps returning the previous object
     * and the component doesn't re-render.
     */
    isEqual: (left: T, right: T) => boolean;
    /**
     * What the hook returns while {@linkcode TrackedValueOptions.enabled | enabled} is false. Use a constant, so it is
     * the same object on every render.
     */
    empty: T;
    /**
     * Subscribes to another source of changes the computation depends on, such as the Redux store for a computation that
     * also reads Redux state. Called with a `notify` function that re-runs the computation; returns an unsubscribe.
     */
    subscribeExtra?: (notify: () => void) => () => void;
    /** True to stay subscribed while the component's read gate isn't live, so the hook keeps re-rendering on changes. */
    bypassGate?: boolean;
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
export declare function useTrackedValue<T>(compute: () => T, inputs: DependencyList, options: TrackedValueOptions<T>): T;
export type { Read };
//# sourceMappingURL=tracked_value.d.ts.map