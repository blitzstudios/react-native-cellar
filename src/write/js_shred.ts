/**
 * A native shred run in JS: the statements a {@linkcode ShredCommand} writes, with the body parsed and each element's
 * row built by the spec's reference interpreter. What a connection without the C++ shred runs: sql.js in tests, and the
 * Node writer, off the main thread.
 */

import { evalShredSpec } from './shred_spec';
import type { ShredSpec } from './shred_spec';
import type { BatchCommand, ShredCommand } from '../table/connection';
import type { SqlValue } from '../table/types';

function shredStatements(spec: ShredSpec, rows: ReadonlyArray<Record<string, SqlValue | undefined>>, binds: ReadonlyArray<SqlValue>): BatchCommand[] {
  const commands: BatchCommand[] = [];
  const deleteWhere = spec.deleteWhere ?? [];
  if (deleteWhere.length) {
    const where = deleteWhere.map((column) => `${column.column} = ?`).join(' AND ');
    commands.push([`DELETE FROM ${spec.table} WHERE ${where};`, deleteWhere.map((column) => binds[column.bindIndex] ?? null)]);
  }
  const placeholders = spec.columns.map(() => '?').join(', ');
  const insert = `${spec.insertVerb} INTO ${spec.table} (${spec.columns.join(', ')}) VALUES (${placeholders});`;
  for (const row of rows) commands.push([insert, spec.columns.map((column) => row[column] ?? null)]);
  return commands;
}

/** The statements one shred command runs: its delete, then one insert per element of the body. */
export function shredCommandStatements({ shred: spec, rawJson, binds }: ShredCommand): BatchCommand[] {
  const parsed = JSON.parse(rawJson) as unknown;
  const elements = spec.source === 'objectValues' ? Object.values(parsed as Record<string, unknown>) : (parsed as unknown[]);
  return shredStatements(spec, evalShredSpec(spec, elements, binds), binds);
}
