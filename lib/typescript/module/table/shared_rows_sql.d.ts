/**
 * How a store's rows are stored: once each, however many partitions hold them. A row's identity is its primary key, and
 * a partition is the set of rows its fetch returned, kept in a membership table by row id. The table a store reads by
 * name is a view joining the two, so every read, and every store's own SQL, still filters on `partition_key`.
 *
 * Writes stage their rows the way every write does, and then one transaction compares the stage with the stored rows by
 * identity: the columns a fetch doesn't carry are copied into the stage first, so a fetch of fewer columns never blanks
 * the rest; a staged copy older than the stored one by `newerBy` takes the stored values; the rows that differ are
 * updated in place, so their ids hold; the partition's membership becomes the stage's rows; and a row no partition
 * holds anymore is deleted. A row that changed and that other partitions also hold is recorded per partition, so
 * their readers are woken too.
 *
 * Identities are matched with `IS`, so a key column that is null for some rows, such as the week of a season total,
 * still names one row.
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
    /** Drops the view and the two tables under it. */
    drop: string[];
    /** The declared secondary indexes, without `partition_key`, on the rows table. */
    indexes: Array<IndexDef<RowShape>>;
    /** Creates the TEMP tables and the stage index a write uses. */
    ensure: BatchCommand[];
    /** Compares the stage with the stored rows and applies it, recording the entities that changed here and elsewhere. */
    diff: (mode: WriteMode, where: Partial<RowShape>, writeId: number, carries?: readonly string[]) => BatchCommand[];
    /** Reads back and deletes one write's changes in other partitions. */
    readElsewhere: (writeId: number) => BatchCommand;
}
export declare function sharedRowsSql<Row extends RowShape>(schema: RowTableSchema<Row>, names: StageNames, path: 'async' | 'sync'): SharedRowsSql;
//# sourceMappingURL=shared_rows_sql.d.ts.map