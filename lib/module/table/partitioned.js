"use strict";

/**
 * The `partition_key` column every store's table carries: what {@linkcode defineSqliteStore} adds to a store's schema,
 * and how the native shred specs are extended to fill it.
 */

/** The column naming the partition each row belongs to. */
export const PARTITION_KEY_COLUMN = 'partition_key';

/** The ETag table's column holding each partition's description as JSON. */
export const PARTITION_RECORD_COLUMN = 'partition';

/** The column a store's rows carry for its partition: its key. */

/**
 * A store's table as the store declares it: its own columns, primary key and indexes, without the `partition_key`
 * column or the ETag table, which {@linkcode defineSqliteStore} adds. An index may lead with `partition_key`, as one
 * serving a read within a partition does.
 */

const PARTITION_KEY_DEF = {
  type: 'TEXT',
  notNull: true
};

/**
 * The full schema of a store's table: `partition_key` as the first column, the primary key led by it (unless the rows
 * have none), an index on it and the entity id, and an ETag table keyed by it that also keeps each partition's
 * description.
 */
export function partitionedSchema(schema) {
  const {
    table,
    columns,
    primaryKey,
    entityId,
    indexes,
    ...rest
  } = schema;
  return {
    table,
    columns: {
      [PARTITION_KEY_COLUMN]: PARTITION_KEY_DEF,
      ...columns
    },
    primaryKey: primaryKey.length ? [PARTITION_KEY_COLUMN, ...primaryKey] : [],
    entityId,
    indexes: [{
      name: `idx_${table}_partition`,
      columns: [PARTITION_KEY_COLUMN, entityId]
    }, ...(indexes ?? [])],
    meta: {
      table: `${table}_meta`,
      keyColumns: [PARTITION_KEY_COLUMN],
      column: 'etag',
      recordColumn: PARTITION_RECORD_COLUMN
    },
    ...rest,
    partitioned: true
  };
}

/**
 * A store's shred spec extended to fill `partition_key` from bind 0 and to replace the rows by it. The keys keep the
 * order a spec is written in, since the specs' JSON is part of the table's schema stamp.
 */
function withPartitionKey(spec) {
  const {
    version,
    table,
    insertVerb,
    source,
    columns,
    ops,
    deleteWhere: _deleteWhere,
    whereGuard,
    ...rest
  } = spec;
  return {
    version,
    table,
    insertVerb,
    ...(source ? {
      source
    } : {}),
    columns: [PARTITION_KEY_COLUMN, ...columns],
    ops: [{
      op: 'bind',
      index: 0
    }, ...ops],
    deleteWhere: [{
      column: PARTITION_KEY_COLUMN,
      bindIndex: 0
    }],
    ...(whereGuard ? {
      whereGuard
    } : {}),
    ...rest
  };
}

/**
 * The program and binds the native shredder is handed for one partition of a store: the variant
 * {@linkcode NativeShredSpec.variant | variant} picks, extended to fill `partition_key`, and the key followed by the
 * store's own {@linkcode NativeShredSpec.binds | binds}.
 */
export function storeShredProgram(spec, partition, key) {
  const own = spec.specs[spec.variant(partition)];
  return {
    spec: own && withPartitionKey(own),
    binds: [key, ...spec.binds(partition)]
  };
}

/** Every variant of a store's native shred spec, extended by {@linkcode withPartitionKey}. */
export function partitionedShredSpec(spec) {
  const specs = {};
  for (const variant of Object.keys(spec.specs)) specs[variant] = withPartitionKey(spec.specs[variant]);
  return {
    ...spec,
    specs
  };
}
//# sourceMappingURL=partitioned.js.map