"use strict";

/**
 * {@linkcode createCoverage}: a list that already read its rows' values hands them down, so each row reads its own
 * only when the list doesn't cover it.
 */

import React, { useContext, useMemo } from 'react';
const NO_VALUES = Object.freeze({});
export function createCoverage(name) {
  const Context = /*#__PURE__*/React.createContext(undefined);
  Context.displayName = name;
  const Provider = /*#__PURE__*/React.memo(function CoverageProvider({
    scope,
    ids,
    values,
    children
  }) {
    const covering = useMemo(() => ({
      scope,
      covers: new Set(ids),
      values: values ?? NO_VALUES
    }), [scope, ids, values]);
    return /*#__PURE__*/React.createElement(Context.Provider, {
      value: covering
    }, children);
  });
  function useCovered(scope, id) {
    const covering = useContext(Context);
    const isCovered = !!covering && !!id && scope === covering.scope && covering.covers.has(id);
    const value = isCovered ? covering.values[id] : undefined;
    return useMemo(() => isCovered ? {
      value
    } : undefined, [isCovered, value]);
  }
  return {
    Provider,
    useCovered
  };
}
//# sourceMappingURL=coverage.js.map