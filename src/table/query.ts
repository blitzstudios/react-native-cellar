/** The `where` and ordering predicates a row table reads with: the SQL a filter becomes, and the JS a read sorts by. */

import { RowShape, RowTableSchema, SqlValue } from './types';
import type { FindOpts, RowTable } from './types';

/**
 * Builds a row filter's `WHERE` clause and its binds; an absent value becomes `IS NULL`, the spelling SQL matches on.
 */
export function whereClause(where: Partial<RowShape>): { sql: string; params: SqlValue[] } {
  const keys = Object.keys(where);
  if (!keys.length) return { sql: '', params: [] };
  const clauses: string[] = [];
  const params: SqlValue[] = [];
  for (const key of keys) {
    const value = where[key];
    if (value == null) {
      clauses.push(`${key} IS NULL`);
    } else {
      clauses.push(`${key} = ?`);
      params.push(value);
    }
  }
  return { sql: ` WHERE ${clauses.join(' AND ')}`, params };
}

/**
 * Whether one row satisfies `where`, by the rule {@linkcode whereClause} writes in SQL; the dev check below uses it.
 */
export function matchesWhere<Row extends RowShape>(row: Row, where: Partial<Row>): boolean {
  for (const key of Object.keys(where)) {
    const wanted = where[key as keyof Row];
    const actual = row[key as keyof Row];
    if (wanted == null ? actual != null : actual !== wanted) return false;
  }
  return true;
}

/** Dev-only: the declared entity has to be one of the table's columns, since every write groups its rows by it. */
export function assertEntityIdColumn<Row extends RowShape>(schema: RowTableSchema<Row>): void {
  if (!(schema.entityId in schema.columns)) {
    throw new Error(`row_table: \`${schema.table}\` declares entityId \`${String(schema.entityId)}\`, which is not one of its columns.`);
  }
}

/**
 * Dev-only: every row written under a filter must satisfy it. A row that doesn't lands outside the slice its own write
 * just cleared, where the next write to that slice cannot reach it and no {@linkcode RowTable.find | find} for it
 * expects it.
 */
export function assertRowsMatchWhere<Row extends RowShape>(table: string, where: Partial<Row>, rows: readonly Row[]): void {
  for (const row of rows) {
    if (!matchesWhere(row, where)) {
      const wrong = Object.keys(where)
        .filter((column) => !matchesWhere(row, { [column]: where[column as keyof Row] } as Partial<Row>))
        .map((column) => `\`${column}\` is ${JSON.stringify(row[column as keyof Row])}, not ${JSON.stringify(where[column as keyof Row])}`);
      throw new Error(`row_table: a row written into \`${table}\` does not match the filter it replaced — ${wrong.join(', ')}.`);
    }
  }
}

/**
 * The ordering behind {@linkcode FindOpts.orderBy}, run in JS after the read so the order does not depend on the SQLite
 * build that served it. A column holding numbers sorts numerically, and everything else compares as a string.
 */
export function comparator<Row extends RowShape>(orderBy: keyof Row & string): (left: Row, right: Row) => number {
  return (left, right) => {
    const leftValue = left[orderBy];
    const rightValue = right[orderBy];
    if (typeof leftValue === 'number' || typeof rightValue === 'number') {
      return (typeof leftValue === 'number' ? leftValue : 0) - (typeof rightValue === 'number' ? rightValue : 0);
    }
    const leftText = String(leftValue ?? '');
    const rightText = String(rightValue ?? '');
    if (leftText === rightText) return 0;
    return leftText < rightText ? -1 : 1;
  };
}

// Exported so the built declaration files keep these names in scope for the doc links above; an import that only a
// doc comment uses is dropped from them.
export type { FindOpts, RowTable };
