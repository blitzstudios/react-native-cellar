"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.partitionKeyOf = partitionKeyOf;
/** Which of a read's args name the partition it reads. */

/** Args fields that can name a partition: every field of a partition key is one string. */

/**
 * The mapper from a read's args to its partition key: a field list picks those fields into an object, which *is*
 * the key, and an opaque key arrives through a function of its own.
 */
function partitionKeyOf(spec) {
  if (typeof spec === 'function') return spec;
  const fields = spec;
  return args => {
    const key = {};
    for (const field of fields) key[field] = args[field];
    return key;
  };
}

// Exported so the built declaration files keep these names in scope for the doc links above; an import that only a
// doc comment uses is dropped from them.
//# sourceMappingURL=partition_fields.js.map