/**
 * The `partition_key` column every store's table carries: what {@linkcode defineSqliteStore} adds to a store's schema,
 * and how the native shred specs are extended to fill it.
 */
import type { NativeShredSpec, ShredSpec } from '../write/shred_spec';
import type { IndexDef, RowShape, RowTableSchema, SqlValue } from './types';
/** The column naming the partition each row belongs to. */
export declare const PARTITION_KEY_COLUMN = "partition_key";
/** The ETag table's column holding each partition's description as JSON. */
export declare const PARTITION_RECORD_COLUMN = "partition";
/** The column a store's rows carry for its partition: its key. */
export type PartitionKeyColumn = {
    partition_key: string;
};
/**
 * A store's table as the store declares it: its own columns, primary key and indexes, without the `partition_key`
 * column or the ETag table, which {@linkcode defineSqliteStore} adds. An index may lead with `partition_key`, as one
 * serving a read within a partition does.
 */
export type StoreTableSchema<Row extends RowShape> = Omit<RowTableSchema<Row>, 'meta' | 'partitioned' | 'indexes'> & {
    /** The table's secondary indexes: {@linkcode RowTableSchema.indexes}. */
    indexes?: ReadonlyArray<IndexDef<Row & PartitionKeyColumn>>;
};
/**
 * The full schema of a store's table: `partition_key` as the first column, the primary key led by it (unless the rows
 * have none), an index on it and the entity id, and an ETag table keyed by it that also keeps each partition's
 * description.
 */
export declare function partitionedSchema<Row extends RowShape>(schema: StoreTableSchema<Row>): RowTableSchema<Row & PartitionKeyColumn>;
/**
 * The program and binds the native shredder is handed for one partition of a store: the variant
 * {@linkcode NativeShredSpec.variant | variant} picks, extended to fill `partition_key`, and the key followed by the
 * store's own {@linkcode NativeShredSpec.binds | binds}.
 */
export declare function storeShredProgram<Partition extends object>(spec: NativeShredSpec<Partition>, partition: Partition, key: string): {
    spec: ShredSpec | undefined;
    binds: SqlValue[];
};
/** Every variant of a store's native shred spec, extended by {@linkcode withPartitionKey}. */
export declare function partitionedShredSpec(spec: NativeShredSpec): NativeShredSpec;
//# sourceMappingURL=partitioned.d.ts.map