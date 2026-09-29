/** Type-level tests, run by `tsc`: each `@ts-expect-error` fails typecheck if its guarantee stops holding. */

import { definePartitions } from '../define_partitions';
import { createTestRowTable } from '../testing/row_table';
import { createVersionAtom } from '../reactivity/version_atom';
import { RowTableSchema } from '../table/types';

type Row = { region: string; id: string };

const schema: RowTableSchema<Row> = { table: 'rows', columns: { region: { type: 'TEXT' }, id: { type: 'TEXT' } }, primaryKey: ['id'], entityId: 'id' };
const table = createTestRowTable(schema);
const version = createVersionAtom('probe_version');

const byFields = definePartitions<Row, { region: string }>({
  name: 'by_fields',
  table,
  version,
  key: { fields: ['region'], where: ({ region }) => ({ region }) },
});

type Locator = { locator: { region: string; week: number } };

const byRecord = definePartitions<Row, string, Locator, { region: string; week: number }>({
  name: 'by_record',
  table,
  version,
  key: { of: (args) => args.locator, id: (part) => `${part.region}:${part.week}`, where: (key) => ({ region: key }) },
});

/** A key spelled by fields takes the fields a caller has so far, as its reads do. */
export const looseFields = () => {
  byFields.lifecycle.usePrime({ region: undefined });
  byFields.lifecycle.usePrime({ region: null });
};

/** A key computed from a record takes the record a caller has so far, which `key.of` answers `null` for. */
export const looseRecord = () => {
  byRecord.lifecycle.usePrime({ locator: { region: 'us', week: 1 } });
  byRecord.lifecycle.usePrime({ locator: undefined });
  byRecord.lifecycle.usePrime(undefined);
};

/** Loose reaches the args' own fields, not through them: a record short of a field `key.of` reads is a mistake. */
export const strictWithinTheRecord = () => {
  // @ts-expect-error `week` is one of the fields this partition is addressed by
  byRecord.lifecycle.usePrime({ locator: { region: 'us' } });
};
