"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
Object.defineProperty(exports, "bindNodeStore", {
  enumerable: true,
  get: function () {
    return _node_connection.bindNodeStore;
  }
});
Object.defineProperty(exports, "openNodeConnection", {
  enumerable: true,
  get: function () {
    return _node_connection.openNodeConnection;
  }
});
var _node_connection = require("./node_connection.js");
/**
 * Cellar on a Node server: each store bound to a `node:sqlite` database of its own, written by a worker thread so
 * ingesting a fetched body never holds up a render. Pair it with `configureCellar({ serverRendering: true })` and the
 * snapshot surface (`dehydrateReads`, `CellarHydrate`) in the core entry.
 */

const g = globalThis;
g.__DEV__ ??= process.env.NODE_ENV !== 'production';
//# sourceMappingURL=index.js.map