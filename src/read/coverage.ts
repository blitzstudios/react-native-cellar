/**
 * {@linkcode createCoverage}: a list that already read its rows' values hands them down, so each row reads its own
 * only when the list doesn't cover it.
 */

import React, { useContext, useMemo } from 'react';

type Covering<V> = { scope: string; covers: ReadonlySet<string>; values: Readonly<Record<string, V>> };

export interface CoverageProviderProps<V> {
  /** What the ids are ids of, such as a sport: a lookup in another scope is not covered. */
  scope: string;
  /** Every id the list covers, including ones whose value hasn't arrived yet. */
  ids: readonly string[];
  /** The values the list has so far, by id. */
  values: Readonly<Record<string, V>> | undefined;
  children?: React.ReactNode;
}

export interface Coverage<V> {
  /** Makes a list's values available to the rows under it. */
  Provider: React.NamedExoticComponent<CoverageProviderProps<V>>;
  /**
   * `{ value }` when the list above covers `id` in `scope`, `value` being `undefined` while the list's read of it is
   * still in flight; `undefined` when nothing covers it, so the row reads it itself. Pass the row's own read
   * `enabled: !covered`, so a covered row fetches nothing.
   */
  useCovered: (scope: string | null | undefined, id: string | null | undefined) => { value: V | undefined } | undefined;
}

const NO_VALUES: Readonly<Record<string, never>> = Object.freeze({});

export function createCoverage<V>(name: string): Coverage<V> {
  const Context = React.createContext<Covering<V> | undefined>(undefined);
  Context.displayName = name;

  const Provider = React.memo(function CoverageProvider({ scope, ids, values, children }: CoverageProviderProps<V>) {
    const covering = useMemo(() => ({ scope, covers: new Set(ids), values: values ?? NO_VALUES }), [scope, ids, values]);
    return React.createElement(Context.Provider, { value: covering }, children);
  });

  function useCovered(scope: string | null | undefined, id: string | null | undefined): { value: V | undefined } | undefined {
    const covering = useContext(Context);
    const isCovered = !!covering && !!id && scope === covering.scope && covering.covers.has(id);
    const value = isCovered ? covering.values[id as string] : undefined;
    return useMemo(() => (isCovered ? { value } : undefined), [isCovered, value]);
  }

  return { Provider, useCovered };
}
