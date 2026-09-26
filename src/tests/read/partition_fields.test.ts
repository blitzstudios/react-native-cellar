import { partitionKeyOf } from '../../read/partition_fields';

type ScheduleArgs = { region: string; year: string; itemType: string; cohort: string };
type CatalogKey = { region: string; year: string; itemType: string };

const ARGS: ScheduleArgs = { region: 'us', year: '2025', itemType: 'regular', cohort: 'SF' };

describe('partitionKeyOf', () => {
  it('picks one field into the key it spells, the common case', () => {
    expect(partitionKeyOf<ScheduleArgs, { region: string }>(['region'])(ARGS)).toEqual({ region: 'us' });
  });

  it('picks several, dropping the args the partition is not named by', () => {
    expect(partitionKeyOf<ScheduleArgs, CatalogKey>(['region', 'year', 'itemType'])(ARGS)).toEqual({
      region: 'us',
      year: '2025',
      itemType: 'regular',
    });
  });

  it('is order-independent, since the key is an object and only `toParts` puts it in an order', () => {
    const declared = partitionKeyOf<ScheduleArgs, CatalogKey>(['itemType', 'region', 'year'])(ARGS);
    expect(declared).toEqual(partitionKeyOf<ScheduleArgs, CatalogKey>(['region', 'year', 'itemType'])(ARGS));
  });

  it('passes a function through untouched, so a partition that must be registered still can be', () => {
    const compute = (args: ScheduleArgs): string => `registered:${args.region}`;
    expect(partitionKeyOf<ScheduleArgs, string>(compute)).toBe(compute);
  });

  it('returns a fresh key per call, so a caller may keep or mutate it', () => {
    const keyOf = partitionKeyOf<ScheduleArgs, { region: string }>(['region']);
    expect(keyOf(ARGS)).not.toBe(keyOf(ARGS));
  });
});
