/**
 * {@linkcode createTrackedSelector}, a replacement for Reselect's `createSelector` for a Redux selector that reads
 * store data, usually by calling a service getter in its `resultFn`. Reselect caches on its inputs only, so such a
 * selector would keep returning its old result after a store write. This one also records every store version
 * `resultFn` read, and recomputes when one of those changes.
 */
import type { Read } from '../read/surface';
/**
 * One entry in a tracked selector's `inputs`: a function called with the selector's own arguments (such as Redux state
 * and props), whose return value is passed to `resultFn`. The selector recomputes when any input's value changes.
 */
export type InputSelector<Args extends readonly unknown[], T = unknown> = (...args: Args) => T;
/** Compares an input's previous and new value; when every input is equal, the selector can return its cached result. */
export type EqualityFn = (left: unknown, right: unknown) => boolean;
/** Options for {@linkcode createTrackedSelector}. */
export interface TrackedSelectorOptions {
    /**
     * How an input's previous and new values are compared; `Object.is` by default. Pass a shallow or deep comparison for
     * an input that returns a newly built object or array on every call, or the selector would recompute every time.
     */
    inputEqual?: EqualityFn;
    /**
     * The selector's name in the dev warning shown when it reads store data outside a tracking scope (where nothing would
     * re-render when that data changes). Defaults to the list of partitions it read.
     */
    debugLabel?: string;
    /** How many sets of arguments to cache a result for at once; 8 by default. The least recently used is dropped. */
    cacheMax?: number;
}
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
export declare function createTrackedSelector<Args extends readonly unknown[], V1, R>(inputs: readonly [InputSelector<Args, V1>], resultFn: (v1: V1) => R, options?: TrackedSelectorOptions): (...args: Args) => R;
export declare function createTrackedSelector<Args extends readonly unknown[], V1, V2, R>(inputs: readonly [InputSelector<Args, V1>, InputSelector<Args, V2>], resultFn: (v1: V1, v2: V2) => R, options?: TrackedSelectorOptions): (...args: Args) => R;
export declare function createTrackedSelector<Args extends readonly unknown[], V1, V2, V3, R>(inputs: readonly [InputSelector<Args, V1>, InputSelector<Args, V2>, InputSelector<Args, V3>], resultFn: (v1: V1, v2: V2, v3: V3) => R, options?: TrackedSelectorOptions): (...args: Args) => R;
export declare function createTrackedSelector<Args extends readonly unknown[], V1, V2, V3, V4, R>(inputs: readonly [InputSelector<Args, V1>, InputSelector<Args, V2>, InputSelector<Args, V3>, InputSelector<Args, V4>], resultFn: (v1: V1, v2: V2, v3: V3, v4: V4) => R, options?: TrackedSelectorOptions): (...args: Args) => R;
export declare function createTrackedSelector<Args extends readonly unknown[], V1, V2, V3, V4, V5, R>(inputs: readonly [InputSelector<Args, V1>, InputSelector<Args, V2>, InputSelector<Args, V3>, InputSelector<Args, V4>, InputSelector<Args, V5>], resultFn: (v1: V1, v2: V2, v3: V3, v4: V4, v5: V5) => R, options?: TrackedSelectorOptions): (...args: Args) => R;
export declare function createTrackedSelector<Args extends readonly unknown[], V1, V2, V3, V4, V5, V6, R>(inputs: readonly [
    InputSelector<Args, V1>,
    InputSelector<Args, V2>,
    InputSelector<Args, V3>,
    InputSelector<Args, V4>,
    InputSelector<Args, V5>,
    InputSelector<Args, V6>
], resultFn: (v1: V1, v2: V2, v3: V3, v4: V4, v5: V5, v6: V6) => R, options?: TrackedSelectorOptions): (...args: Args) => R;
export declare function createTrackedSelector<Args extends readonly unknown[], V1, V2, V3, V4, V5, V6, V7, R>(inputs: readonly [
    InputSelector<Args, V1>,
    InputSelector<Args, V2>,
    InputSelector<Args, V3>,
    InputSelector<Args, V4>,
    InputSelector<Args, V5>,
    InputSelector<Args, V6>,
    InputSelector<Args, V7>
], resultFn: (v1: V1, v2: V2, v3: V3, v4: V4, v5: V5, v6: V6, v7: V7) => R, options?: TrackedSelectorOptions): (...args: Args) => R;
export declare function createTrackedSelector<Args extends readonly unknown[], V1, V2, V3, V4, V5, V6, V7, V8, R>(inputs: readonly [
    InputSelector<Args, V1>,
    InputSelector<Args, V2>,
    InputSelector<Args, V3>,
    InputSelector<Args, V4>,
    InputSelector<Args, V5>,
    InputSelector<Args, V6>,
    InputSelector<Args, V7>,
    InputSelector<Args, V8>
], resultFn: (v1: V1, v2: V2, v3: V3, v4: V4, v5: V5, v6: V6, v7: V7, v8: V8) => R, options?: TrackedSelectorOptions): (...args: Args) => R;
export declare function createTrackedSelector<Args extends readonly unknown[], V1, V2, V3, V4, V5, V6, V7, V8, V9, R>(inputs: readonly [
    InputSelector<Args, V1>,
    InputSelector<Args, V2>,
    InputSelector<Args, V3>,
    InputSelector<Args, V4>,
    InputSelector<Args, V5>,
    InputSelector<Args, V6>,
    InputSelector<Args, V7>,
    InputSelector<Args, V8>,
    InputSelector<Args, V9>
], resultFn: (v1: V1, v2: V2, v3: V3, v4: V4, v5: V5, v6: V6, v7: V7, v8: V8, v9: V9) => R, options?: TrackedSelectorOptions): (...args: Args) => R;
export declare function createTrackedSelector<Args extends readonly unknown[], V1, V2, V3, V4, V5, V6, V7, V8, V9, V10, R>(inputs: readonly [
    InputSelector<Args, V1>,
    InputSelector<Args, V2>,
    InputSelector<Args, V3>,
    InputSelector<Args, V4>,
    InputSelector<Args, V5>,
    InputSelector<Args, V6>,
    InputSelector<Args, V7>,
    InputSelector<Args, V8>,
    InputSelector<Args, V9>,
    InputSelector<Args, V10>
], resultFn: (v1: V1, v2: V2, v3: V3, v4: V4, v5: V5, v6: V6, v7: V7, v8: V8, v9: V9, v10: V10) => R, options?: TrackedSelectorOptions): (...args: Args) => R;
export declare function createTrackedSelector<Args extends readonly unknown[], V1, V2, V3, V4, V5, V6, V7, V8, V9, V10, V11, R>(inputs: readonly [
    InputSelector<Args, V1>,
    InputSelector<Args, V2>,
    InputSelector<Args, V3>,
    InputSelector<Args, V4>,
    InputSelector<Args, V5>,
    InputSelector<Args, V6>,
    InputSelector<Args, V7>,
    InputSelector<Args, V8>,
    InputSelector<Args, V9>,
    InputSelector<Args, V10>,
    InputSelector<Args, V11>
], resultFn: (v1: V1, v2: V2, v3: V3, v4: V4, v5: V5, v6: V6, v7: V7, v8: V8, v9: V9, v10: V10, v11: V11) => R, options?: TrackedSelectorOptions): (...args: Args) => R;
export declare function createTrackedSelector<Args extends readonly unknown[], V1, V2, V3, V4, V5, V6, V7, V8, V9, V10, V11, V12, R>(inputs: readonly [
    InputSelector<Args, V1>,
    InputSelector<Args, V2>,
    InputSelector<Args, V3>,
    InputSelector<Args, V4>,
    InputSelector<Args, V5>,
    InputSelector<Args, V6>,
    InputSelector<Args, V7>,
    InputSelector<Args, V8>,
    InputSelector<Args, V9>,
    InputSelector<Args, V10>,
    InputSelector<Args, V11>,
    InputSelector<Args, V12>
], resultFn: (v1: V1, v2: V2, v3: V3, v4: V4, v5: V5, v6: V6, v7: V7, v8: V8, v9: V9, v10: V10, v11: V11, v12: V12) => R, options?: TrackedSelectorOptions): (...args: Args) => R;
export type { Read };
//# sourceMappingURL=tracked_selector.d.ts.map