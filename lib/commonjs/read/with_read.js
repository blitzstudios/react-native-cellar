"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.memoNamed = memoNamed;
exports.withRead = withRead;
var _react = _interopRequireDefault(require("react"));
function _interopRequireDefault(e) { return e && e.__esModule ? e : { default: e }; }
/**
 * {@linkcode withRead}: a published read's value handed to a class or `connect` component as a prop, for a component
 * that can't call the hook itself.
 */

/** Names a wrapper `hoc(Wrapped)` on both halves, since only the memo's name reaches React DevTools. */
function memoNamed(hoc, Component, Inner) {
  const displayName = `${hoc}(${Component.displayName || Component.name || 'Component'})`;
  Inner.displayName = displayName;
  const Memoized = /*#__PURE__*/_react.default.memo(Inner);
  Memoized.displayName = displayName;
  return Memoized;
}
/**
 * Wraps `Component` so it receives `useRead`'s value as `spec.prop`, read with the params `spec.useParams` takes from
 * its props. `useRead` is any hook taking `{ params }` and returning `{ data }`: a published read's `useValue`, or a
 * hook built on one. The wrapper is memoized, so it re-renders the component only when its props or the value change.
 */
function withRead(useRead, spec) {
  const name = spec.name ?? `with${spec.prop.charAt(0).toUpperCase()}${spec.prop.slice(1)}`;
  return Component => memoNamed(name, Component, props => {
    const {
      data
    } = useRead({
      params: spec.useParams(props)
    });
    return /*#__PURE__*/_react.default.createElement(Component, {
      ...props,
      [spec.prop]: data
    });
  });
}
//# sourceMappingURL=with_read.js.map