/**
 * How a SQLite write works out which entities it changed and rewrites only those.
 *
 * Every write lands its rows in a staging table first — the native shred included, pointed at the stage by table name —
 * and then one transaction compares the stage with the main table, records the entities that differ, rewrites exactly
 * those, and empties the stage. The comparison is every column, null-safe, and exact: `(m.a, m.b) IS NOT (s.a, s.b)`
 * for a table with a primary key, and a multiset comparison per entity for one without. It is SQL shared by every write
 * path, so the native shred, the JS parse fallback and a socket upsert cannot disagree about what changed.
 *
 * The changed entities are written to a changes table, keyed by a per-write id, and read back with one
 * `DELETE … RETURNING` after the transaction, since a batch hands back no rows. Every write also records its row count
 * there, so a read-back that finds nothing at all means the transaction never ran — which a guarded connection in
 * release reports as silence — and not that nothing changed.
 */
import { RowShape, RowTableSchema } from './types';
import type { BatchCommand } from './connection';
import type { RowTable } from './types';
/**
 * Where a table's writes stage: TEMP tables on the writer, so they are invisible to the reader and to the schema
 * stamps.
 */
export interface StageNames {
    stage: string;
    changes: string;
}
/**
 * The staging tables for one row table. The sync path gets a stage of its own, since
 * {@linkcode RowTable.overwrite | overwrite} runs without waiting for the async write queue and must not empty a stage
 * an async write has filled.
 *
 * The stage is named for the schema's fingerprint, so a schema that changes within a session — a Fast Refresh — stages
 * into a table with its new columns rather than one left over with the old, and nothing ever has to be dropped.
 */
export declare function stageNames(table: string, fingerprint: number, path: 'async' | 'sync'): StageNames;
/** Whether replacing a partition or merging rows in: a fetch replaces, and a socket push merges by primary key. */
export type WriteMode = 'replace' | 'merge';
export interface EntityDiffSql {
    /** Creates the stage and the changes table if the connection does not have them yet: TEMP tables go with it. */
    ensure: BatchCommand[];
    /** Empties the stage, so a write that failed halfway cannot leave rows behind for the next one to apply. */
    clear: BatchCommand;
    /** Inserts rows into the stage, chunked to stay under the bind limit. */
    stageRows: (rows: readonly RowShape[]) => BatchCommand[];
    /** The same chunked insert into any table with these columns: the main table, for a write with nothing to diff. */
    insertInto: (target: string, rows: readonly RowShape[]) => BatchCommand[];
    /** Compares the stage with the main table, records the changed entities, rewrites them, and empties the stage. */
    diff: (mode: WriteMode, where: Partial<RowShape>, writeId: number) => BatchCommand[];
    /** Reads back and deletes one write's record: its entities, and its row count. */
    readBack: (writeId: number) => BatchCommand;
}
/** The SQL for staging, diffing and applying writes to one table, built once per table. */
export declare function entityDiffSql<Row extends RowShape>(schema: RowTableSchema<Row>, names: StageNames, maxBinds: number): EntityDiffSql;
export type { RowTable };
//# sourceMappingURL=entity_diff_sql.d.ts.map