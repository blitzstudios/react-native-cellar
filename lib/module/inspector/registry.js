"use strict";

/** Every store {@linkcode defineSqliteStore} has declared, by name, for a development tool to list. */

const stores = new Map();

/**
 * Adds a store to the list. A store declared again under a name already listed (a Fast Refresh re-running its module)
 * replaces the one before it.
 */
export function registerInspectedStore(store) {
  stores.set(store.name, store);
}

/** Every declared store, in the order they were first declared. */
export function inspectedStores() {
  return Array.from(stores.values());
}

/** The store declared under `name`, if there is one. */
export function inspectedStore(name) {
  return stores.get(name);
}

// Exported so the built declaration files keep these names in scope for the doc links above; an import that only a
// doc comment uses is dropped from them.
//# sourceMappingURL=registry.js.map