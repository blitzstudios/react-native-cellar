/**
 * {@linkcode createCoverage}: a list that already read its rows' values hands them down, so each row reads its own
 * only when the list doesn't cover it.
 */
import React from 'react';
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
    useCovered: (scope: string | null | undefined, id: string | null | undefined) => {
        value: V | undefined;
    } | undefined;
}
export declare function createCoverage<V>(name: string): Coverage<V>;
//# sourceMappingURL=coverage.d.ts.map