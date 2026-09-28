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
export type { QueryClient, QuerySpec, QueryStatus, ReadGate, ReadGateRuntime } from './runtime';
export { configureCellar } from './runtime';
export { defineSqliteStore } from './define_sqlite_store';
export type { PartitionSpec, SqliteStore, CellarContext, StoreFetchSpec, StoreFunctions, StorePush, StorePushOf, StorePushSpec, StoreSurface } from './define_sqlite_store';
export type { PartitionLifecycle } from './define_partitions';
export type { DataStatus, DataResult } from './store_result';
export { DATA_RESULT_KEYS, makeResult } from './store_result';
export type { PrimeState } from './prime_state';
export type { CacheDeclaration, CacheFactory } from './cache_block';
export type { CacheKeyPart } from './caches';
export { byPartition, shallowEqualArray, shallowEqualRecord, shallowEqualStruct, shallowEqualValue } from './caches';
export { byEntity } from './read/derived_values';
export type { SqlValue, ColumnDef, RowTableSchema, RowTable } from './table/types';
export type { PartitionKeyColumn, StoreTableSchema } from './table/partitioned';
export type { ChangeSet, WriteResult } from './table/change_set';
export { ALL_ENTITIES, NO_CHANGES } from './table/change_set';
export { createSqliteRowTable } from './table/sqlite';
export type { SqliteConnection, PinnedConnection } from './table/connection';
export { readRows, readRowsIn, pinnedReader } from './table/connection';
export type { RawQuery } from './write/fetch_ingest';
export { RAW_TEXT_RESPONSE_TRANSFORM } from './write/fetch_ingest';
export type { ShredColumn, ShredColumns, ShredColumnsBase, NativeShredColumns, RowOf } from './write/shred_columns';
export { defineShredColumns } from './write/shred_columns';
export type { ShredOp, ShredSpec, NativeShredSpec } from './write/shred_spec';
export { rowsOf } from './read/row_shaping';
export type { MaybeId, ReadOptions, Loose } from './read/facade';
export { pairRead } from './read/facade';
export type { WindowedBlock } from './read/windowed_list';
export { createWindowedList } from './read/windowed_list';
export type { DerivedValues, DerivedValuesDef, EntityCacheDeclaration } from './read/derived_values';
export type { VersionAtom } from './reactivity/version_atom';
export type { Dep } from './reactivity/tracking';
export { runTracked, runSubscribed } from './reactivity/tracking';
export { createTrackedSelector } from './reactivity/tracked_selector';
export type { TrackedValueOptions } from './reactivity/tracked_value';
export { useTrackedValue } from './reactivity/tracked_value';
export { reportStoreDegradation } from './diagnostics/telemetry';
export { createOnceGuard } from './diagnostics/once_guard';
//# sourceMappingURL=index.d.ts.map