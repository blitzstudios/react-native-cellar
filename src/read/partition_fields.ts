/** Which of a read's args name the partition it reads. */

import type { CommonDef } from './surface';

/** Args fields that can name a partition: every field of a partition key is one string. */
export type PartitionField<Args> = { [K in keyof Args]: Args[K] extends string ? K : never }[keyof Args];

/**
 * The mapper from a read's args to its partition key: a field list picks those fields into an object, which *is*
 * the key, and an opaque key arrives through a function of its own.
 */
export function partitionKeyOf<Args, Key>(spec: readonly PartitionField<Args>[] | ((args: Args) => Key)): (args: Args) => Key {
  if (typeof spec === 'function') return spec;
  const fields = spec as readonly string[];
  return (args) => {
    const key: Record<string, unknown> = {};
    for (const field of fields) key[field] = (args as Record<string, unknown>)[field];
    return key as Key;
  };
}

// Exported so the built declaration files keep these names in scope for the doc links above; an import that only a
// doc comment uses is dropped from them.
export type { CommonDef };
