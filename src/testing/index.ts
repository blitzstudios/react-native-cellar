/**
 * Fixtures for a suite that exercises a store built on Cellar: a real SQLite engine off-device, a version atom
 * that recomputes on every read, the host services as spies, and the wrappers that pin a case to one build.
 *
 * Cellar's own internals a test reaches for live here rather than on the core entry point, so the surface a
 * screen or a service sees stays down to what it actually writes against.
 */

export { createSqlJsConnection, initSqlJs } from './sqljs_connection';
export {
  createStoreTable,
  createTestRowTable,
  createTestRowTableWithConnection,
  createTestStoreTable,
  createTestStoreTableWithConnection,
} from './row_table';
export type { SqlJsCapabilities, SqlJsConnection } from './sqljs_connection';
export { createTestVersionAtom } from './version_atom';
export { testCache } from './caches';
export { installTestRuntime } from './runtime';
export { itDev } from './dev_mode';
export { columnsLeftOut } from './columns_left_out';

// Kernel internals with no caller in shipping code: a real version atom to bump by hand, the JS reading of a shred
// spec to check the native one against, and the guard reset that keeps a once-per-process warning from carrying
// between cases.
export { createVersionAtom } from '../reactivity/version_atom';
export { evalShredElement } from '../write/shred_spec';
export { storeShredSpec } from '../table/partitioned';
export { resetOnceGuards } from '../diagnostics/once_guard';
