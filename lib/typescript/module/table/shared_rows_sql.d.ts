/**
 * The SQL for a store's shared rows: each row stored once by its primary key, however many partitions hold it. A
 * membership table lists each partition's row ids, and the store's table is a view joining the two.
 *
 * A write stages its rows, then in one transaction: fills the columns the fetch leaves out from the stored rows, keeps
 * a stored row that is newer by `newerBy`, updates changed rows in place, replaces the partition's membership, deletes
 * rows no partition holds, and records the changed rows other partitions hold. Identities match with `IS`, so a null
 * key column still names one row.
 */
import { IndexDef, RowShape, RowTableSchema } from './types';
import type { BatchCommand } from './connection';
import type { StageNames, WriteMode } from './entity_diff_sql';
/** The tables under a store's view, named for it. */
export declare function sharedTableNames(table: string): {
    rows: string;
    members: string;
};
export interface SharedRowsSql {
    /** Creates the rows and membership tables, their indexes, and the view. */
    create: (temporary: boolean) => string[];
    drop: string[];
    /** The declared secondary indexes, without `partition_key`, on the rows table. */
    indexes: Array<IndexDef<RowShape>>;
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
    /** Compares the stage with the stored rows and applies it, recording the entities that changed here and elsewhere. */
    diff: (mode: WriteMode, where: Partial<RowShape>, writeId: number, carries?: readonly string[]) => BatchCommand[];
    /** Reads back and deletes one write's changes in other partitions. */
    readElsewhere: (writeId: number) => BatchCommand;
}
export declare function sharedRowsSql<Row extends RowShape>(schema: RowTableSchema<Row>, names: StageNames, path: 'async' | 'sync'): SharedRowsSql;
//# sourceMappingURL=shared_rows_sql.d.ts.map