/** The row table on SQLite: rows live in the database, and become JS objects at the moment a read materializes them. */
import { RowShape, RowTable, RowTableSchema } from './types';
import { WriteSteps } from './change_set';
import { NativeShredSpec, ShredSpec } from '../write/shred_spec';
import { SqliteConnection } from './connection';
import type { defineSqliteStore } from '../define_sqlite_store';
/** A step timed on the JS thread. */
type JsStep = 'queuedMs' | 'shredMs' | 'readBackMs';
/** A step timed by SQLite, between two of a batch's clock marks. */
type NativeStep = 'shredMs' | 'applyMs';
/**
 * Times one write's steps in `Date.now()` time. SQLite's `julianday('now')` reads the same wall clock, so the marks a
 * batch records and the laps taken around it subtract from each other.
 */
export declare function stepTimer(calledAt: number): {
    /** Charges the time since the last lap to `step`. */
    lap(step: JsStep): void;
    /**
     * Charges a batch that has just resolved: each native step the time between its two marks, and the rest to handing
     * the batch over and to picking its result back up. A batch whose marks did not all come back leaves the write
     * untimed.
     */
    batch(resumedAt: number, marks: readonly number[], native: readonly NativeStep[]): void;
    steps(path: WriteSteps["path"]): WriteSteps | undefined;
};
/** Options for {@linkcode createSqliteRowTable}. */
export interface SqliteRowTableOptions {
    /**
     * Creates the table, its indexes and its ETag table as `TEMP` tables, held in memory and starting empty each
     * launch. A temp table is visible only to its own connection, so it is never read through a separate reader.
     */
    temporary?: boolean;
}
/**
 * Creates a {@linkcode RowTable} backed by a SQLite table. Rows stay in SQLite, and only the ones a read selects become
 * JS objects. {@linkcode defineSqliteStore} creates one when a store is bound. Call its
 * {@linkcode RowTable.init | init} before anything else, which creates the table or rebuilds an outdated one.
 */
export declare function createSqliteRowTable<Row extends RowShape>(schema: RowTableSchema<Row>, conn: SqliteConnection, storeShredSpec?: NativeShredSpec, options?: SqliteRowTableOptions): RowTable<Row>;
export type { RowTable, ShredSpec, defineSqliteStore };
//# sourceMappingURL=sqlite.d.ts.map