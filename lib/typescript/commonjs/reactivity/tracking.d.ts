/**
 * Dependency tracking: how a computation learns what store data it used, so it can re-run when that data changes.
 *
 * A tracking scope is code run through {@linkcode runTracked} (which {@linkcode Read.useValue | useValue} reads,
 * `useTrackedStores` and tracked selectors all use). Every time code inside it reads a version number (a partition's, a
 * entity's, or a partition's presence), the read reports a dependency to the scope; the scope then subscribes to
 * exactly those, and re-runs when one changes. A getter must report its dependencies on every call, cache hits
 * included, or a computation using it won't update.
 */
import type { Read } from '../read/surface';
import type { VersionAtom } from './version_atom';
/**
 * One thing a computation in a tracking scope read, which the scope subscribes to: a partition's version, one entity's
 * version within a partition, or a partition's presence (whether it has rows). A partition is the set of rows one fetch
 * returns and replaces; an entity is the thing a row belongs to, such as one player, named by the table's `entityId`
 * column.
 */
export interface Dep {
    /**
     * A string identifying the dependency (store, partition, and entity or presence), so a scope can compare what it read
     * this time with what it subscribed to last time, and change only the subscriptions that differ.
     */
    id: string;
    /** Calls `listener` whenever the dependency's version changes, and returns a function that unsubscribes it. */
    subscribe: (listener: () => void) => () => void;
    /**
     * The dependency's current version number. A scope records it when reading and checks it again after subscribing, so
     * a write that landed in between isn't missed.
     */
    getVersion: () => number;
}
/**
 * Runs `fn` and returns its result, marking the store reads inside it as already subscribed to by the caller. In dev,
 * reading store data during render outside any tracking scope logs a warning, since nothing would re-render the
 * component when that data changes; use this where the component does subscribe another way, such as with a version
 * hook.
 */
export declare function runSubscribed<T>(fn: () => T): T;
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
export declare function trackDependency(dep: Dep): void;
/**
 * Runs `fn` as a tracking scope and returns its result together with its dependencies: every version number `fn` read
 * (partitions, entities, presence), each once. It doesn't subscribe to anything itself; the caller does, as
 * {@linkcode Read.useValue | useValue}, `useTrackedStores` and tracked selectors do.
 *
 * Scopes nest, and the dependencies of an inner scope aren't passed to the outer one automatically: to make the outer
 * scope depend on them too, call {@linkcode trackDependency} with each.
 */
export declare function runTracked<T>(fn: () => T): {
    /** What `fn` returned. */
    value: T;
    /** Every version number `fn` read, each once, for the caller to subscribe to. */
    deps: Dep[];
};
/**
 * Whether code is running inside a tracking scope right now, so a dependency reported now would be subscribed to. For
 * deciding whether to warn that a read will never re-render anything; not for changing what a read does, since a read
 * reports its dependencies either way.
 */
export declare function isTracking(): boolean;
export type { Read, VersionAtom };
//# sourceMappingURL=tracking.d.ts.map