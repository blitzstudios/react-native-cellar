"use strict";

/**
 * Cellar on a Node server: each store bound to a `node:sqlite` database of its own, written by a worker thread so
 * ingesting a fetched body never holds up a render. Pair it with `configureCellar({ serverRendering: true })` and the
 * snapshot surface (`dehydrateReads`, `CellarHydrate`) in the core entry.
 */

const g = globalThis;
g.__DEV__ ??= process.env.NODE_ENV !== 'production';
export { bindNodeStore, openNodeConnection } from "./node_connection.js";
//# sourceMappingURL=index.js.map