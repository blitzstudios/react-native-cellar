/**
 * The SQL for a store's shared rows: each row stored once by its `uniqueBy` columns, however many partitions hold it. A
 * membership table lists each partition's row ids, and the store's table is a view joining the two.
 *
 * A write stages its rows, then in one transaction: fills each column a staged row leaves absent from the stored row,
 * or with NULL for a new one, keeps a stored row that is newer by `newerBy`, updates changed rows in place, replaces
 * the partition's membership, deletes rows no partition holds, and records the changed rows other partitions hold.
 * Identities match with `IS`, so a null key column still names one row.
 */
import { RowShape, RowTableSchema } from './types';
import type { BatchCommand } from './connection';
import { StageNames, WriteMode } from './entity_diff_sql';
import type { ShredSpec } from '../write/shred_spec';
/** The tables under a store's view, named for it. */
export declare function sharedTableNames(table: string): {
    rows: string;
    members: string;
};
export interface SharedRowsSql {
    /** Creates the rows and membership tables, their indexes, and the view. */
    create: (temporary: boolean) => string[];
    drop: string[];
    /** Creates the TEMP tables and the stage index a write uses. */
    ensure: BatchCommand[];
    /**
     * The membership table's `sqlite_stat1` rows: a partition holds many rows, and a row few partitions. They let the
     * planner start a filtered read from the rows table's index.
     */
    planStats: ReadonlyArray<{
        idx: string;
        stat: string;
    }>;
    /**
     * Lists each staged row's absent columns from the element JSON a native shred staged beside it, by the same rules as
     * the JS row builder, drops the JSON, and fills them: one statement per group of columns that are absent together,
     * so the native path needs no read in between to learn which sets the stage holds.
     */
    absentFromElements: (spec: ShredSpec) => BatchCommand[];
    /**
     * Compares the stage with the stored rows and applies it, recording the entities that changed here and elsewhere.
     * `absentSets` are the stage's distinct sets of absent columns, each of which takes the stored row's values.
     */
    diff: (mode: WriteMode, where: Partial<RowShape>, writeId: number, absentSets: readonly string[]) => BatchCommand[];
    /** Reads back and deletes one write's changes in other partitions. */
    readElsewhere: (writeId: number) => BatchCommand;
}
export declare function sharedRowsSql<Row extends RowShape>(schema: RowTableSchema<Row>, names: StageNames, path: 'async' | 'sync'): SharedRowsSql;
//# sourceMappingURL=shared_rows_sql.d.ts.map