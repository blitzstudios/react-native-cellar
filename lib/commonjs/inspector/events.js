"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.MAX_EVENT_ENTITIES = exports.EVENT_CAPACITY = void 0;
exports.clearInspectorEvents = clearInspectorEvents;
exports.onInspectorEvent = onInspectorEvent;
exports.recentInspectorEvents = recentInspectorEvents;
exports.recordInspectorEvent = recordInspectorEvent;
/**
 * What the stores did recently, for a development tool to show: writes, moves between databases, fetches and
 * degradation reports, kept in one bounded log and handed to listeners as they happen. Recorded only in a development
 * build; a release build records nothing and keeps no log.
 */

/**
 * Where a store's rows are: its own database (a file on a device, sql.js on web), the in-memory database it falls back
 * to, or nowhere, with every read empty.
 */

/** Which database a store runs on, and since when. */

/** A write that changed a partition's rows: a fetch's, a push's, or one the store made itself. */

/** A store moving onto a database: bound at startup, reopened after a failure, moved to memory, or left unbound. */

/** A partition fetch finishing, 304s included: how long the request and the write took. */

/** A store reporting that it lost a benefit it should have had, or an expected event worth knowing about. */

/** Anything the inspector's log records. */

/** An event as it is recorded, before the log numbers and timestamps it. */

/** How many events the log keeps; past this, the oldest go. */
const EVENT_CAPACITY = exports.EVENT_CAPACITY = 1000;
/** How many entity ids a write event lists. */
const MAX_EVENT_ENTITIES = exports.MAX_EVENT_ENTITIES = 50;
const log = [];
const listeners = new Set();
let nextId = 1;

/** Records an event and hands it to every listener. Does nothing in a release build. */
function recordInspectorEvent(input) {
  if (!__DEV__) return;
  const event = {
    at: Date.now(),
    ...input,
    id: nextId++
  };
  log.push(event);
  if (log.length > EVENT_CAPACITY) log.shift();
  for (const listener of Array.from(listeners)) {
    try {
      listener(event);
    } catch {
      /* a failing listener is its own problem, and must not stop a store's write */
    }
  }
}

/** The recorded events, oldest first; only those after `afterId` when it is given. */
function recentInspectorEvents(afterId = 0) {
  return afterId > 0 ? log.filter(event => event.id > afterId) : log.slice();
}

/** Calls `listener` with each event as it is recorded, and returns a function that stops it. */
function onInspectorEvent(listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Empties the log, so a test sees only its own events. */
function clearInspectorEvents() {
  log.length = 0;
}
//# sourceMappingURL=events.js.map