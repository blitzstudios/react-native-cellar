/**
 * {@linkcode withRead}: a published read's value handed to a class or `connect` component as a prop, for a component
 * that can't call the hook itself.
 */
import React from 'react';
/** Names a wrapper `hoc(Wrapped)` on both halves, since only the memo's name reaches React DevTools. */
export declare function memoNamed<P extends object>(hoc: string, Component: {
    displayName?: string;
    name?: string;
}, Inner: React.FC<P>): React.MemoExoticComponent<React.FC<P>>;
export interface WithReadSpec<P, Params, K extends string> {
    /** The prop the value is handed as. */
    prop: K;
    /** The read's params, from the wrapped component's props. */
    useParams: (props: P) => Params;
    /** The wrapper's name in React DevTools; `with` + the prop's name by default. */
    name?: string;
}
/**
 * Wraps `Component` so it receives `useRead`'s value as `spec.prop`, read with the params `spec.useParams` takes from
 * its props. `useRead` is any hook taking `{ params }` and returning `{ data }`: a published read's `useValue`, or a
 * hook built on one. The wrapper is memoized, so it re-renders the component only when its props or the value change.
 */
export declare function withRead<P extends object, Params, T, K extends string>(useRead: (args: {
    params: Params;
}) => {
    data: T;
}, spec: WithReadSpec<P, Params, K>): (Component: React.ComponentType<P & {
    [Prop in K]?: T;
}>) => React.MemoExoticComponent<React.FC<P>>;
//# sourceMappingURL=with_read.d.ts.map