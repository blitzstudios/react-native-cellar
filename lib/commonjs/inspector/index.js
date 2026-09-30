"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
Object.defineProperty(exports, "EVENT_CAPACITY", {
  enumerable: true,
  get: function () {
    return _events.EVENT_CAPACITY;
  }
});
Object.defineProperty(exports, "MAX_EVENT_ENTITIES", {
  enumerable: true,
  get: function () {
    return _events.MAX_EVENT_ENTITIES;
  }
});
Object.defineProperty(exports, "ReadOnlyViolation", {
  enumerable: true,
  get: function () {
    return _read_only.ReadOnlyViolation;
  }
});
Object.defineProperty(exports, "clearInspectorEvents", {
  enumerable: true,
  get: function () {
    return _events.clearInspectorEvents;
  }
});
Object.defineProperty(exports, "estimateHeap", {
  enumerable: true,
  get: function () {
    return _heap.estimateHeap;
  }
});
Object.defineProperty(exports, "getIngestTimings", {
  enumerable: true,
  get: function () {
    return _ingest_timing.getIngestTimings;
  }
});
Object.defineProperty(exports, "inspectedCacheEntries", {
  enumerable: true,
  get: function () {
    return _caches.inspectedCacheEntries;
  }
});
Object.defineProperty(exports, "inspectedCaches", {
  enumerable: true,
  get: function () {
    return _caches.inspectedCaches;
  }
});
Object.defineProperty(exports, "inspectedStore", {
  enumerable: true,
  get: function () {
    return _registry.inspectedStore;
  }
});
Object.defineProperty(exports, "inspectedStores", {
  enumerable: true,
  get: function () {
    return _registry.inspectedStores;
  }
});
Object.defineProperty(exports, "onInspectorEvent", {
  enumerable: true,
  get: function () {
    return _events.onInspectorEvent;
  }
});
Object.defineProperty(exports, "previewValue", {
  enumerable: true,
  get: function () {
    return _heap.previewValue;
  }
});
Object.defineProperty(exports, "recentInspectorEvents", {
  enumerable: true,
  get: function () {
    return _events.recentInspectorEvents;
  }
});
Object.defineProperty(exports, "rollupIngestTimings", {
  enumerable: true,
  get: function () {
    return _ingest_timing.rollupIngestTimings;
  }
});
var _events = require("./events.js");
var _registry = require("./registry.js");
var _caches = require("./caches.js");
var _heap = require("./heap.js");
var _read_only = require("./read_only.js");
var _ingest_timing = require("../diagnostics/ingest_timing.js");
//# sourceMappingURL=index.js.map