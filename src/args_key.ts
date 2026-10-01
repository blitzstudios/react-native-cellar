/** Key derivation for reads: a read's key is its partition plus the values it is scoped by. */

import { createOnceGuard } from './diagnostics/once_guard';
import { cacheKey, cacheKeyOf, KEY_SEP } from './key';
import type { CommonDef, ReadDef } from './read/surface';
import type { Partitions } from './define_partitions';

export { cacheKey, cacheKeyOf, KEY_SEP };

/**
 * A `Map`, a `Set` or a class instance keys as `{}`, since none of what it holds is an own enumerable property — so two
 * different ones would share a cache entry. Caught in dev rather than typed away, because the types that legitimately
 * arrive here are ordinary interfaces, which no `Record` constraint accepts.
 */
const notPlainData = createOnceGuard();

function warnOnceIfNotPlainData(value: object): void {
  const proto = Object.getPrototypeOf(value) as unknown;
  if (proto === Object.prototype || proto === null) return;
  const name = (value.constructor as { name?: string } | undefined)?.name ?? 'an object';
  if (notPlainData.seen(name)) return;
  // eslint-disable-next-line no-console
  console.warn(
    `[cellar] keyed by a ${name}, which is not plain data: only own enumerable properties count towards a key, ` +
      `so two different ${name}s would key alike and share one cache entry. Key by the values you mean instead.`,
  );
}

/** A string that identifies a value by its content, with object keys sorted so equal content yields one key. */
export function stableKey(value: unknown): string {
  if (value === undefined) return 'u';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'u';
  if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`;
  if (__DEV__) warnOnceIfNotPlainData(value);
  const entries = Object.entries(value as Record<string, unknown>).filter(([, value]) => value !== undefined);
  entries.sort((left, right) => (left[0] < right[0] ? -1 : 1));
  // Keys are quoted as well as values: unquoted, `{'a:1,b': 2}` and `{a: 1, b: 2}` render the same string.
  return `{${entries.map(([key, value]) => `${JSON.stringify(key)}:${stableKey(value)}`).join(',')}}`;
}

/**
 * The content identity of a part, remembered per reference. Callers that hold one part across a loop -- ranking a
 * page of rows re-keys the same shape object once per row -- otherwise re-serialize an unchanged object every time,
 * and the part carrying a whole metric config makes that the most expensive thing on the read path.
 *
 * Shared across keyers because {@linkcode stableKey} is a pure function of the part. Only the serialization is skipped:
 * the id still comes from the content, so an equal part built fresh keys the same as one held, and a reference whose
 * id was evicted re-mints exactly as it would have.
 */
const identities = new WeakMap<object, string>();

const mutatedWarned = new WeakSet<object>();

/**
 * The parts dev has checked since the JS thread last went idle. A loop that keys a page of rows by one part would
 * otherwise re-serialize it per row, which ranking a few thousand rows by a metric config made the slowest thing in a
 * dev profile; a mutation happens between turns, so one check per part per turn still catches it.
 */
let checkedThisTurn: Set<object> | undefined;

function firstCheckThisTurn(part: object): boolean {
  if (!checkedThisTurn) {
    checkedThisTurn = new Set();
    void Promise.resolve().then(() => {
      checkedThisTurn = undefined;
    });
  }
  if (checkedThisTurn.has(part)) return false;
  checkedThisTurn.add(part);
  return true;
}

export function identityOf(part: object): string {
  const known = identities.get(part);
  if (known !== undefined) {
    // Reading a reference's identity from cache is only sound while its content holds still. Dev checks it, once a
    // turn, rather than freezing the caller's object: a part is often state its owner still mutates, such as a Redux
    // array, and a freeze would make that owner throw.
    if (!__DEV__ || !firstCheckThisTurn(part)) return known;
    const current = stableKey(part);
    if (current === known) return known;
    if (!mutatedWarned.has(part)) {
      mutatedWarned.add(part);
      // eslint-disable-next-line no-console
      console.warn(
        '[cellar] an object passed to a read was mutated after the read keyed it, so a release build would keep reading ' +
          'the key it had before. Pass a new object when its content changes.',
      );
    }
    identities.set(part, current);
    return current;
  }
  const identity = stableKey(part);
  identities.set(part, identity);
  return identity;
}

/**
 * A value one of a read's args holds. An object or an array keys by its content, so a read can take a config or an
 * options object without the caller serializing one — but it must be plain data, since only own enumerable properties
 * count towards the key (see {@linkcode stableKey}).
 */
export type ArgValue = string | number | boolean | null | undefined | readonly unknown[] | object;

/** Separator between groups of parts, one level above {@linkcode KEY_SEP}, so the grouping is part of the key. */
export const GROUP_SEP = '\u0001';

/**
 * The identity of a whole set of partitions, for something keyed by the set rather than by one member — a
 * {@linkcode Partitions.defineReadAcross | defineReadAcross}'s cache entry, a fetch over several partitions at once. Order
 * and grouping are both part of the key, so the same partitions named differently are a different set.
 */
export function partitionsKey(partitions: readonly (readonly string[])[]): string {
  return partitions.map(cacheKeyOf).join(GROUP_SEP);
}

/** A partition's parts as a human reads them. Never as a key: `:` occurs inside a part (`region:us-west`). */
export function partitionLabel(parts: readonly string[]): string {
  return parts.join(':');
}

/** Whether an arg has a value: `undefined`, `null`, `''` and an empty array count as none; `0` and `false` are values. */
export function isArgPresent(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/**
 * A call's key: its partition, then each of its args by name, which a hook runs its select again for when it changes.
 * Args go through {@linkcode stableKey} one by one, so an object or array arg keys by its content and a caller
 * rebuilding one per render doesn't count as a change, and the args object itself is never held or frozen.
 */
export function argsKeyOf(parts: readonly string[], args: object): string {
  const fields = Object.keys(args);
  if (!fields.length) return cacheKeyOf(parts);
  // Sorted, so two callers spelling the same args in a different order share a key.
  if (fields.length > 1) fields.sort();
  const joined = new Array<string>(parts.length + fields.length * 2);
  for (let index = 0; index < parts.length; index++) joined[index] = parts[index];
  for (let index = 0; index < fields.length; index++) {
    const value = (args as Record<string, unknown>)[fields[index]];
    joined[parts.length + index * 2] = fields[index];
    // Structured values go through {@linkcode identityOf}, so a caller holding an options object across a list
    // serializes it once instead of once per row.
    joined[parts.length + index * 2 + 1] = value !== null && typeof value === 'object' ? identityOf(value) : stableKey(value);
  }
  return cacheKeyOf(joined);
}

// Exported so the built declaration files keep these names in scope for the doc links above; an import that only a
// doc comment uses is dropped from them.
export type { CommonDef, Partitions, ReadDef };
