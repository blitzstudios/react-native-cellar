import { evalShredElement, evalShredSpec, ShredOp, ShredSpec } from '../../write/shred_spec';

function specForOp(op: ShredOp, extra?: Partial<ShredSpec>): ShredSpec {
  return {
    version: 1,
    table: 't',
    insertVerb: 'INSERT OR REPLACE',
    columns: ['c'],
    ops: [op],
    deleteWhere: [{ column: 'partition_key', bindIndex: 0 }],
    ...extra,
  };
}

function evalOne(op: ShredOp, element: unknown, binds: (string | number | null)[] = []): unknown {
  return evalShredElement(specForOp(op), element, binds)?.c;
}

describe('evalShredElement — op semantics (the C++ shredder mirrors these exactly)', () => {
  it('bind: reads a scope value by index (null when out of range)', () => {
    expect(evalOne({ op: 'bind', index: 0 }, {}, ['week:us'])).toBe('week:us');
    expect(evalOne({ op: 'bind', index: 1 }, {}, ['a'])).toBeNull();
  });

  it('text: string-or-null (a non-string extract is null), absent when the path leads nowhere', () => {
    expect(evalOne({ op: 'text', path: 'item.position' }, { item: { position: 'RB' } })).toBe('RB');
    expect(evalOne({ op: 'text', path: 'item.position' }, { item: { position: 5 } })).toBeNull();
    expect(evalOne({ op: 'text', path: 'item.position' }, { item: { position: null } })).toBeNull();
    expect(evalOne({ op: 'text', path: 'item.position' }, {})).toBeUndefined();
    expect(evalOne({ op: 'text', path: 'item.position' }, { item: null })).toBeUndefined();
  });

  it('int: number-or-null (no coercion of numeric strings)', () => {
    expect(evalOne({ op: 'int', path: 'years' }, { years: 0 })).toBe(0);
    expect(evalOne({ op: 'int', path: 'years' }, { years: '3' })).toBeNull();
    expect(evalOne({ op: 'int', path: 'years' }, {})).toBeUndefined();
  });

  it('real: null-or-Number(v)', () => {
    expect(evalOne({ op: 'real', path: 'metrics.pass_yd' }, { metrics: { pass_yd: 12 } })).toBe(12);
    expect(evalOne({ op: 'real', path: 'metrics.pass_yd' }, { metrics: { pass_yd: null } })).toBeNull();
    expect(evalOne({ op: 'real', path: 'metrics.pass_yd' }, { metrics: {} })).toBeUndefined();
    expect(evalOne({ op: 'real', path: 'metrics.pass_yd' }, {})).toBeUndefined();
  });

  it('complete: inside the object a missing key is the op’s missing value, and without the object the column is absent', () => {
    const op: ShredOp = { op: 'real', path: 'metrics.pass_yd', complete: 'metrics' };
    expect(evalOne(op, { metrics: { pass_yd: 12 } })).toBe(12);
    expect(evalOne(op, { metrics: {} })).toBeNull();
    expect(evalOne(op, {})).toBeUndefined();
    expect(evalOne({ op: 'real0', path: 'metrics.pass_yd', complete: 'metrics' }, { metrics: {} })).toBe(0);
    expect(evalOne({ op: 'real0', path: 'metrics.pass_yd', complete: 'metrics' }, {})).toBeUndefined();
  });

  it('real0: COALESCE(Number(v), 0)', () => {
    expect(evalOne({ op: 'real0', path: 'metrics.pass_yd' }, { metrics: { pass_yd: 12 } })).toBe(12);
    expect(evalOne({ op: 'real0', path: 'metrics.pass_yd' }, {})).toBe(0);
  });

  it('real / real0: a value that is not a number lands as absent, because that is all simdjson can produce', () => {
    for (const bad of ['not a number', {}, [1, 2], '1e999']) {
      expect(evalOne({ op: 'real', path: 'metrics.pass_yd' }, { metrics: { pass_yd: bad } })).toBeNull();
      expect(evalOne({ op: 'real0', path: 'metrics.pass_yd' }, { metrics: { pass_yd: bad } })).toBe(0);
    }
  });

  it('real: keeps the coercions that do have a number in them, which is what separates this from `int`', () => {
    expect(evalOne({ op: 'real', path: 'metrics.pass_yd' }, { metrics: { pass_yd: '12.5' } })).toBe(12.5);
    expect(evalOne({ op: 'real', path: 'metrics.pass_yd' }, { metrics: { pass_yd: true } })).toBe(1);
  });

  it('metaText: null-or-String(v) (stringifies non-strings)', () => {
    expect(evalOne({ op: 'metaText', path: 'item.first_name' }, { item: { first_name: 'Pat' } })).toBe('Pat');
    expect(evalOne({ op: 'metaText', path: 'item.status' }, { item: { status: 5 } })).toBe('5');
    expect(evalOne({ op: 'metaText', path: 'item.status' }, { item: { status: null } })).toBeNull();
    expect(evalOne({ op: 'metaText', path: 'item.status' }, {})).toBeUndefined();
  });

  it('coalesceText: first present value (String), "" or the fallback when none, absent when no path leads anywhere', () => {
    expect(evalOne({ op: 'coalesceText', paths: ['cohort', 'item.cohort'] }, { item: { cohort: 'BUF' } })).toBe('BUF');
    expect(evalOne({ op: 'coalesceText', paths: ['cohort', 'item.cohort'] }, { cohort: 'KC', item: { cohort: 'BUF' } })).toBe('KC');
    expect(evalOne({ op: 'coalesceText', paths: ['cohort', 'item.cohort'] }, {})).toBeUndefined();
    expect(evalOne({ op: 'coalesceText', paths: ['cohort', 'item.cohort'] }, { cohort: null })).toBeNull();
    expect(evalOne({ op: 'coalesceText', paths: ['cohort'], fallbackBindIndex: 0 }, {}, ['nfl'])).toBe('nfl');
    expect(evalOne({ op: 'coalesceText', paths: ['item_id', 'item.item_id'], emptyDefault: true }, {})).toBe('');
    expect(evalOne({ op: 'coalesceText', paths: ['cohort', 'item.cohort'] }, { cohort: null, item: { cohort: 'BUF' } })).toBe('BUF');
  });

  it('concat: joins per-part coalesce (stringified, "" for absent) with the separator', () => {
    const op: ShredOp = {
      op: 'concat',
      sep: '_',
      parts: [{ paths: ['region'] }, { paths: ['year'] }, { paths: ['item_id', 'item.item_id'] }],
    };
    expect(evalOne(op, { region: 'us', year: 2024, item: { item_id: '77' } })).toBe('us_2024_77');
    expect(evalOne(op, { region: 'us' })).toBe('us__');
  });

  it('rawJsonField: the field re-serialized, null for a JSON null, absent when missing', () => {
    expect(evalOne({ op: 'rawJsonField', path: 'item.fantasy_positions' }, { item: { fantasy_positions: ['RB', 'WR'] } })).toBe('["RB","WR"]');
    expect(evalOne({ op: 'rawJsonField', path: 'item.fantasy_positions' }, { item: { fantasy_positions: null } })).toBeNull();
    expect(evalOne({ op: 'rawJsonField', path: 'item.fantasy_positions' }, { item: {} })).toBeUndefined();
  });

  it('rawJson: the whole element', () => {
    expect(JSON.parse(evalOne({ op: 'rawJson' }, { a: 1, b: null }) as string)).toEqual({ a: 1, b: null });
  });

  it('rawJsonField: round-trips a nested object, which is what every reader of the column does with it', () => {
    // The native shredder writes simdjson's own slice of the document, so only the parsed value is contractual.
    const metrics = { pass_yd: 250, rec: [1, 2], note: 'x' };
    expect(JSON.parse(evalOne({ op: 'rawJsonField', path: 'metrics' }, { metrics }) as string)).toEqual(metrics);
  });
});

describe('evalShredElement — whereGuard', () => {
  const spec = specForOp({ op: 'bind', index: 0 }, { whereGuard: { paths: ['item_id', 'item.item_id'] } });

  it('keeps an element with a resolvable item id', () => {
    expect(evalShredElement(spec, { item_id: '1' }, ['p'])).toEqual({ c: 'p' });
    expect(evalShredElement(spec, { item: { item_id: '2' } }, ['p'])).toEqual({ c: 'p' });
  });

  it('drops an element with no / empty item id (first-present, empty string fails)', () => {
    expect(evalShredElement(spec, {}, ['p'])).toBeUndefined();
    expect(evalShredElement(spec, { item_id: '' }, ['p'])).toBeUndefined();
    expect(evalShredElement(spec, { item_id: '', item: { item_id: '9' } }, ['p'])).toBeUndefined();
  });
});

describe('evalShredSpec — array', () => {
  it('maps present elements and skips guard failures', () => {
    const spec = specForOp({ op: 'bind', index: 0 }, { whereGuard: { paths: ['item_id'] } });
    const rows = evalShredSpec(spec, [{ item_id: '1' }, {}, { item_id: '2' }], ['p']);
    expect(rows).toEqual([{ c: 'p' }, { c: 'p' }]);
  });
});
