/**
 * How a key's parts are joined. Its own module, and with no imports of its own, so anything that needs to build a key
 * can have it — including the diagnostics that key derivation itself reports through, which would otherwise be a cycle.
 */
/** Separator between a key's parts. A control character, since a part may itself contain `:` (`region:us-west`). */
export declare const KEY_SEP = "\0";
/**
 * The identity of one cache entry, built from the parts that distinguish it: two lookups share an entry exactly when
 * every part matches. Use this for any key in `caches.ts` rather than a template literal or a `join(':')`, which
 * collide two different keys as soon as a part contains `:` itself (`region:us-west`).
 */
export declare function cacheKey(...parts: readonly string[]): string;
/**
 * The same key from parts a caller already holds as an array. `cacheKey(...parts)` spreads that array into rest
 * arguments, allocating a second one per call purely to join it, and the read path builds keys per read per render.
 */
export declare function cacheKeyOf(parts: readonly string[]): string;
//# sourceMappingURL=key.d.ts.map