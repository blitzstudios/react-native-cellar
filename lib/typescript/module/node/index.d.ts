/**
 * Cellar on a Node server: each store bound to a `node:sqlite` database of its own, written by a worker thread so
 * ingesting a fetched body never holds up a render. Pair it with `configureCellar({ serverRendering: true })` and the
 * snapshot surface (`dehydrateReads`, `CellarHydrate`) in the core entry.
 */
export type { NodeConnection, NodeConnectionOptions } from './node_connection';
export { bindNodeStore, openNodeConnection } from './node_connection';
//# sourceMappingURL=index.d.ts.map