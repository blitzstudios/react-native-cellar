"use strict";

/**
 * Fixtures for a suite that exercises a store built on Cellar: a real SQLite engine off-device, a version atom
 * that recomputes on every read, the host services as spies, and the wrappers that pin a case to one build.
 *
 * Cellar's own internals a test reaches for live here rather than on the core entry point, so the surface a
 * screen or a service sees stays down to what it actually writes against.
 */

export { createSqlJsConnection, initSqlJs } from "./sqljs_connection.js";
export { createStoreTable, createTestRowTable, createTestRowTableWithConnection, createTestStoreTable, createTestStoreTableWithConnection } from "./row_table.js";
export { createTestVersionAtom } from "./version_atom.js";
export { testCache } from "./caches.js";
export { installTestRuntime } from "./runtime.js";
export { itDev } from "./dev_mode.js";

// Kernel internals with no caller in shipping code: a real version atom to bump by hand, the JS reading of a shred
// spec to check the native one against, and the guard reset that keeps a once-per-process warning from carrying
// between cases.
export { createVersionAtom } from "../reactivity/version_atom.js";
export { evalShredElement } from "../write/shred_spec.js";
export { storeShredSpec } from "../table/partitioned.js";
export { resetOnceGuards } from "../diagnostics/once_guard.js";
//# sourceMappingURL=index.js.map