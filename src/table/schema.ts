/**
 * The DDL a store's {@linkcode RowTable.init | init} runs and the migration plan that chooses it. A live schema is
 * identified by two stamps: the whole declaration's fingerprint in `PRAGMA user_version`, and everything but its column
 * list in `PRAGMA application_id`. A table whose declaration only grew columns is widened in place; anything else is
 * rebuilt.
 */

import { cacheKey, GROUP_SEP } from '../args_key';
import { ColumnDef, columnNames, IndexDef, MetaDef, RowShape, RowTableSchema } from './types';
import { NativeShredSpec } from '../write/shred_spec';
import { readRows, SqliteConnection } from './connection';
import { reportStoreDegradation } from '../diagnostics/telemetry';
import type { RowTable } from './types';
import type { ShredSpec } from '../write/shred_spec';

/**
 * What {@linkcode RowTable.init | init} does with the table it found — build it, leave it alone, widen it, or drop and
 * rebuild it — as {@linkcode planSchemaMigration} decides.
 */
export type SchemaMigration = 'create' | 'none' | 'extend' | 'rebuild';

/** One column as `PRAGMA table_info` reports it, which is the only account of the live table's shape. */
export interface LiveColumn {
  name: string;
  type: string;
  /** SQLite's 0 or 1, not a boolean. */
  notnull: number;
}

/**
 * What {@linkcode readLiveSchema} finds on disk for {@linkcode planSchemaMigration} to weigh the declaration against.
 */
export interface LiveSchema {
  /**
   * Empty where the table does not exist, which is the whole of how {@linkcode RowTable.init | init} tells a first
   * install from an upgrade.
   */
  columns: ReadonlyArray<LiveColumn>;
  /** `PRAGMA user_version`: the built schema's {@linkcode schemaFingerprint}. */
  stamp: number;
  /**
   * `PRAGMA application_id`: its {@linkcode schemaStructureStamp}, `0` on a database built before that stamp existed.
   */
  structure: number;
}

/** 32-bit FNV-1a. `PRAGMA user_version` is a signed 32-bit int, so the stamp has to fit in one. */
function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash | 0;
}

/**
 * The shred specs' contribution to the stamp hashed into `PRAGMA user_version`. Any change to how this string is
 * built rebuilds every installed database, which for a push-fed table drops rows only a new push can restore.
 */
function shredFingerprint(nativeShredSpec?: NativeShredSpec): string {
  if (!nativeShredSpec) return '';
  return Object.keys(nativeShredSpec.specs)
    .sort()
    .map((variant) => `${variant}=${JSON.stringify(nativeShredSpec.specs[variant])}`)
    .join(GROUP_SEP);
}

/**
 * The same, with each spec's {@linkcode ShredSpec.columns | columns} and {@linkcode ShredSpec.ops | ops} left out —
 * everything that decides *which* rows a shred writes and replaces, and nothing about how many fields it fills.
 *
 * Leaving them out is what makes a widening possible at all for the store that needs it most. A spec is index-aligned
 * with the table (`columns[i]` is filled by `ops[i]`), so a schema generated from a catalog moves both together: adding
 * one metric key adds a column *and* the op that fills it. Hashing the ops here would call that structural and rebuild,
 * which is the case this whole path exists to avoid.
 *
 * The cost is the blind spot: a release that adds a column *and* repoints an op on a column it already had reads as a
 * widening, and the old values under that column stay. Alone, such an edit still rebuilds — it adds nothing, and a plan
 * with nothing to add is a rebuild. Together, it is what {@linkcode RowTableSchema.rebuildVersion | rebuildVersion} is
 * for, the same as it is for a JS row builder the stamps cannot see either.
 */
function shredStructureFingerprint(nativeShredSpec?: NativeShredSpec): string {
  if (!nativeShredSpec) return '';
  return Object.keys(nativeShredSpec.specs)
    .sort()
    .map((variant) => {
      const { columns, ops, ...structure } = nativeShredSpec.specs[variant];
      return `${variant}=${JSON.stringify(structure)}`;
    })
    .join(GROUP_SEP);
}

/** The column list's contribution to a stamp, in declaration order, which is the order an `INSERT` binds them in. */
function columnsCanonical<Row extends RowShape>(schema: RowTableSchema<Row>): string {
  return columnNames(schema)
    .map((column) => `${column}:${schema.columns[column].type}:${schema.columns[column].notNull ? 1 : 0}`)
    .join('|');
}

/**
 * Everything but the columns: the parts of a declaration that describe what the rows already on disk *mean*, rather
 * than how many fields they have. Both stamps read these from the same expressions, so the pair cannot drift; they
 * differ only in how much of the shred spec `shredPart` carries.
 */
function structureCanonical<Row extends RowShape>(schema: RowTableSchema<Row>, shredPart: string): string[] {
  // Sorted, so only a real index change moves the fingerprint.
  const indexes = (schema.indexes ?? []).map((index) => `${index.name}(${index.columns.join(',')})`).sort();
  const meta = schema.meta ? `${schema.meta.table}(${schema.meta.keyColumns.join(',')}):${schema.meta.column}` : '';
  return [`pk(${schema.primaryKey.join(',')})`, indexes.join('|'), meta, shredPart, ...(schema.partitioned ? [`rows+members${schema.newerBy ? `:${schema.newerBy}` : ''}`] : [])];
}

/**
 * The stamp identifying a built schema, hashed out of everything {@linkcode RowTable.init | init} creates, so that
 * editing a schema migrates the database rather than needing one written by hand. A change that alters what the rows
 * hold without touching the columns, key, indexes, ETag table or shred specs is invisible here — bump
 * {@linkcode RowTableSchema.rebuildVersion | schema.rebuildVersion} to force it.
 */
export function schemaFingerprint<Row extends RowShape>(schema: RowTableSchema<Row>, nativeShredSpec?: NativeShredSpec): number {
  const canonical = cacheKey(
    `r${schema.rebuildVersion ?? 0}`,
    schema.table,
    columnsCanonical(schema),
    ...structureCanonical(schema, shredFingerprint(nativeShredSpec)),
  );
  // 0 is reserved for an unstamped database, so the stamp steps past it.
  return fnv1a32(canonical) || 1;
}

/**
 * The same stamp with the columns left out — the table's and the shred spec's alike — so that comparing it against a
 * live database answers the one question {@linkcode schemaFingerprint} cannot: whether a declaration that no longer
 * matches differs *only* in the fields it holds. Masked to 31 bits, since it is stored in a `PRAGMA` slot whose
 * signedness is not worth relying on.
 */
export function schemaStructureStamp<Row extends RowShape>(schema: RowTableSchema<Row>, nativeShredSpec?: NativeShredSpec): number {
  const canonical = cacheKey(
    `r${schema.rebuildVersion ?? 0}`,
    schema.table,
    ...structureCanonical(schema, shredStructureFingerprint(nativeShredSpec)),
  );
  // 0 is reserved for a database that has never been stamped, so the stamp steps past it.
  return (fnv1a32(canonical) & 0x7fffffff) || 1;
}

/**
 * Chooses between creating, keeping, widening, and rebuilding the table.
 *
 * A widening is the cheap case worth detecting, because it is the routine one: a schema whose columns are generated
 * from a catalog — the metric keys a category publishes, say — gains a column every time that catalog does, and
 * dropping every row to add one costs a user their whole table for nothing. Anything else changes what the rows on disk
 * mean — an index they are not sorted by, a key they were not deduped on, a shred op that fills a column they already
 * have from a different path — and dropping them is the honest repair, since no `ALTER TABLE` can restate them.
 */
export function planSchemaMigration<Row extends RowShape>(
  schema: RowTableSchema<Row>,
  live: LiveSchema,
  nativeShredSpec?: NativeShredSpec,
): SchemaMigration {
  if (!live.columns.length) return 'create';
  if (live.stamp === schemaFingerprint(schema, nativeShredSpec)) return 'none';
  if (live.structure !== schemaStructureStamp(schema, nativeShredSpec)) return 'rebuild';
  return addedColumns(schema, live.columns) ? 'extend' : 'rebuild';
}

/**
 * The columns a widening would add, or `undefined` where the live table cannot be widened into the declared one:
 *
 * - a column the live table has and the declaration dropped, which a `SELECT *` would still read;
 * - one whose type or nullability moved, which restates the values already stored under it;
 * - a new column declared `NOT NULL`, which `ALTER TABLE ADD COLUMN` cannot add without a default, and which every
 *   existing row would violate anyway;
 * - nothing at all, which is a declaration that only reordered its columns — no cheaper than a rebuild to detect, and
 *   rare enough not to be worth one.
 */
export function addedColumns<Row extends RowShape>(
  schema: RowTableSchema<Row>,
  live: ReadonlyArray<LiveColumn>,
): Array<keyof Row & string> | undefined {
  const declared = columnNames(schema);
  const declaredNames = new Set<string>(declared);
  for (const column of live) if (!declaredNames.has(column.name)) return undefined;

  const liveByName = new Map(live.map((column) => [column.name, column]));
  const added: Array<keyof Row & string> = [];
  for (const name of declared) {
    const def: ColumnDef = schema.columns[name];
    const found = liveByName.get(name);
    if (!found) {
      if (def.notNull) return undefined;
      added.push(name);
    } else if (found.type.trim().toUpperCase() !== def.type || Number(found.notnull) !== (def.notNull ? 1 : 0)) {
      return undefined;
    }
  }
  return added.length ? added : undefined;
}

/**
 * The `CREATE TABLE` a store's {@linkcode RowTable.init | init} runs, spelling the columns in the
 * {@linkcode RowTableSchema.columns | columns} object's key order — the order every `INSERT` binds them in. An empty
 * {@linkcode RowTableSchema.primaryKey | primaryKey} emits no key clause, which is how a snapshot table keeps its
 * duplicates.
 */
export function createTableSql<Row extends RowShape>(schema: RowTableSchema<Row>, temporary = false): string {
  const cols = columnNames(schema).map((column) => {
    const def = schema.columns[column];
    return `  ${column} ${def.type}${def.notNull ? ' NOT NULL' : ''}`;
  });
  const lines = [...cols];
  if (schema.primaryKey.length) lines.push(`  PRIMARY KEY (${schema.primaryKey.join(', ')})`);
  return `CREATE ${temporary ? 'TEMP ' : ''}TABLE IF NOT EXISTS ${schema.table} (\n${lines.join(',\n')}\n);`;
}

/**
 * The `CREATE TABLE` for the ETag side-table beside a row table, keyed by the columns that address a partition so each
 * partition holds one ETag. {@linkcode RowTable.init | init} builds it only for a schema declaring `meta`; a store
 * without one refetches whole bodies it already has, since it has nowhere to keep the ETag that would 304 them.
 */
export function createMetaTableSql<Row extends RowShape>(meta: MetaDef<Row>, temporary = false): string {
  const keyCols = meta.keyColumns.map((column) => `  ${column} TEXT NOT NULL`);
  const recordCol = meta.recordColumn ? [`  ${meta.recordColumn} TEXT`] : [];
  const lines = [...keyCols, `  ${meta.column} TEXT`, ...recordCol, `  PRIMARY KEY (${meta.keyColumns.join(', ')})`];
  return `CREATE ${temporary ? 'TEMP ' : ''}TABLE IF NOT EXISTS ${meta.table} (\n${lines.join(',\n')}\n);`;
}

/**
 * The `CREATE INDEX` for one secondary index: run at {@linkcode RowTable.init | init}, and again by a bulk write that
 * dropped its indexes to rebuild them in a single sort. `IF NOT EXISTS` leaves an index of the same name over different
 * columns in place, so an edited index only reaches the database through the fingerprint.
 */
export const createIndexSql = <Row extends RowShape>(table: string, idx: IndexDef<Row>): string =>
  `CREATE INDEX IF NOT EXISTS ${idx.name} ON ${table} (${idx.columns.join(', ')});`;

/**
 * The drop half of that pair, for a bulk write that rebuilds its indexes afterwards rather than maintaining them row by
 * row.
 */
export const dropIndexSql = <Row extends RowShape>(idx: IndexDef<Row>): string => `DROP INDEX IF EXISTS ${idx.name};`;

/**
 * The `ALTER TABLE` a widening runs per column {@linkcode addedColumns} named. No `NOT NULL` clause is possible here
 * and none is needed: SQLite refuses to add such a column without a default, which is why {@linkcode addedColumns}
 * rejects one.
 */
export const addColumnSql = <Row extends RowShape>(schema: RowTableSchema<Row>, column: keyof Row & string): string =>
  `ALTER TABLE ${schema.table} ADD COLUMN ${column} ${schema.columns[column].type};`;

/**
 * Reads a live database's schema stamp, `0` where nothing has stamped one, for {@linkcode RowTable.init | init} to
 * weigh against {@linkcode schemaFingerprint}.
 */
export function readUserVersion(conn: SqliteConnection): number {
  const rows = readRows<{ user_version?: number }>(conn, 'PRAGMA user_version;');
  return rows[0]?.user_version ?? 0;
}

/**
 * Its companion, `0` on every database built before this stamp existed, which is what makes such a table rebuild once.
 */
export function readApplicationId(conn: SqliteConnection): number {
  const rows = readRows<{ application_id?: number }>(conn, 'PRAGMA application_id;');
  return rows[0]?.application_id ?? 0;
}

/** Everything {@linkcode RowTable.init | init} plans from, in the three PRAGMA reads it takes to find it. */
export function readLiveSchema(conn: SqliteConnection, table: string): LiveSchema {
  const rows = readRows<{ name?: string; type?: string; notnull?: number | string }>(conn, `PRAGMA table_info(${table});`);
  return {
    columns: rows
      .filter((row): row is { name: string; type?: string; notnull?: number | string } => typeof row.name === 'string')
      .map((row) => ({ name: row.name, type: String(row.type ?? ''), notnull: Number(row.notnull ?? 0) })),
    stamp: readUserVersion(conn),
    structure: readApplicationId(conn),
  };
}

/**
 * A trickle is enough: this fires once per install behind a schema change, so a release wave reports the same expected
 * event from every device that upgrades.
 */
const SCHEMA_REBUILD_SAMPLE_RATE = 0.001;

/**
 * Notes that a rebuild emptied a push-fed table, whose rows a fetch refills except for the pushes that arrived since
 * the last one. That is a consequence of shipping a schema change rather than a malfunction, so it reports as a sampled
 * notice rather than an error, beside the failures that genuinely took a store off SQLite.
 *
 * It deliberately does not throw, in `__DEV__` or anywhere else. {@linkcode RowTable.init | init} stamps the schema
 * last, so refusing the rebuild would leave the stale stamp on disk and fail the same way on every launch after, over
 * an expected event. Catching the edit belongs where the edit happens: a store pins its column set in a test, which is
 * what fails when the schema widens.
 */
export function reportPushFedRebuild(table: string): void {
  reportStoreDegradation({
    scope: `${table}.schema_rebuild`,
    context:
      'a schema change rebuilt a push-fed table: a fetch refills its rows, but pushes that arrived since the last fetch are gone. ' +
      'Where a change can be spelled as new columns it widens the table in place instead, and costs nothing',
    severity: 'info',
    sampleRate: SCHEMA_REBUILD_SAMPLE_RATE,
  });
}

// Exported so the built declaration files keep these names in scope for the doc links above; an import that only a
// doc comment uses is dropped from them.
export type { RowTable, RowTableSchema, ShredSpec };
