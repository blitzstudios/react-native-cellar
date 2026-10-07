/**
 * The `partition_key` column every store's table carries: what {@linkcode defineSqliteStore} adds to a store's schema,
 * and how the native shred specs are extended to fill it.
 */

import type { defineSqliteStore } from '../define_sqlite_store';
import type { NativeShredSpec, ShredSpec } from '../write/shred_spec';
import type { ColumnDef, IndexDef, RowShape, RowTableSchema, SqlValue } from './types';

/** The column naming the partition each row belongs to. */
export const PARTITION_KEY_COLUMN = 'partition_key';

/** The ETag table's column holding each partition's description as JSON. */
export const PARTITION_RECORD_COLUMN = 'partition';

/** The column a store's rows carry for its partition: its key. */
export type PartitionKeyColumn = { partition_key: string };

/**
 * A store's table as the store declares it: its own columns, primary key and indexes, without the `partition_key`
 * column or the ETag table, which {@linkcode defineSqliteStore} adds. An index may lead with `partition_key`, as one
 * serving a read within a partition does.
 */
export type StoreTableSchema<Row extends RowShape> = Omit<RowTableSchema<Row>, 'meta' | 'partitioned' | 'indexes'> & {
  /** The table's secondary indexes: {@linkcode RowTableSchema.indexes}. */
  indexes?: ReadonlyArray<IndexDef<Row & PartitionKeyColumn>>;
};

const PARTITION_KEY_DEF: ColumnDef = { type: 'TEXT', notNull: true };

/**
 * The full schema of a store's table: `partition_key` as the first column, the primary key led by it (unless the rows
 * have none), an index on it and the entity id, and an ETag table keyed by it that also keeps each partition's
 * description.
 */
export function partitionedSchema<Row extends RowShape>(schema: StoreTableSchema<Row>): RowTableSchema<Row & PartitionKeyColumn> {
  const { table, columns, primaryKey, entityId, indexes, ...rest } = schema;
  return {
    table,
    columns: { [PARTITION_KEY_COLUMN]: PARTITION_KEY_DEF, ...columns } as RowTableSchema<Row & PartitionKeyColumn>['columns'],
    primaryKey: (primaryKey.length ? [PARTITION_KEY_COLUMN, ...primaryKey] : []) as RowTableSchema<Row & PartitionKeyColumn>['primaryKey'],
    entityId,
    indexes: [{ name: `idx_${table}_partition`, columns: [PARTITION_KEY_COLUMN, entityId] }, ...(indexes ?? [])] as RowTableSchema<
      Row & PartitionKeyColumn
    >['indexes'],
    meta: { table: `${table}_meta`, keyColumns: [PARTITION_KEY_COLUMN], column: 'etag', recordColumn: PARTITION_RECORD_COLUMN },
    ...rest,
    partitioned: true,
  };
}

/**
 * A store's shred spec extended to fill `partition_key` from bind 0 and to replace the rows by it. The keys keep the
 * order a spec is written in, since the specs' JSON is part of the table's schema stamp.
 */
function withPartitionKey(spec: ShredSpec): ShredSpec {
  const { version, table, insertVerb, source, columns, ops, deleteWhere: _deleteWhere, whereGuard, ...rest } = spec;
  return {
    version,
    table,
    insertVerb,
    ...(source ? { source } : {}),
    columns: [PARTITION_KEY_COLUMN, ...columns],
    ops: [{ op: 'bind', index: 0 }, ...ops],
    deleteWhere: [{ column: PARTITION_KEY_COLUMN, bindIndex: 0 }],
    ...(whereGuard ? { whereGuard } : {}),
    ...rest,
  };
}

/** The shred spec a partition fetch picks from its store, and its binds from index 1. */
export type NativeShredChoice = { variant: string; binds?: readonly SqlValue[] };

/** A store's specs as the row table takes them. */
export function nativeSpecOf(specs: Readonly<Record<string, ShredSpec>> | undefined): NativeShredSpec | undefined {
  if (!specs) return undefined;
  return {
    specs,
    variant: (choice) => String((choice as NativeShredChoice).variant),
    binds: (choice) => [...((choice as NativeShredChoice).binds ?? [])],
  };
}

/** The spec `choice` names, extended to fill `partition_key`, and its binds after the partition's key. */
export function storeShredSpec(
  specs: Readonly<Record<string, ShredSpec>>,
  choice: NativeShredChoice,
  key: string,
): { spec: ShredSpec | undefined; binds: SqlValue[] } {
  const own = specs[choice.variant];
  return { spec: own && withPartitionKey(own), binds: [key, ...(choice.binds ?? [])] };
}

/** Every variant of a store's native shred spec, extended by {@linkcode withPartitionKey}. */
export function partitionedShredSpec(spec: NativeShredSpec): NativeShredSpec {
  const specs: Record<string, ShredSpec> = {};
  for (const variant of Object.keys(spec.specs)) specs[variant] = withPartitionKey(spec.specs[variant]);
  return { ...spec, specs };
}
