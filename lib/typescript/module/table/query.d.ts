/** The `where` and ordering predicates a row table reads with: the SQL a filter becomes, and the JS a read sorts by. */
import { RowShape, RowTableSchema, SqlValue } from './types';
import type { FindOpts, RowTable } from './types';
/**
 * Builds a row filter's `WHERE` clause and its binds; an absent value becomes `IS NULL`, the spelling SQL matches on.
 */
export declare function whereClause(where: Partial<RowShape>): {
    sql: string;
    params: SqlValue[];
};
/**
 * Whether one row satisfies `where`, by the rule {@linkcode whereClause} writes in SQL; the dev check below uses it.
 */
export declare function matchesWhere<Row extends RowShape>(row: Row, where: Partial<Row>): boolean;
/** Dev-only: the declared entity has to be one of the table's columns, since every write groups its rows by it. */
export declare function assertEntityIdColumn<Row extends RowShape>(schema: RowTableSchema<Row>): void;
/**
 * Dev-only: every row written under a filter must satisfy it. A row that doesn't lands outside the slice its own write
 * just cleared, where the next write to that slice cannot reach it and no {@linkcode RowTable.find | find} for it
 * expects it.
 */
export declare function assertRowsMatchWhere<Row extends RowShape>(table: string, where: Partial<Row>, rows: readonly Row[]): void;
/**
 * The ordering behind {@linkcode FindOpts.orderBy}, run in JS after the read so the order does not depend on the SQLite
 * build that served it. A column holding numbers sorts numerically, and everything else compares as a string.
 */
export declare function comparator<Row extends RowShape>(orderBy: keyof Row & string): (left: Row, right: Row) => number;
export type { FindOpts, RowTable };
//# sourceMappingURL=query.d.ts.map