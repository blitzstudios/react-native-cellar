"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.createCoverage = createCoverage;
var _react = _interopRequireWildcard(require("react"));
function _interopRequireWildcard(e, t) { if ("function" == typeof WeakMap) var r = new WeakMap(), n = new WeakMap(); return (_interopRequireWildcard = function (e, t) { if (!t && e && e.__esModule) return e; var o, i, f = { __proto__: null, default: e }; if (null === e || "object" != typeof e && "function" != typeof e) return f; if (o = t ? n : r) { if (o.has(e)) return o.get(e); o.set(e, f); } for (const t in e) "default" !== t && {}.hasOwnProperty.call(e, t) && ((i = (o = Object.defineProperty) && Object.getOwnPropertyDescriptor(e, t)) && (i.get || i.set) ? o(f, t, i) : f[t] = e[t]); return f; })(e, t); }
/**
 * {@linkcode createCoverage}: a list that already read its rows' values hands them down, so each row reads its own
 * only when the list doesn't cover it.
 */

const NO_VALUES = Object.freeze({});
function createCoverage(name) {
  const Context = /*#__PURE__*/_react.default.createContext(undefined);
  Context.displayName = name;
  const Provider = /*#__PURE__*/_react.default.memo(function CoverageProvider({
    scope,
    ids,
    values,
    children
  }) {
    const covering = (0, _react.useMemo)(() => ({
      scope,
      covers: new Set(ids),
      values: values ?? NO_VALUES
    }), [scope, ids, values]);
    return /*#__PURE__*/_react.default.createElement(Context.Provider, {
      value: covering
    }, children);
  });
  function useCovered(scope, id) {
    const covering = (0, _react.useContext)(Context);
    const isCovered = !!covering && !!id && scope === covering.scope && covering.covers.has(id);
    const value = isCovered ? covering.values[id] : undefined;
    return (0, _react.useMemo)(() => isCovered ? {
      value
    } : undefined, [isCovered, value]);
  }
  return {
    Provider,
    useCovered
  };
}
//# sourceMappingURL=coverage.js.map