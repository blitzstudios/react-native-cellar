/** The array and map helpers Cellar leans on: fixed-size chunking, and get-or-insert over a `Map`. */
export declare function chunkList<T>(items: readonly T[], size: number): T[][];
/** The value stored at `key`, inserting `make()`'s result on a miss. A stored `0` or `''` counts as present. */
export declare function getOrCreate<K, V>(map: Map<K, V>, key: K, make: () => V): V;
//# sourceMappingURL=collections.d.ts.map