/**
 * The DDL a store's {@linkcode RowTable.init | init} runs and the migration plan that chooses it. A live schema is
 * identified by two stamps: the whole declaration's fingerprint in `PRAGMA user_version`, and everything but its column
 * list in `PRAGMA application_id`. A table whose declaration only grew columns is widened in place; anything else is
 * rebuilt.
 */
import { IndexDef, MetaDef, RowShape, RowTableSchema } from './types';
import { NativeShredSpec } from '../write/shred_spec';
import { SqliteConnection } from './connection';
import type { RowTable } from './types';
import type { ShredSpec } from '../write/shred_spec';
/**
 * What {@linkcode RowTable.init | init} does with the table it found — build it, leave it alone, widen it, or drop and
 * rebuild it — as {@linkcode planSchemaMigration} decides.
 */
export type SchemaMigration = 'create' | 'none' | 'extend' | 'rebuild';
/** One column as `PRAGMA table_info` reports it, which is the only account of the live table's shape. */
export interface LiveColumn {
    name: string;
    type: string;
    /** SQLite's 0 or 1, not a boolean. */
    notnull: number;
}
/**
 * What {@linkcode readLiveSchema} finds on disk for {@linkcode planSchemaMigration} to weigh the declaration against.
 */
export interface LiveSchema {
    /**
     * Empty where the table does not exist, which is the whole of how {@linkcode RowTable.init | init} tells a first
     * install from an upgrade.
     */
    columns: ReadonlyArray<LiveColumn>;
    /** `PRAGMA user_version`: the built schema's {@linkcode schemaFingerprint}. */
    stamp: number;
    /**
     * `PRAGMA application_id`: its {@linkcode schemaStructureStamp}, `0` on a database built before that stamp existed.
     */
    structure: number;
}
/**
 * The stamp identifying a built schema, hashed out of everything {@linkcode RowTable.init | init} creates, so that
 * editing a schema migrates the database rather than needing one written by hand. A change that alters what the rows
 * hold without touching the columns, key, indexes, ETag table or shred specs is invisible here — bump
 * {@linkcode RowTableSchema.rebuildVersion | schema.rebuildVersion} to force it.
 */
export declare function schemaFingerprint<Row extends RowShape>(schema: RowTableSchema<Row>, nativeShredSpec?: NativeShredSpec): number;
/**
 * The same stamp with the columns left out — the table's and the shred spec's alike — so that comparing it against a
 * live database answers the one question {@linkcode schemaFingerprint} cannot: whether a declaration that no longer
 * matches differs *only* in the fields it holds. Masked to 31 bits, since it is stored in a `PRAGMA` slot whose
 * signedness is not worth relying on.
 */
export declare function schemaStructureStamp<Row extends RowShape>(schema: RowTableSchema<Row>, nativeShredSpec?: NativeShredSpec): number;
/**
 * Chooses between creating, keeping, widening, and rebuilding the table.
 *
 * A widening is the cheap case worth detecting, because it is the routine one: a schema whose columns are generated
 * from a catalog — the metric keys a category publishes, say — gains a column every time that catalog does, and
 * dropping every row to add one costs a user their whole table for nothing. Anything else changes what the rows on disk
 * mean — an index they are not sorted by, a key they were not deduped on, a shred op that fills a column they already
 * have from a different path — and dropping them is the honest repair, since no `ALTER TABLE` can restate them.
 */
export declare function planSchemaMigration<Row extends RowShape>(schema: RowTableSchema<Row>, live: LiveSchema, nativeShredSpec?: NativeShredSpec): SchemaMigration;
/**
 * The columns a widening would add, or `undefined` where the live table cannot be widened into the declared one:
 *
 * - a column the live table has and the declaration dropped, which a `SELECT *` would still read;
 * - one whose type or nullability moved, which restates the values already stored under it;
 * - a new column declared `NOT NULL`, which `ALTER TABLE ADD COLUMN` cannot add without a default, and which every
 *   existing row would violate anyway;
 * - nothing at all, which is a declaration that only reordered its columns — no cheaper than a rebuild to detect, and
 *   rare enough not to be worth one.
 */
export declare function addedColumns<Row extends RowShape>(schema: RowTableSchema<Row>, live: ReadonlyArray<LiveColumn>): Array<keyof Row & string> | undefined;
/**
 * The `CREATE TABLE` a store's {@linkcode RowTable.init | init} runs, spelling the columns in the
 * {@linkcode RowTableSchema.columns | columns} object's key order — the order every `INSERT` binds them in. An empty
 * {@linkcode RowTableSchema.primaryKey | primaryKey} emits no key clause, which is how a snapshot table keeps its
 * duplicates.
 */
export declare function createTableSql<Row extends RowShape>(schema: RowTableSchema<Row>, temporary?: boolean): string;
/**
 * The `CREATE TABLE` for the ETag side-table beside a row table, keyed by the columns that address a partition so each
 * partition holds one ETag. {@linkcode RowTable.init | init} builds it only for a schema declaring `meta`; a store
 * without one refetches whole bodies it already has, since it has nowhere to keep the ETag that would 304 them.
 */
export declare function createMetaTableSql<Row extends RowShape>(meta: MetaDef<Row>, temporary?: boolean): string;
/**
 * The `CREATE INDEX` for one secondary index: run at {@linkcode RowTable.init | init}, and again by a bulk write that
 * dropped its indexes to rebuild them in a single sort. `IF NOT EXISTS` leaves an index of the same name over different
 * columns in place, so an edited index only reaches the database through the fingerprint.
 */
export declare const createIndexSql: <Row extends RowShape>(table: string, idx: IndexDef<Row>) => string;
/**
 * The drop half of that pair, for a bulk write that rebuilds its indexes afterwards rather than maintaining them row by
 * row.
 */
export declare const dropIndexSql: <Row extends RowShape>(idx: IndexDef<Row>) => string;
/**
 * The `ALTER TABLE` a widening runs per column {@linkcode addedColumns} named. No `NOT NULL` clause is possible here
 * and none is needed: SQLite refuses to add such a column without a default, which is why {@linkcode addedColumns}
 * rejects one.
 */
export declare const addColumnSql: <Row extends RowShape>(schema: RowTableSchema<Row>, column: keyof Row & string) => string;
/**
 * Reads a live database's schema stamp, `0` where nothing has stamped one, for {@linkcode RowTable.init | init} to
 * weigh against {@linkcode schemaFingerprint}.
 */
export declare function readUserVersion(conn: SqliteConnection): number;
/**
 * Its companion, `0` on every database built before this stamp existed, which is what makes such a table rebuild once.
 */
export declare function readApplicationId(conn: SqliteConnection): number;
/** Everything {@linkcode RowTable.init | init} plans from, in the three PRAGMA reads it takes to find it. */
export declare function readLiveSchema(conn: SqliteConnection, table: string): LiveSchema;
/**
 * Notes that a rebuild emptied a push-fed table, whose rows a fetch refills except for the pushes that arrived since
 * the last one. That is a consequence of shipping a schema change rather than a malfunction, so it reports as a sampled
 * notice rather than an error, beside the failures that genuinely took a store off SQLite.
 *
 * It deliberately does not throw, in `__DEV__` or anywhere else. {@linkcode RowTable.init | init} stamps the schema
 * last, so refusing the rebuild would leave the stale stamp on disk and fail the same way on every launch after, over
 * an expected event. Catching the edit belongs where the edit happens: a store pins its column set in a test, which is
 * what fails when the schema widens.
 */
export declare function reportPushFedRebuild(table: string): void;
export type { RowTable, RowTableSchema, ShredSpec };
//# sourceMappingURL=schema.d.ts.map