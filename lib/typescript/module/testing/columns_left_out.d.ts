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
export declare function columnsLeftOut<Row extends RowShape>(schema: Pick<StoreTableSchema<Row>, 'uniqueBy' | 'perPartition'>, rowsByFetch: Readonly<Record<string, ReadonlyArray<Readonly<Record<string, unknown>>>>>): string[];
//# sourceMappingURL=columns_left_out.d.ts.map