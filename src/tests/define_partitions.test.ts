import { installTestRuntime } from '../testing/runtime';
import { createTestRowTable } from '../testing/row_table';
import { RowTable, RowTableSchema } from '../table/types';
import { createVersionAtom } from '../reactivity/version_atom';
import { definePartitions } from '../define_partitions';
import { reportStoreDegradation } from '../diagnostics/telemetry';
import { ALL_ENTITIES, ChangeSet, NO_CHANGES } from '../table/change_set';

jest.mock('../diagnostics/telemetry', () => ({ reportStoreDegradation: jest.fn() }));

const invalidateMock = installTestRuntime().invalidateQueries;
const degradeMock = reportStoreDegradation as jest.Mock;

type EventRow = { region: string; year: string; item_type: string; event_id: string };
type EventKey = { region: string; year: string; itemType: string };

const SCHEMA: RowTableSchema<EventRow> = {
  table: 'events',
  columns: {
    region: { type: 'TEXT' },
    year: { type: 'TEXT' },
    item_type: { type: 'TEXT' },
    event_id: { type: 'TEXT' },
  },
  primaryKey: ['region', 'year', 'item_type', 'event_id'],
  entityId: 'event_id',
  meta: { table: 'events_meta', keyColumns: ['region', 'year', 'item_type'], column: 'etag' },
};

const US: EventKey = { region: 'us', year: '2025', itemType: 'regular' };
const OTHER: EventKey = { ...US, year: '2024' };

function makeEvents(over: { table?: RowTable<EventRow>; toRows?: (key: EventKey, raw: string) => EventRow[]; body?: string; internMax?: number } = {}) {
  const table = over.table ?? createTestRowTable(SCHEMA);
  table.init();
  const version = createVersionAtom('define_partitions_test');
  const changed: { key: EventKey; version: number }[] = [];
  const changedEntities: ChangeSet[] = [];
  const body = over.body ?? '["g1","g2"]';
  // Typed loosely: the assertions below inspect the arity of each call, which a tuple type hides.
  const query = jest.fn((..._args: unknown[]) => ({ queryFn: async () => ({ data: body, etag: 'W/"v1"' }) }));

  const events = definePartitions<EventRow, EventKey>({
    name: 'events',
    table,
    version,
    key: {
      fields: ['region', 'year', 'itemType'],
      where: ({ region, year, itemType }) => ({ region, year, item_type: itemType }),
    },
    fetch: {
      query,
      toRows:
        over.toRows ??
        ((key, raw) => (JSON.parse(raw) as string[]).map((id) => ({ region: key.region, year: key.year, item_type: key.itemType, event_id: id }))),
    },
    onChanged: (key, version, changes) => {
      changed.push({ key, version });
      changedEntities.push(changes);
    },
    internMax: over.internMax,
  });

  return { events, table, version, changed, changedEntities, query };
}

beforeEach(() => {
  invalidateMock.mockClear();
  degradeMock.mockClear();
});

describe('definePartitions — `key.where` is the one fact the rest is derived from', () => {
  it('keeps the ETag under the partition it belongs to, so a second partition still fetches cold', async () => {
    const harness = makeEvents();

    await harness.events.lifecycle.fetch(US);

    expect(harness.table.getMeta({ region: 'us', year: '2025', item_type: 'regular' })).toBe('W/"v1"');
    expect(harness.table.getMeta({ region: 'us', year: '2024', item_type: 'regular' })).toBeUndefined();
  });

  it('sends the stored ETag back on the next fetch, which is what makes a 304 possible', async () => {
    const harness = makeEvents();

    await harness.events.lifecycle.fetch(US);
    await harness.events.lifecycle.fetch(US);

    // `query` is also consulted for its staleTime with one argument; the fetching calls are the two-argument ones.
    const etags = harness.query.mock.calls.filter((call) => call.length === 2).map((call) => call[1]);
    expect(etags).toEqual([undefined, 'W/"v1"']);
    harness.query.mock.calls.forEach((call) => expect(call[0]).toEqual(US));
  });

  it('answers `has` from the same rows, so presence and ingest cannot disagree', async () => {
    const harness = makeEvents();

    expect(harness.events.has(US)).toBe(false);
    await harness.events.lifecycle.fetch(US);
    expect(harness.events.has(US)).toBe(true);
    expect(harness.events.has({ ...US, year: '2024' })).toBe(false);
  });

  it('replaces only its own partition, leaving a sibling in place', async () => {
    const harness = makeEvents();
    await harness.events.lifecycle.fetch(US);
    await harness.events.lifecycle.fetch(OTHER);

    expect(harness.table.find(harness.events.where(US))).toHaveLength(2);
    expect(harness.table.find(harness.events.where(OTHER))).toHaveLength(2);
  });

  it('clears the ETag on request, so the next fetch is a real one rather than a 304', async () => {
    const harness = makeEvents();
    await harness.events.lifecycle.fetch(US);

    harness.events.clearEtag(US);

    expect(harness.table.getMeta(harness.events.where(US))).toBeUndefined();
  });
});

describe('definePartitions — bumping', () => {
  it('raises the version once rows land and tells `onChanged`, for a store holding a derived rollup', async () => {
    const harness = makeEvents();

    await harness.events.lifecycle.fetch(US);

    expect(harness.events.versionOf(US)).toBe(1);
    expect(harness.changed).toEqual([{ key: US, version: 1 }]);
  });

  it('bumps a partition a writer filled itself, which is how a socket frame wakes readers', () => {
    const harness = makeEvents();

    expect(harness.events.bump(US)).toBe(1);
    expect(harness.events.versionOf(US)).toBe(1);
    expect(harness.changed).toHaveLength(1);
  });

  it('hands `onChanged` the entities the fetch changed', async () => {
    const harness = makeEvents();

    await harness.events.lifecycle.fetch(US);

    expect([...(harness.changedEntities[0] as ReadonlySet<string>)].sort()).toEqual(['g1', 'g2']);
  });

  it('bumps nothing, and tells nobody, for a write that changed nothing', () => {
    const harness = makeEvents();

    expect(harness.events.bump(US, NO_CHANGES)).toBe(0);
    expect(harness.changed).toEqual([]);
  });

  it('counts every entity changed for a store that bumps without saying which', () => {
    const harness = makeEvents();

    harness.events.bump(US);

    expect(harness.changedEntities).toEqual([ALL_ENTITIES]);
  });

  it('keys the version by the field order it declared, so two partitions never share one', () => {
    const harness = makeEvents();

    harness.events.bump(US);

    expect(harness.events.versionOf(US)).toBe(1);
    expect(harness.events.versionOf({ ...US, itemType: 'post' })).toBe(0);
  });
});

describe('definePartitions — the shred, and what happens when it cannot run', () => {
  it('re-parses in JS and reports a degradation when the raw shred throws, rather than losing the partition', async () => {
    const real = createTestRowTable(SCHEMA);
    const table: RowTable<EventRow> = {
      ...real,
      shred: jest.fn(async () => {
        throw new Error('native shred failed');
      }),
      overwrite: jest.fn(real.overwrite),
    };
    const harness = makeEvents({ table });

    await harness.events.lifecycle.fetch(US);

    expect(table.overwrite).toHaveBeenCalled();
    expect(real.find(harness.events.where(US))).toHaveLength(2);
    expect(degradeMock).toHaveBeenCalledWith(expect.objectContaining({ scope: 'events_store.raw_ingest' }));
  });

  it('skips the raw shred entirely for a body it is told cannot be iterated', async () => {
    const real = createTestRowTable(SCHEMA);
    const table: RowTable<EventRow> = { ...real, shred: jest.fn(real.shred), overwrite: jest.fn(real.overwrite) };
    const version = createVersionAtom('define_partitions_no_shred');
    const events = definePartitions<EventRow, EventKey>({
      name: 'events',
      table,
      version,
      key: { fields: ['region', 'year', 'itemType'], where: ({ region, year, itemType }) => ({ region, year, item_type: itemType }) },
      fetch: {
        query: () => ({ queryFn: async () => ({ data: '{"only":"one"}' }) }),
        toRows: (key) => [{ region: key.region, year: key.year, item_type: key.itemType, event_id: 'one' }],
        canShredNatively: () => false,
      },
    });

    await events.lifecycle.fetch(US);

    expect(table.shred).not.toHaveBeenCalled();
    expect(table.overwrite).toHaveBeenCalled();
    expect(degradeMock).not.toHaveBeenCalled();
  });

  it('records when rows landed, so a store needs no fetch bookkeeping of its own', async () => {
    const harness = makeEvents();
    expect(harness.events.lifecycle.getFetchedAt(US)).toBe(0);

    await harness.events.lifecycle.fetch(US);

    expect(harness.events.lifecycle.getFetchedAt(US)).toBeGreaterThan(0);
    expect(harness.events.lifecycle.getFetchedAt(OTHER)).toBe(0);
  });

  it('forgets the oldest fetch record past its bound, which reads as never fetched', async () => {
    const harness = makeEvents({ internMax: 2 });
    const third: EventKey = { ...US, year: '2023' };

    await harness.events.lifecycle.fetch(US);
    await harness.events.lifecycle.fetch(OTHER);
    await harness.events.lifecycle.fetch(third);

    expect(harness.events.lifecycle.getFetchedAt(US)).toBe(0);
    expect(harness.events.lifecycle.getFetchedAt(OTHER)).toBeGreaterThan(0);
    expect(harness.events.lifecycle.getFetchedAt(third)).toBeGreaterThan(0);
  });

  it('leaves `getFetchedAt` where it was on a 304, since a matched ETag lands no rows', async () => {
    const harness = makeEvents();
    await harness.events.lifecycle.fetch(US);
    const first = harness.events.lifecycle.getFetchedAt(US);

    harness.query.mockReturnValue({ queryFn: async () => ({ __etagMatch: true } as unknown as { data: string; etag: string }) });
    harness.events.lifecycle.invalidate(US);
    await harness.events.lifecycle.fetch(US);

    expect(harness.events.lifecycle.getFetchedAt(US)).toBe(first);
  });
});

describe('definePartitions — reads take the key rather than a positional array', () => {
  it('defaults a read to the key fields, so a read whose args include them declares no partition', async () => {
    const harness = makeEvents();
    const ids = harness.events.defineRead<EventKey, string[]>({
      select: (_args, key) => harness.table.find(harness.events.where(key)).map((row) => row.event_id),
      empty: [],
    });
    await harness.events.lifecycle.fetch(US);

    // `cohort` sits outside the key's fields, so it is dropped and the read still addresses the one partition.
    expect(ids.getValue({ ...US, cohort: 'SF' } as EventKey)).toEqual(['g1', 'g2']);
  });

  it('gates a read on the partition holding rows, so `select` never runs against an empty one', () => {
    const harness = makeEvents();
    const select = jest.fn(() => ['x']);
    const ids = harness.events.defineRead<EventKey, string[]>({ select, empty: [] });

    expect(ids.getValue(US)).toEqual([]);
    expect(select).not.toHaveBeenCalled();
  });

  it('hands `select` the same key `where` is written against', async () => {
    const harness = makeEvents();
    const seen: EventKey[] = [];
    const ids = harness.events.defineRead<EventKey, string[]>({
      select: (_args, key) => {
        seen.push(key);
        return [];
      },
      empty: [],
    });
    await harness.events.lifecycle.fetch(US);
    ids.getValue(US);

    expect(seen).toEqual([US]);
  });
});

describe('definePartitions — a store whose key is an opaque string', () => {
  type BlobRow = { partition_key: string; id: string };
  const BLOB_SCHEMA: RowTableSchema<BlobRow> = {
    table: 'blobs',
    columns: { partition_key: { type: 'TEXT' }, id: { type: 'TEXT' } },
    primaryKey: ['partition_key', 'id'],
    entityId: 'id',
    meta: { table: 'blobs_meta', keyColumns: ['partition_key'], column: 'etag' },
  };

  const makeBlobs = () => {
    const table = createTestRowTable(BLOB_SCHEMA);
    table.init();
    const version = createVersionAtom('define_partitions_blob');
    const blobs = definePartitions<BlobRow, string>({
      name: 'blobs',
      table,
      version,
      key: { where: (key) => ({ partition_key: key }) },
      fetch: {
        query: () => ({ queryFn: async () => ({ data: '["a"]', etag: 'W/"b"' }) }),
        toRows: (key, raw) => (JSON.parse(raw) as string[]).map((id) => ({ partition_key: key, id })),
      },
    });
    return { blobs, table };
  };

  it('needs no `fields`: the key is already one part, and everything derives from it as usual', async () => {
    const harness = makeBlobs();

    await harness.blobs.lifecycle.fetch('year|us|2025');

    expect(harness.table.getMeta({ partition_key: 'year|us|2025' })).toBe('W/"b"');
    expect(harness.blobs.has('year|us|2025')).toBe(true);
    expect(harness.blobs.versionOf('year|us|2025')).toBe(1);
  });

  it('addresses nothing with an empty key, so nothing is fetched for a partition that does not exist', async () => {
    const harness = makeBlobs();

    await harness.blobs.lifecycle.fetch('');

    expect(harness.table.has({ partition_key: '' })).toBe(false);
  });

  it('invalidates one partition by its key, without touching the store\u2019s others', () => {
    const harness = makeBlobs();

    harness.blobs.lifecycle.invalidate('year|us|2025');

    expect(invalidateMock).toHaveBeenCalledWith({ queryKey: ['blobs_store_ingest', 'year|us|2025'], exact: true });
  });
});

describe('definePartitions — a store whose partition is a record, interned to a key', () => {
  type MetricRow = { partition_key: string; id: string };
  type Spec = { request: 'week' | 'event'; region: string; week?: number };
  type Args = { partition: Spec };

  const METRIC_SCHEMA: RowTableSchema<MetricRow> = {
    table: 'metrics',
    columns: { partition_key: { type: 'TEXT' }, id: { type: 'TEXT' } },
    primaryKey: ['partition_key', 'id'],
    entityId: 'id',
    meta: { table: 'metrics_meta', keyColumns: ['partition_key'], column: 'etag' },
  };

  const specKey = (spec: Spec): string => `${spec.request}:${spec.region}:${spec.week ?? ''}`;
  const WEEK1: Spec = { request: 'week', region: 'us', week: 1 };

  function makeMetrics() {
    const table = createTestRowTable(METRIC_SCHEMA);
    table.init();
    // Deduped: the ingest also consults `query` for staleTime, so a fetch reaches it more than once.
    const byKey = new Map<string, Spec>();
    const queried = { records: [] as Spec[] };
    const shredAsked: Spec[] = [];
    const metrics = definePartitions<MetricRow, string, Args, Spec>({
      name: 'metrics',
      table,
      version: createVersionAtom(`define_partitions_intern_${Math.random()}`),
      key: { of: (args) => args.partition, id: specKey, where: (key) => ({ partition_key: key }) },
      fetch: {
        query: (partition) => {
          if (!byKey.has(specKey(partition))) {
            byKey.set(specKey(partition), partition);
            queried.records.push(partition);
          }
          return { queryFn: async () => ({ data: '["a","b"]' }) };
        },
        toRows: (_partition, raw, key) => (JSON.parse(raw) as string[]).map((id) => ({ partition_key: key, id })),
        canShredNatively: (partition) => {
          shredAsked.push(partition);
          return false;
        },
      },
    });
    return { metrics, table, queried: queried.records, shredAsked };
  }

  it('hands the fetch the record, so a store keeps no record-to-key table of its own', async () => {
    const harness = makeMetrics();

    await harness.metrics.lifecycle.fetch({ partition: WEEK1 });

    expect(harness.queried).toEqual([WEEK1]);
    expect(harness.shredAsked).toEqual([WEEK1]);
  });

  it('addresses rows by the key the record hashes to', async () => {
    const harness = makeMetrics();

    await harness.metrics.lifecycle.fetch({ partition: WEEK1 });

    expect(harness.table.find({ partition_key: 'week:us:1' }).map((row) => row.id)).toEqual(['a', 'b']);
  });

  it('reaches the key through `key.of`, so a read over the record declares no partition', async () => {
    const harness = makeMetrics();
    const ids = harness.metrics.defineRead<Args, string[]>({
      select: (_args, key) => harness.table.find({ partition_key: key }).map((row) => row.id),
      empty: [],
    });

    await harness.metrics.lifecycle.fetch({ partition: WEEK1 });

    // A fresh object equal to `WEEK1`: the record's hash is what addresses the partition.
    expect(ids.getValue({ partition: { request: 'week', region: 'us', week: 1 } })).toEqual(['a', 'b']);
  });

  it('interns the records a read names, so the read names partitions rather than keys', async () => {
    const harness = makeMetrics();
    const event: Spec = { request: 'event', region: 'us' };
    const ids = harness.metrics.defineReadAcross<{ specs: Spec[] }, string[]>({
      partitions: (args) => args.specs,
      select: (_args, keys) => keys.flatMap((key) => harness.table.find({ partition_key: key }).map((row) => row.id)),
      empty: [],
    });

    ids.getValue({ specs: [WEEK1, event] });

    expect(harness.queried).toEqual([WEEK1, event]);
  });

  it('keeps an absent partition as a gap, so a result stays parallel to the list the caller named', async () => {
    const harness = makeMetrics();
    const seen = harness.metrics.defineReadAcross<{ specs: (Spec | null)[] }, boolean[]>({
      partitions: (args) => args.specs,
      select: (_args, keys) => keys.map(Boolean),
      empty: [],
    });

    await harness.metrics.lifecycle.fetch({ partition: WEEK1 });
    harness.queried.length = 0;

    expect(seen.getValue({ specs: [WEEK1, null] })).toEqual([true, false]);
    expect(harness.queried).toEqual([]);
  });

  it('reads several lookups at once, each finding its own candidates among the partitions they name together', async () => {
    const harness = makeMetrics();
    const event: Spec = { request: 'event', region: 'us' };
    const count = (spec: Spec): number => harness.table.find({ partition_key: harness.metrics.keyOf(spec) }).length;
    const perItem = harness.metrics.defineReadAcross<{ items: { candidates: Spec[] }[] }, number[]>({
      partitions: (args) => args.items.flatMap((item) => item.candidates),
      select: (args) => args.items.map((item) => item.candidates.reduce((total, spec) => total + count(spec), 0)),
      empty: [],
    });

    await harness.metrics.lifecycle.fetch({ partition: WEEK1 });

    expect(perItem.getValue({ items: [{ candidates: [WEEK1, event] }, { candidates: [event] }] })).toEqual([2, 0]);
  });

  it('keeps a partition warm by re-interning it on every path that names it, rather than only at declaration', () => {
    const harness = makeMetrics();
    const event: Spec = { request: 'event', region: 'us' };
    const ids = harness.metrics.defineRead<Args, string[]>({ select: () => [], empty: [] });

    ids.getValue({ partition: WEEK1 });
    ids.getValue({ partition: event });
    ids.getValue({ partition: WEEK1 });

    expect(() => harness.metrics.lifecycle.getVersion({ partition: WEEK1 })).not.toThrow();
    expect(() => harness.metrics.lifecycle.getVersion({ partition: event })).not.toThrow();
  });

  it('takes args, not keys, throughout `lifecycle`, so a backend publishes the group as-is', async () => {
    const harness = makeMetrics();
    const args: Args = { partition: WEEK1 };

    expect(harness.metrics.lifecycle.has(args)).toBe(false);
    await harness.metrics.lifecycle.fetch(args);

    expect(harness.metrics.lifecycle.has(args)).toBe(true);
    expect(harness.metrics.lifecycle.getVersion(args)).toBe(1);
    expect(harness.metrics.lifecycle.getFetchedAt(args)).toBeGreaterThan(0);
  });
});

describe('definePartitions — args that resolve to no partition at all', () => {
  type MetricRow = { partition_key: string; id: string };
  type Spec = { region: string; week: number };
  /** Args as a screen holds them, before the values that name a partition have arrived. */
  type Args = { region?: string; week?: number };

  const SCHEMA: RowTableSchema<MetricRow> = {
    table: 'loose',
    columns: { partition_key: { type: 'TEXT' }, id: { type: 'TEXT' } },
    primaryKey: ['partition_key', 'id'],
    entityId: 'id',
    meta: { table: 'loose_meta', keyColumns: ['partition_key'], column: 'etag' },
  };

  function makeLoose() {
    const table = createTestRowTable(SCHEMA);
    table.init();
    const queried: Spec[] = [];
    const loose = definePartitions<MetricRow, string, Args, Spec>({
      name: 'loose',
      table,
      version: createVersionAtom(`define_partitions_loose_${Math.random()}`),
      key: {
        of: (args) => (args.region && args.week ? { region: args.region, week: args.week } : null),
        id: (spec) => `${spec.region}:${spec.week}`,
        where: (key) => ({ partition_key: key }),
      },
      fetch: {
        query: (partition) => {
          queried.push(partition);
          return { queryFn: async () => ({ data: '["a"]' }) };
        },
        toRows: (_partition, raw, key) => (JSON.parse(raw) as string[]).map((id) => ({ partition_key: key, id })),
        canShredNatively: () => false,
      },
    });
    const ids = loose.defineRead<Args, string[]>({
      select: (_args, key) => table.find({ partition_key: key }).map((row) => row.id),
      empty: [],
    });
    return { loose, table, queried, ids };
  }

  it('reads as empty and fetches nothing while a value that names the partition is missing', () => {
    const harness = makeLoose();

    expect(harness.ids.getValue({ region: 'us' })).toEqual([]);
    expect(harness.queried).toEqual([]);
  });

  it('reads the partition once the missing value arrives, so the same args resolve when they are complete', async () => {
    const harness = makeLoose();

    await harness.loose.lifecycle.fetch({ region: 'us', week: 1 });

    expect(harness.ids.getValue({ region: 'us', week: 1 })).toEqual(['a']);
    expect(harness.queried).toContainEqual({ region: 'us', week: 1 });
  });

  it('leaves every lifecycle member inert, rather than asking about a partition that has no address', async () => {
    const harness = makeLoose();
    const partial: Args = { region: 'us' };
    invalidateMock.mockClear();

    await harness.loose.lifecycle.fetch(partial);
    harness.loose.lifecycle.invalidate(partial);

    expect(harness.loose.lifecycle.has(partial)).toBe(false);
    expect(harness.loose.lifecycle.getVersion(partial)).toBe(0);
    expect(harness.loose.lifecycle.getFetchedAt(partial)).toBe(0);
    expect(harness.queried).toEqual([]);
    expect(invalidateMock).not.toHaveBeenCalled();
  });
});
