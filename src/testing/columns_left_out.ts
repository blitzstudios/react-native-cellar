import type { StoreTableSchema } from '../table/partitioned';
import type { RowShape } from '../table/types';

/**
 * The columns a store's fetches disagree about: for the same row, by the schema's `uniqueBy`, one fetch states the
 * column and another leaves it absent, which a write answers by keeping the stored value. Each needs a decision.
 * Keeping is right for a field that doesn't change; a field one fetch owns, whose value changes, belongs in
 * `perPartition`, or the value it brought shows through every partition. `perPartition` columns are never listed, since
 * no two partitions share them.
 *
 * Hand it the rows each fetch builds from a recorded body (its `toRows`), keyed by any name, with bodies that share
 * rows, and assert the result against the columns the store keeps on purpose, so a new fetch or column fails the test
 * until someone decides.
 */
export function columnsLeftOut<Row extends RowShape>(
  schema: Pick<StoreTableSchema<Row>, 'uniqueBy' | 'perPartition'>,
  rowsByFetch: Readonly<Record<string, ReadonlyArray<Readonly<Record<string, unknown>>>>>,
): string[] {
  const statedByRow = new Map<string, Set<string>>();
  const leftOutByRow = new Map<string, Set<string>>();
  const add = (byRow: Map<string, Set<string>>, row: string, column: string) => {
    let columns = byRow.get(row);
    if (!columns) byRow.set(row, (columns = new Set()));
    columns.add(column);
  };
  for (const rows of Object.values(rowsByFetch)) {
    for (const row of rows) {
      const identity = JSON.stringify(schema.uniqueBy.map((column) => row[column] ?? null));
      for (const [column, value] of Object.entries(row)) add(value === undefined ? leftOutByRow : statedByRow, identity, column);
    }
  }
  const scoped = new Set<string>((schema.perPartition ?? []) as readonly string[]);
  const disputed = new Set<string>();
  for (const [identity, leftOut] of leftOutByRow) {
    const stated = statedByRow.get(identity);
    for (const column of leftOut) if (stated?.has(column) && !scoped.has(column)) disputed.add(column);
  }
  return [...disputed].sort();
}
