"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.renderPhaseOwnerStack = renderPhaseOwnerStack;
var React = _interopRequireWildcard(require("react"));
function _interopRequireWildcard(e, t) { if ("function" == typeof WeakMap) var r = new WeakMap(), n = new WeakMap(); return (_interopRequireWildcard = function (e, t) { if (!t && e && e.__esModule) return e; var o, i, f = { __proto__: null, default: e }; if (null === e || "object" != typeof e && "function" != typeof e) return f; if (o = t ? n : r) { if (o.has(e)) return o.get(e); o.set(e, f); } for (const t in e) "default" !== t && {}.hasOwnProperty.call(e, t) && ((i = (o = Object.defineProperty) && Object.getOwnPropertyDescriptor(e, t)) && (i.get || i.set) ? o(f, t, i) : f[t] = e[t]); return f; })(e, t); }
/**
 * The DEV probe for "is React rendering right now?", read off the hooks dispatcher: its members throw everywhere
 * except render, which is what separates a render from an effect.
 */

const SHARED_INTERNALS_KEY = '__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE';
const HOOKS_UNAVAILABLE = 'throwInvalidHookError';
function isRendering() {
  const internals = React[SHARED_INTERNALS_KEY];
  const dispatcher = internals?.H;
  if (!dispatcher) return false;
  return dispatcher.useMemo?.name !== HOOKS_UNAVAILABLE;
}

/** A `\n    at <Component>` chain for the component rendering now, or `null` outside render and in production. */
function renderPhaseOwnerStack() {
  if (!isRendering()) return null;
  const capture = React.captureOwnerStack;
  return typeof capture === 'function' ? capture() : null;
}
//# sourceMappingURL=render_phase.js.map