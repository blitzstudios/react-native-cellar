/**
 * How a key is derived from what a read varies by. Everything here is a sharing decision: two calls that key alike
 * share one cache entry, so a value that changes the answer and not the key would serve one caller another's data.
 */

import { ArgValue, argsKeyOf, cacheKey, identityOf, isArgPresent, partitionsKey, stableKey } from '../args_key';
import { resetOnceGuards } from '../diagnostics/once_guard';
import { itDev } from '../testing/dev_mode';

describe('stableKey', () => {
  it('separates every value that differs, at any depth', () => {
    const base = stableKey([null, {}]);

    expect(stableKey([null, { orderBy: { key: 'rush_yd' } }])).not.toBe(base);
    expect(stableKey([null, { orderBy: { key: 'rush_yd' } }])).not.toBe(stableKey([null, { orderBy: { key: 'pts_ppr' } }]));
    expect(stableKey([null, { orderBy: { key: 'rush_yd', direction: 'asc' } }])).not.toBe(stableKey([null, { orderBy: { key: 'rush_yd', direction: 'desc' } }]));
    expect(stableKey([null, { limit: 5 }])).not.toBe(base);
    expect(stableKey([null, { positions: ['RB'] }])).not.toBe(base);
    expect(stableKey([{ rush_yd: 1 }, {}])).not.toBe(base);
  });

  it('is insensitive to key order, so two callers building the same options differently share one entry', () => {
    expect(stableKey({ limit: 5, cohort: 'KC' })).toBe(stableKey({ cohort: 'KC', limit: 5 }));
    expect(stableKey([{ rush_yd: 1, pts_ppr: 2 }, {}])).toBe(stableKey([{ pts_ppr: 2, rush_yd: 1 }, {}]));
  });

  it('takes an absent field and an explicit undefined as the same value', () => {
    expect(stableKey({ cohort: undefined })).toBe(stableKey({}));
  });

  it('keeps a nested key from reading as part of its own value', () => {
    // Unquoted, both of these would render `{a:1,b:2}`.
    expect(stableKey({ 'a:1,b': 2 })).not.toBe(stableKey({ a: 1, b: 2 }));
  });

  it('separates a list from the value it holds, and an empty one from an absent one', () => {
    expect(stableKey(['a'])).not.toBe(stableKey('a'));
    expect(stableKey([])).not.toBe(stableKey(undefined));
  });

  itDev('warns once about a value that is not plain data, which would key as if it were empty', () => {
    resetOnceGuards();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      const held = new Map([['a', 1]]);
      const other = new Map([['b', 2]]);

      // The report is the guarantee here: the keys themselves genuinely do collide, which is the point of warning.
      expect(stableKey(held)).toBe(stableKey(other));
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain('not plain data');

      stableKey(new Map());
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  itDev('says nothing about plain data, at any depth', () => {
    resetOnceGuards();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      stableKey({ a: [1, { b: null }], c: 'd' });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('cacheKey', () => {
  it('keeps parts apart, including where a part holds the character a reader would have joined on', () => {
    expect(cacheKey('us', 'p1')).not.toBe(cacheKey('usp', '1'));
    // The separator is a control character precisely so a part like `region:us-west` cannot split a key.
    expect(cacheKey('region:us-west', 'p1')).not.toBe(cacheKey('region', 'epl:p1'));
  });
});

describe('argsKeyOf', () => {
  it('keys by the partition and every arg by name, so one partition read two ways is two calls', () => {
    expect(argsKeyOf(['us'], { cohort: 'KC' })).not.toBe(argsKeyOf(['us'], { cohort: 'SF' }));
    expect(argsKeyOf(['us'], { cohort: 'KC' })).not.toBe(argsKeyOf(['eu'], { cohort: 'KC' }));
    expect(argsKeyOf(['us'], {})).not.toBe(argsKeyOf(['us'], { cohort: 'KC' }));
    expect(argsKeyOf(['us'], { a: 'KC' })).not.toBe(argsKeyOf(['us'], { b: 'KC' }));
  });

  it('keys an object arg by its content, and the args in any order alike, so a caller rebuilding them is no change', () => {
    expect(argsKeyOf(['us'], { opts: { limit: 5, cohort: 'KC' } })).toBe(argsKeyOf(['us'], { opts: { cohort: 'KC', limit: 5 } }));
    expect(argsKeyOf(['us'], { a: 1, b: 2 })).toBe(argsKeyOf(['us'], { b: 2, a: 1 }));
  });

  it('leaves the args object itself unfrozen, since it belongs to the caller', () => {
    const args = { cohort: 'KC' };
    argsKeyOf(['us'], args);
    expect(Object.isFrozen(args)).toBe(false);
  });
});

describe('identityOf', () => {
  /** A part that counts how often its content is read, which is how often it is serialized. */
  const countingPart = () => {
    const part = { pts: 0, scoring: { yds: 1 } };
    let reads = 0;
    Object.defineProperty(part, 'pts', {
      enumerable: true,
      get: () => {
        reads += 1;
        return 4;
      },
    });
    return { part, serializations: () => reads };
  };

  itDev('serializes a held part once per turn however often a loop keys it', () => {
    const { part, serializations } = countingPart();
    const first = identityOf(part);
    for (let i = 0; i < 1000; i += 1) expect(identityOf(part)).toBe(first);
    expect(serializations()).toBe(2);
  });

  itDev('still notices a part mutated after a turn, and warns once', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const part: { scoring: { pts: number } } = { scoring: { pts: 1 } };
    const before = identityOf(part);
    await Promise.resolve();
    await Promise.resolve();
    part.scoring.pts = 2;
    expect(identityOf(part)).not.toBe(before);
    expect(identityOf(part)).toBe(stableKey({ scoring: { pts: 2 } }));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/mutated after the read keyed it/);
    warn.mockRestore();
  });
});

describe('partitionsKey', () => {
  it('makes the same partitions named in a different order, or grouped differently, a different set', () => {
    expect(partitionsKey([['us'], ['eu']])).not.toBe(partitionsKey([['eu'], ['us']]));
    expect(partitionsKey([['us', 'eu']])).not.toBe(partitionsKey([['us'], ['eu']]));
  });
});

describe('isArgPresent', () => {
  it('counts a value a read cannot use as none, and a falsy one it can as a value', () => {
    const absent: ArgValue[] = [undefined, null, '', []];
    const present: ArgValue[] = [0, false, 'KC', ['a'], {}];

    expect(absent.filter(isArgPresent)).toEqual([]);
    expect(present.every(isArgPresent)).toBe(true);
  });
});

/**
 * The exact strings, not just the distinctions. A key is persisted nowhere, but it is the identity of every cache
 * entry on the read path, so an encoding that shifts silently turns every warm entry cold — and two keys that
 * newly collide return one read's value to another. Any refactor here has to leave these byte-identical.
 */
describe('key encoding', () => {
  const NUL = '\u0000';
  const GROUP = '\u0001';

  it('encodes each kind of value exactly', () => {
    expect(stableKey('abc')).toBe('"abc"');
    expect(stableKey(7)).toBe('7');
    expect(stableKey(true)).toBe('true');
    expect(stableKey(null)).toBe('null');
    expect(stableKey(undefined)).toBe('u');
    expect(stableKey([1, 'a', null])).toBe('[1,"a",null]');
    expect(stableKey({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    expect(stableKey({ a: { c: [1, { d: 'x' }] } })).toBe('{"a":{"c":[1,{"d":"x"}]}}');
  });

  it('joins parts and groups exactly', () => {
    expect(cacheKey('nfl', '2025')).toBe(`nfl${NUL}2025`);
    expect(argsKeyOf(['nfl'], {})).toBe('nfl');
    expect(argsKeyOf(['nfl', '2025'], { c: 'x', b: 3, a: { a: 1 } })).toBe(`nfl${NUL}2025${NUL}a${NUL}{"a":1}${NUL}b${NUL}3${NUL}c${NUL}"x"`);
    expect(
      partitionsKey([
        ['nfl', '1'],
        ['nba', '2'],
      ]),
    ).toBe(`nfl${NUL}1${GROUP}nba${NUL}2`);
  });
});
