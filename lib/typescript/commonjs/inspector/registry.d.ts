/** Every store {@linkcode defineSqliteStore} has declared, by name, for a development tool to list. */
import type { defineSqliteStore } from '../define_sqlite_store';
import type { InspectedStore } from './store';
/**
 * Adds a store to the list. A store declared again under a name already listed (a Fast Refresh re-running its module)
 * replaces the one before it.
 */
export declare function registerInspectedStore(store: InspectedStore): void;
/** Every declared store, in the order they were first declared. */
export declare function inspectedStores(): InspectedStore[];
/** The store declared under `name`, if there is one. */
export declare function inspectedStore(name: string): InspectedStore | undefined;
export type { defineSqliteStore };
//# sourceMappingURL=registry.d.ts.map