/** Type-level tests, run by `tsc`: each `@ts-expect-error` fails typecheck if its guarantee stops holding. */

import { definePartitions } from '../../define_partitions';
import { pairRead } from '../../read/facade';
import { createTestRowTable } from '../../testing/row_table';
import { createVersionAtom } from '../../reactivity/version_atom';
import { RowTableSchema } from '../../table/types';

type Row = { region: string; cohort: string; id: string };
type Args = { region: string; cohort?: string | null; ids?: readonly string[] };

const schema: RowTableSchema<Row> = {
  table: 'rows',
  columns: { region: { type: 'TEXT' }, cohort: { type: 'TEXT' }, id: { type: 'TEXT' } },
  primaryKey: ['id'],
  entityId: 'id',
};

const rows = definePartitions<Row, { region: string }, Args>({
  name: 'select_args_probe',
  table: createTestRowTable(schema),
  version: createVersionAtom('select_args_probe_version'),
  key: { fields: ['region'], where: ({ region }) => ({ region }) },
});

/** Every arg arrives non-null, since the read runs only once each has a value — so no cast at the call. */
export const argsArrive = () =>
  rows.defineRead<Args, string>({
    select: (args) => `${args.cohort.toUpperCase()}${args.ids.join()}`,
    empty: '',
  });

/** An optional arg keeps its `undefined`, since the read runs without it. */
export const optionalArgsKeepUndefined = () =>
  rows.defineRead<Args, string, 'cohort'>({
    optionalArgs: ['cohort'],
    // @ts-expect-error `cohort` is optional, so it may be missing
    select: (args) => args.cohort.toUpperCase(),
    empty: '',
  });

/** And may be read once the read has checked for it. */
export const optionalArgsReadChecked = () =>
  rows.defineRead<Args, string, 'cohort'>({
    optionalArgs: ['cohort'],
    select: (args) => args.cohort?.toUpperCase() ?? 'all',
    empty: '',
  });

/** Naming an optional arg takes the third type argument too, which is what types it. */
export const optionalArgsNeedTheirType = () =>
  rows.defineRead<Args, string>({
    // @ts-expect-error `cohort` is not the third type argument, so the read's functions would see it non-null
    optionalArgs: ['cohort'],
    select: (args) => args.region,
    empty: '',
  });

/** The same for set reads, which are handed their keys alongside. */
export const setReadsToo = () => {
  rows.defineReadMany<Args, string>({
    partitions: (args) => [{ region: args.region }],
    select: (args, keys) => `${args.ids.length}:${keys.length}`,
    empty: '',
  });
  rows.defineReadGrouped<Args, string, 'ids'>({
    optionalArgs: ['ids'],
    groups: (args) => [[{ region: args.region }]],
    // @ts-expect-error `ids` is optional, so it may be missing
    select: (args, groups) => `${args.ids.length}:${groups.length}`,
    empty: '',
  });
};

/** A caller passes every arg the read's args type requires, each as a value it may not have yet. */
export const callersPassRequiredArgs = () => {
  const pair = pairRead(() => rows.defineRead<{ region: string; id: string }, string>({ select: (args) => args.id, empty: '' }));
  pair.getValue({ params: { region: 'us', id: null } });
  // @ts-expect-error `id` is required by the args type, so it is passed, as `null` while it isn't known
  pair.getValue({ params: { region: 'us' } });
};

/** Priming is not something a read has to speak to: it is on unless a read says otherwise. */
export const primingNeedNotBeDeclared = () =>
  rows.defineRead<Args, string>({
    select: (args) => args.region,
    empty: '',
  });

/** And `false` is available where it is wrong — a guess across candidate partitions, or a selector. */
export const primingMayBeDeclined = () =>
  rows.defineRead<Args, string>({
    prime: false,
    select: (args) => args.region,
    empty: '',
  });
