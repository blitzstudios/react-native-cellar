/**
 * What a cached value costs on the JS heap, estimated in JS, and what it looks like, previewed for a development
 * tool. Neither needs the engine: the estimate walks the value and adds up rough per-type sizes for a 64-bit engine
 * (object and array slots, string characters, Map and Set entries), counting each object once per walk. It is a
 * ranking and an order of magnitude, not a measurement.
 */
/** A heap estimate. */
export interface HeapEstimate {
    /** The estimated bytes. */
    bytes: number;
    /** How many objects the walk counted. */
    objects: number;
    /** Whether the walk stopped at its limit before counting everything, so `bytes` is a floor. */
    partial: boolean;
}
/**
 * Adds `value` to a running estimate, counting each object at most once across the walk that owns `seen`, and
 * stopping once the estimate has counted `maxObjects`.
 */
export declare function estimateInto(value: unknown, estimate: HeapEstimate, seen: Set<object>, maxObjects?: number): void;
/**
 * Adds every one of `values` to a running estimate as {@linkcode estimateInto} does, but in slices of about `sliceMs`
 * that yield to the event loop between them, so a walk over many megabytes of cached rows never holds the JS thread
 * for longer than a slice.
 */
export declare function estimateIntoSliced(values: readonly unknown[], estimate: HeapEstimate, seen: Set<object>, maxObjects?: number, sliceMs?: number): Promise<void>;
/** A budget for work done in slices: `due` once a slice has run `sliceMs`, and `yield` waits a turn and starts the next. */
export declare function sliceClock(sliceMs?: number): {
    due: () => boolean;
    yield: () => Promise<void>;
};
/** A fresh estimate of `value` on its own. */
export declare function estimateHeap(value: unknown): HeapEstimate;
/**
 * A value as JSON can carry it, cut down to a preview: at most `depth` levels, `items` elements or properties per
 * container and `chars` characters per string. What JSON can't carry is marked with `$type` (a Map's entries, a Set's
 * values, a class instance's name, a function, a repeated reference), and what was cut with `$more`.
 */
export declare function previewValue(value: unknown, options?: {
    depth?: number;
    items?: number;
    chars?: number;
}): unknown;
//# sourceMappingURL=heap.d.ts.map