"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.chunkList = chunkList;
exports.getOrCreate = getOrCreate;
/** The array and map helpers Cellar leans on: fixed-size chunking, and get-or-insert over a `Map`. */

function chunkList(items, size) {
  const out = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}

/** The value stored at `key`, inserting `make()`'s result on a miss. A stored `0` or `''` counts as present. */
function getOrCreate(map, key, make) {
  if (map.has(key)) return map.get(key);
  const created = make();
  map.set(key, created);
  return created;
}
//# sourceMappingURL=collections.js.map