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
 * A store's table as the store declares it: the rows it stores in `<table>__rows`, each once. Their columns, what
 * makes a row unique, and the indexes on that table. {@linkcode defineSqliteStore} adds the rest: the membership
 * table, the view under `table` with each row's `partition_key`, an index on `entityId`, and the ETag table.
 */

const PARTITION_KEY_DEF = {
  type: 'TEXT',
  notNull: true
};

/**
 * The full schema of a store's table: `partition_key` as the first column, a primary key of it and `uniqueBy` (unless
 * that is empty), an index on the entity id, and an ETag table keyed by it that also keeps each partition's
 * description.
 */
export function partitionedSchema(schema) {
  const {
    table,
    columns,
    uniqueBy,
    entityId,
    indexes,
    ...rest
  } = schema;
  const all = [{
    name: `idx_${table}_entity`,
    columns: [entityId]
  }, ...(indexes ?? [])];
  const unique = all.filter((index, at) => all.findIndex(other => other.columns.join() === index.columns.join()) === at);
  return {
    table,
    columns: {
      [PARTITION_KEY_COLUMN]: PARTITION_KEY_DEF,
      ...columns
    },
    primaryKey: uniqueBy.length ? [PARTITION_KEY_COLUMN, ...uniqueBy] : [],
    entityId,
    indexes: unique,
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

/** The shred spec a partition fetch picks from its store, and its binds from index 1. */

/** A store's specs as the row table takes them. */
export function nativeSpecOf(specs) {
  if (!specs) return undefined;
  return {
    specs,
    variant: choice => String(choice.variant),
    binds: choice => [...(choice.binds ?? [])]
  };
}

/** The spec `choice` names, extended to fill `partition_key`, and its binds after the partition's key. */
export function storeShredSpec(specs, choice, key) {
  const own = specs[choice.variant];
  return {
    spec: own && withPartitionKey(own),
    binds: [key, ...(choice.binds ?? [])]
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