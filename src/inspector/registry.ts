/** Every store {@linkcode defineSqliteStore} has declared, by name, for a development tool to list. */

import type { defineSqliteStore } from '../define_sqlite_store';
import type { InspectedStore } from './store';

const stores = new Map<string, InspectedStore>();

/**
 * Adds a store to the list. A store declared again under a name already listed (a Fast Refresh re-running its module)
 * replaces the one before it.
 */
export function registerInspectedStore(store: InspectedStore): void {
  stores.set(store.name, store);
}

/** Every declared store, in the order they were first declared. */
export function inspectedStores(): InspectedStore[] {
  return Array.from(stores.values());
}

/** The store declared under `name`, if there is one. */
export function inspectedStore(name: string): InspectedStore | undefined {
  return stores.get(name);
}

// Exported so the built declaration files keep these names in scope for the doc links above; an import that only a
// doc comment uses is dropped from them.
export type { defineSqliteStore };
