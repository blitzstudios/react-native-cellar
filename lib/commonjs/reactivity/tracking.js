"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.isTracking = isTracking;
exports.runSubscribed = runSubscribed;
exports.runTracked = runTracked;
exports.trackDependency = trackDependency;
var _args_key = require("../args_key.js");
var _once_guard = require("../diagnostics/once_guard.js");
var _render_phase = require("./render_phase.js");
/**
 * Dependency tracking: how a computation learns what store data it used, so it can re-run when that data changes.
 *
 * A tracking scope is code run through {@linkcode runTracked} (which {@linkcode Read.useValue | useValue} reads,
 * `useTrackedStores` and tracked selectors all use). Every time code inside it reads a version number (a partition's, a
 * entity's, or a partition's presence), the read reports a dependency to the scope; the scope then subscribes to
 * exactly those, and re-runs when one changes. A getter must report its dependencies on every call, cache hits
 * included, or a computation using it won't update.
 */

/**
 * One thing a computation in a tracking scope read, which the scope subscribes to: a partition's version, one entity's
 * version within a partition, or a partition's presence (whether it has rows). A partition is the set of rows one fetch
 * returns and replaces; an entity is the thing a row belongs to, such as one player, named by the table's `entityId`
 * column.
 */

const sinkStack = [];
let subscribedDepth = 0;

/**
 * Runs `fn` and returns its result, marking the store reads inside it as already subscribed to by the caller. In dev,
 * reading store data during render outside any tracking scope logs a warning, since nothing would re-render the
 * component when that data changes; use this where the component does subscribe another way, such as with a version
 * hook.
 */
function runSubscribed(fn) {
  subscribedDepth += 1;
  try {
    return fn();
  } finally {
    subscribedDepth -= 1;
  }
}

/**
 * Reports a dependency to the innermost enclosing tracking scope, which will subscribe to it; this is how
 * {@linkcode VersionAtom.get | version.get} and the other version reads make themselves visible to
 * {@linkcode runTracked}. A tracking scope is code run through {@linkcode runTracked} (which
 * {@linkcode Read.useValue | useValue} reads, `useTrackedStores` and tracked selectors all use): every version number
 * read inside it is recorded as a dependency, and the scope re-runs when one of them changes.
 *
 * Outside any scope it records nothing; in dev, if that happens during a component's render and nothing marked the read
 * as subscribed, it logs a warning naming the partition and the component, since the component won't re-render when the
 * data changes.
 */
function trackDependency(dep) {
  const sink = sinkStack[sinkStack.length - 1];
  if (sink) {
    if (!sink.has(dep.id)) sink.set(dep.id, dep);
    return;
  }
  if (__DEV__ && subscribedDepth === 0) warnIfUnsubscribedRenderRead(dep);
}
const warnedSites = (0, _once_guard.createOnceGuard)();
function warnIfUnsubscribedRenderRead(dep) {
  const ownerStack = (0, _render_phase.renderPhaseOwnerStack)();
  if (ownerStack === null) return;
  // Named by partition: an entity or presence descriptor extends its partition's id, and one read reporting several of
  // them is still one unsubscribed read.
  const [partitionId] = dep.id.split(_args_key.GROUP_SEP);
  if (warnedSites.seen(`${partitionId}${ownerStack}`)) return;
  // eslint-disable-next-line no-console
  console.warn(`[cellar] read ${(0, _args_key.partitionLabel)(partitionId.split(_args_key.KEY_SEP))} during render without subscribing to it, so this ` + `component will show the value it read now and never update it. Read through the store's \`useValue\` hook ` + `(it subscribes itself), or run the derivation inside \`useTrackedStores\` / wrap a \`connect\` component ` + `in \`withTrackedStores\`, which subscribe to whatever partitions the read touched. For many rows, read them ` + `as a set (a by-ids read) rather than one getter per row.${ownerStack}`);
}
/**
 * Runs `fn` as a tracking scope and returns its result together with its dependencies: every version number `fn` read
 * (partitions, entities, presence), each once. It doesn't subscribe to anything itself; the caller does, as
 * {@linkcode Read.useValue | useValue}, `useTrackedStores` and tracked selectors do.
 *
 * Scopes nest, and the dependencies of an inner scope aren't passed to the outer one automatically: to make the outer
 * scope depend on them too, call {@linkcode trackDependency} with each.
 */
function runTracked(fn) {
  const sink = new Map();
  sinkStack.push(sink);
  try {
    const value = fn();
    return {
      value,
      deps: Array.from(sink.values())
    };
  } finally {
    sinkStack.pop();
  }
}

/**
 * Whether code is running inside a tracking scope right now, so a dependency reported now would be subscribed to. For
 * deciding whether to warn that a read will never re-render anything; not for changing what a read does, since a read
 * reports its dependencies either way.
 */
function isTracking() {
  return sinkStack.length > 0;
}

// Exported so the built declaration files keep these names in scope for the doc links above; an import that only a
// doc comment uses is dropped from them.
//# sourceMappingURL=tracking.js.map