"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.CAPTURE = void 0;
exports.CellarHydrate = CellarHydrate;
exports.dehydrateReads = dehydrateReads;
exports.readCall = readCall;
exports.snapshotKeyOf = snapshotKeyOf;
exports.useHydrated = useHydrated;
var _react = _interopRequireWildcard(require("react"));
var _key = require("../key.js");
var _telemetry = require("../diagnostics/telemetry.js");
function _interopRequireWildcard(e, t) { if ("function" == typeof WeakMap) var r = new WeakMap(), n = new WeakMap(); return (_interopRequireWildcard = function (e, t) { if (!t && e && e.__esModule) return e; var o, i, f = { __proto__: null, default: e }; if (null === e || "object" != typeof e && "function" != typeof e) return f; if (o = t ? n : r) { if (o.has(e)) return o.get(e); o.set(e, f); } for (const t in e) "default" !== t && {}.hasOwnProperty.call(e, t) && ((i = (o = Object.defineProperty) && Object.getOwnPropertyDescriptor(e, t)) && (i.get || i.set) ? o(f, t, i) : f[t] = e[t]); return f; })(e, t); }
/**
 * Read snapshots, for an app that renders on a server: the server works out what a page's reads answer
 * ({@linkcode dehydrateReads}), and the browser renders those values ({@linkcode CellarHydrate}) until its own store
 * holds the rows, so the HTML and the browser's first render agree while the store is still being bound.
 */

/** One read's value as the server rendered it. */

/** What {@linkcode dehydrateReads} hands a page: each captured read's value, by the read and its args. Plain data. */

/** What capturing one read produces: its snapshot key and entry, or nothing when the read had nothing to answer. */

/** How a read's hook and getter expose the capture {@linkcode dehydrateReads} runs. Shared across copies of Cellar. */
const CAPTURE = exports.CAPTURE = Symbol.for('cellar.read.capture');

/** A read's hook or getter, as {@linkcode pairRead} publishes it, carrying its capture. */

/** One read to capture: its hook or getter, the params a component will call it with, and whether to go live. */

/** The key a snapshot files a read's value under: the read's name in its store, then the read's args key. */
function snapshotKeyOf(readId, argsKey) {
  return `${readId}${_key.KEY_SEP}${argsKey}`;
}

/**
 * Names one read for {@linkcode dehydrateReads}: a service's hook or getter for it (`PlayerService.Hooks.usePlayer`),
 * and the params a component on the page will pass it. With `live`, the browser still fetches the read's partitions
 * and moves to the live value once they land; without it, the snapshot's value is the read's answer until something
 * else fetches the partition.
 */
function readCall(read, params, options) {
  const capture = read[CAPTURE];
  if (!capture) throw new Error('readCall: pass a read published with pairRead (a service hook or getter)');
  return {
    capture: () => capture(params, options?.live ?? false),
    label: read.name || 'a read'
  };
}

/**
 * Fetches each read's partitions if needed, waits for them, and returns what each read answers, as plain data a server
 * passes to {@linkcode CellarHydrate}. A read whose fetch fails is left out and reported, so its component renders as it
 * would with no snapshot: loading, then fetching in the browser.
 */
async function dehydrateReads(calls) {
  const settled = await Promise.allSettled(calls.map(call => call.capture()));
  const reads = {};
  settled.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      if (result.value) reads[result.value[0]] = result.value[1];
      return;
    }
    (0, _telemetry.reportStoreDegradation)({
      scope: 'hydration.capture',
      context: 'a read could not be captured for a server render, so the browser fetches it instead',
      error: result.reason,
      extra: {
        read: calls[index].label
      }
    });
  });
  return {
    reads
  };
}
const CONTEXT = Symbol.for('cellar.read.hydration');
const registry = globalThis;
// One context however many copies of Cellar a server bundle loads, so a provider from one reaches a read from another.
const HydrationContext = registry[CONTEXT] ??= /*#__PURE__*/_react.default.createContext(undefined);
HydrationContext.displayName = 'CellarHydrate';
/**
 * Makes a server's read snapshot available to the reads under it. A read finds its value here while its store has no
 * rows for it, on the server always, and in the browser until its partition lands. Nested providers add to the one
 * above, an inner entry winning.
 */
function CellarHydrate({
  snapshot,
  children
}) {
  const outer = (0, _react.useContext)(HydrationContext);
  const entries = (0, _react.useMemo)(() => {
    const own = Object.entries(snapshot?.reads ?? {});
    if (!own.length) return outer;
    const merged = new Map(outer);
    for (const [key, entry] of own) merged.set(key, entry);
    return merged;
  }, [outer, snapshot]);
  return /*#__PURE__*/_react.default.createElement(HydrationContext.Provider, {
    value: entries
  }, children);
}

/** The snapshot entry for one read call, if a {@linkcode CellarHydrate} above holds one; `readId` undefined looks up nothing. */
function useHydrated(readId, argsKey) {
  const entries = (0, _react.useContext)(HydrationContext);
  return readId && entries ? entries.get(snapshotKeyOf(readId, argsKey)) : undefined;
}
//# sourceMappingURL=hydration.js.map