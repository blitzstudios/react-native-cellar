/** Key derivation for reads: a read's key is its partition plus the values it is scoped by. */
import { cacheKey, cacheKeyOf, KEY_SEP } from './key';
import type { CommonDef, ReadDef } from './read/surface';
import type { Partitions } from './define_partitions';
export { cacheKey, cacheKeyOf, KEY_SEP };
/** A string that identifies a value by its content, with object keys sorted so equal content yields one key. */
export declare function stableKey(value: unknown): string;
export declare function identityOf(part: object): string;
/**
 * A value one of a read's args holds. An object or an array keys by its content, so a read can take a config or an
 * options object without the caller serializing one — but it must be plain data, since only own enumerable properties
 * count towards the key (see {@linkcode stableKey}).
 */
export type ArgValue = string | number | boolean | null | undefined | readonly unknown[] | object;
/** Separator between groups of parts, one level above {@linkcode KEY_SEP}, so the grouping is part of the key. */
export declare const GROUP_SEP = "\u0001";
/**
 * The identity of a whole set of partitions, for something keyed by the set rather than by one member — a
 * {@linkcode Partitions.defineReadAcross | defineReadAcross}'s cache entry, a fetch over several partitions at once. Order
 * and grouping are both part of the key, so the same partitions named differently are a different set.
 */
export declare function partitionsKey(partitions: readonly (readonly string[])[]): string;
/** A partition's parts as a human reads them. Never as a key: `:` occurs inside a part (`region:us-west`). */
export declare function partitionLabel(parts: readonly string[]): string;
/** Whether an arg has a value: `undefined`, `null`, `''` and an empty array count as none; `0` and `false` are values. */
export declare function isArgPresent(value: unknown): boolean;
/**
 * A call's key: its partition, then each of its args by name, which a hook runs its select again for when it changes.
 * Args go through {@linkcode stableKey} one by one, so an object or array arg keys by its content and a caller
 * rebuilding one per render doesn't count as a change, and the args object itself is never held or frozen.
 */
export declare function argsKeyOf(parts: readonly string[], args: object): string;
export type { CommonDef, Partitions, ReadDef };
//# sourceMappingURL=args_key.d.ts.map