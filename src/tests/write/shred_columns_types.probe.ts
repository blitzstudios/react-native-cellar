/** Type-level tests, run by `tsc`: each `@ts-expect-error` fails typecheck if its guarantee stops holding. */

import { ColumnDef, RowTableSchema } from '../../table/types';
import { defineShredColumns, RowOf, ShredColumn } from '../../write/shred_columns';
import { ShredOp } from '../../write/shred_spec';

/** `meta` is untyped on purpose: it is what makes an unannotated builder's return type `any`. */
type Event = { week: number; cohort: string; meta: any };

const COLUMNS = [
  { name: 'week', type: 'INTEGER', js: (event: Event) => event.week },
  { name: 'cohort', type: 'TEXT', notNull: true, js: (event: Event): string => event.cohort },
] as const satisfies readonly ShredColumn<Event>[];

type Row = RowOf<typeof COLUMNS>;

export const row: Row = { week: 1, cohort: 'SF' };

// @ts-expect-error `week`'s builder returns a number, so the row's field is a number too
export const wrongType: Row = { week: '1', cohort: 'SF' };

// @ts-expect-error a column the table does not declare is not a field of the row
export const notAColumn: string = row.opponent;

const UNANNOTATED = [{ name: 'note', type: 'TEXT', js: (event: Event) => event.meta.note }] as const satisfies readonly ShredColumn<Event>[];

declare const note: RowOf<typeof UNANNOTATED>['note'];

// @ts-expect-error `any` would have been assignable to anything here, which is the bug; the message type is not
export const unannotated: number = note;

const shred = defineShredColumns<Event>()(COLUMNS);

export const columns: RowTableSchema<Row>['columns'] = shred.columnDefs;

// @ts-expect-error a name the table does not declare has no def, rather than an `any` one
export const notADef: ColumnDef = shred.columnDefs.opponent;

/** The point of binding the columns: a built row is typed as the row they describe, so no ingest asserts its own. */
export const built: Row = shred.row({ week: 1, cohort: 'SF', meta: null });

// @ts-expect-error the row a bound table builds is not an untyped bag of columns
export const builtWrong: number = shred.row({ week: 1, cohort: 'SF', meta: null }).cohort;

/**
 * A table one column short of a native shred offers neither op member, so the store that would have got an exception
 * gets a compile error instead. `COLUMNS` above declares no `op` at all, which is `schedule`'s case.
 */
// @ts-expect-error a table whose columns do not all declare an `op` cannot bind a native shred
export const opsWithoutOps = shred.ops;

// @ts-expect-error and neither can it name them
export const namedOpsWithoutOps = shred.namedOps;

const SHREDDABLE = [
  { name: 'week', type: 'INTEGER', js: (event: Event) => event.week, op: { op: 'int', path: 'week' } },
  { name: 'cohort', type: 'TEXT', notNull: true, js: (event: Event): string => event.cohort, op: { op: 'text', path: 'cohort' } },
] as const satisfies readonly ShredColumn<Event>[];

const shreddable = defineShredColumns<Event>()(SHREDDABLE);

/** Once every column carries one, both are plain members — the same access as every other thing the table derives. */
export const ops: ShredOp[] = shreddable.ops;
export const namedOps: { name: string; op: ShredOp }[] = shreddable.namedOps;

const PARTLY_SHREDDABLE = [
  { name: 'week', type: 'INTEGER', js: (event: Event) => event.week, op: { op: 'int', path: 'week' } },
  { name: 'cohort', type: 'TEXT', notNull: true, js: (event: Event): string => event.cohort },
] as const satisfies readonly ShredColumn<Event>[];

const partly = defineShredColumns<Event>()(PARTLY_SHREDDABLE);

// @ts-expect-error one column short is still short: a bind order that skipped it would not match the columns
export const partialOps = partly.ops;

type Player = { team?: string | null; stats?: { rec?: number }; player_id?: string; active?: boolean };

/** A column an op can say leaves the builder out, and its field is typed by what the op stores. */
const OP_ONLY = [
  { name: 'player_id', type: 'TEXT', notNull: true, op: { op: 'coalesceText', paths: ['player_id'], emptyDefault: true } },
  { name: 'team', type: 'TEXT', op: { op: 'text', path: 'team' } },
  { name: 'rec', type: 'REAL', op: { op: 'real0', path: 'stats.rec' } },
  { name: 'active', type: 'INTEGER', op: { op: 'boolInt', path: 'active' } },
  { name: 'label', type: 'TEXT', js: (player: Player): string => `${player.team}`, op: { op: 'text', path: 'team' } },
] as const satisfies readonly ShredColumn<Player>[];

type OpRow = RowOf<typeof OP_ONLY>;

export const opRow: OpRow = { player_id: '1', team: null, rec: 0, active: 1, label: 'SF' };

// @ts-expect-error `coalesceText` with an empty default always stores a string
export const opIdNull: OpRow['player_id'] = null;

// @ts-expect-error `real0` stores 0 for a missing value, never null
export const opRecNull: OpRow['rec'] = null;

// @ts-expect-error `boolInt` stores a flag as 1 or 0
export const opActiveTwo: OpRow['active'] = 2;

/** Every column carries an op, whether or not it also has a builder, so the table binds a native shred. */
export const opOnlyOps: ShredOp[] = defineShredColumns<Player>()(OP_ONLY).ops;

// @ts-expect-error a `bind` op reads a value only the native write is handed, so the column needs a builder
export const bindWithoutBuilder: ShredColumn<Player> = { name: 'league', type: 'TEXT', op: { op: 'bind', index: 0 } };

// @ts-expect-error and so does a `coalesceText` that falls back to a bind
export const fallbackWithoutBuilder: ShredColumn<Player> = { name: 'sport', type: 'TEXT', op: { op: 'coalesceText', paths: ['sport'], fallbackBindIndex: 0 } };

// @ts-expect-error a column says how its value is computed one way or the other
export const neither: ShredColumn<Player> = { name: 'team', type: 'TEXT' };
