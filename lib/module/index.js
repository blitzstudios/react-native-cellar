"use strict";

/**
 * Cellar's public surface: what a store definition, a service, or a screen imports. The pieces a store is built out
 * of are here; the pieces {@linkcode defineSqliteStore} is built out of are not, and
 * a store that finds itself wanting one of those is reaching past its entry point.
 *
 * A name is exported when a consumer writes it, or when it appears in the inferred type of something a consumer exports
 * (a store, a column list): TypeScript can only write a consumer's declaration files with types it can name through
 * this entry point, which `src/tests/declaration_emit.test.ts` checks. `src/tests/public_surface.test.ts` fails if this
 * list grows without someone meaning it to. Test-only fixtures live behind `./testing` instead.
 */

// What the host installs before it binds a store: where a report goes, the query runtime an ingest mounts on, and
// when a read is live.

export { configureCellar } from "./runtime.js";

// Declaring a store.
export { defineSqliteStore } from "./define_sqlite_store.js";

// What a read hands back.

export { DATA_RESULT_KEYS, makeResult } from "./store_result.js";

// What a store keeps on the heap beyond its rows, declared in one block (`store.defineCaches({ … })`) so no caller
// builds a key.

export { byPartition, shallowEqualArray, shallowEqualRecord, shallowEqualStruct, shallowEqualValue } from "./caches.js";
export { byEntity } from "./read/derived_values.js";

// The table a store's schema describes, and the rows it holds.

export { ALL_ENTITIES, NO_CHANGES } from "./table/change_set.js";
export { createSqliteRowTable } from "./table/sqlite.js";
export { readRows, pinnedReader } from "./table/connection.js";

// Getting rows in: a fetch a partition drives, and a socket feed a store drives itself.

export { RAW_TEXT_RESPONSE_TRANSFORM } from "./write/fetch_ingest.js";
export { defineShredColumns } from "./write/shred_columns.js";
// Declaring reads, and turning rows into view models.
export { rowsOf } from "./read/row_shaping.js";
export { pairRead } from "./read/facade.js";
export { createWindowedList } from "./read/windowed_list.js";

// Repainting on a write.

export { runTracked, runSubscribed } from "./reactivity/tracking.js";
export { createTrackedSelector } from "./reactivity/tracked_selector.js";
export { useTrackedValue } from "./reactivity/tracked_value.js";
export { reportStoreDegradation } from "./diagnostics/telemetry.js";
export { createOnceGuard } from "./diagnostics/once_guard.js";
//# sourceMappingURL=index.js.map