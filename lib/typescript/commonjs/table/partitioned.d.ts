/**
 * The `partition_key` column every store's table carries: what {@linkcode defineSqliteStore} adds to a store's schema,
 * and how the native shred specs are extended to fill it.
 */
import type { NativeShredSpec, ShredSpec } from '../write/shred_spec';
import type { RowShape, RowTableSchema, SqlValue } from './types';
/** The column naming the partition each row belongs to. */
export declare const PARTITION_KEY_COLUMN = "partition_key";
/** The ETag table's column holding each partition's description as JSON. */
export declare const PARTITION_RECORD_COLUMN = "partition";
/** The column a store's rows carry for its partition: its key. */
export type PartitionKeyColumn = {
    partition_key: string;
};
/**
 * A store's table as the store declares it: the rows it stores in `<table>__rows`, each once. Their columns, what
 * makes a row unique, and the indexes on that table. {@linkcode defineSqliteStore} adds the rest: the membership
 * table, the view under `table` with each row's `partition_key`, an index on `entityId`, and the ETag table.
 */
export type StoreTableSchema<Row extends RowShape> = Omit<RowTableSchema<Row>, 'table' | 'meta' | 'partitioned' | 'primaryKey'> & {
    /**
     * The store's name in SQLite, such as `players`. It names the view that reads and store SQL query, `players`, and
     * the tables under it: `players__rows`, holding each row once; `players__members`, naming each partition's rows; and
     * `players_meta`, holding each partition's ETag. Renaming it starts the store over with new, empty tables.
     */
    table: string;
    /**
     * The columns whose values together make a row unique across the store, such as `['sport', 'player_id']`: two rows
     * with the same values are the same row, stored once, whichever fetches or pushes bring it and however many
     * partitions hold it. A write updates the stored row in place, and a change reaches the readers of every partition
     * holding it. Null values match each other.
     *
     * Too few columns merge different rows, such as one player's lines from two seasons; too many store one row twice,
     * and a change to one copy doesn't reach the readers of the other.
     */
    uniqueBy: ReadonlyArray<keyof Row & string>;
    /**
     * The columns each partition keeps its own value of, stored with its membership in `<table>__members` rather than
     * once in `<table>__rows`. Use it for a field one fetch owns and others never send, whose value changes, such as an
     * injury status only a player's detail carries: the detail's partition shows it and the catalog's keeps its own, and
     * neither write touches the other's. Also for a value that depends on the partition, such as a team per competition.
     * A change to one bumps only its partition. It can't be part of `uniqueBy`, an index, `entityId` or `newerBy`, or
     * `NOT NULL`.
     */
    perPartition?: ReadonlyArray<keyof Row & string>;
};
/**
 * The full schema of a store's table: `partition_key` as the first column, a primary key of it and `uniqueBy` (unless
 * that is empty), an index on the entity id, and an ETag table keyed by it that also keeps each partition's
 * description.
 */
export declare function partitionedSchema<Row extends RowShape>(schema: StoreTableSchema<Row>): RowTableSchema<Row & PartitionKeyColumn>;
/** The shred spec a partition fetch picks from its store, and its binds from index 1. */
export type NativeShredChoice = {
    variant: string;
    binds?: readonly SqlValue[];
};
/** A store's specs as the row table takes them. */
export declare function nativeSpecOf(specs: Readonly<Record<string, ShredSpec>> | undefined): NativeShredSpec | undefined;
/** The spec `choice` names, extended to fill `partition_key`, and its binds after the partition's key. */
export declare function storeShredSpec(specs: Readonly<Record<string, ShredSpec>>, choice: NativeShredChoice, key: string): {
    spec: ShredSpec | undefined;
    binds: SqlValue[];
};
/** Every variant of a store's native shred spec, extended by {@linkcode withPartitionKey}. */
export declare function partitionedShredSpec(spec: NativeShredSpec): NativeShredSpec;
//# sourceMappingURL=partitioned.d.ts.map