import { createTrackedSelector } from '../../reactivity/tracked_selector';
import { createVersionAtom } from '../../reactivity/version_atom';
import { describeDev } from '../../testing/dev_mode';
import { runTracked } from '../../reactivity/tracking';

const US = ['us'];
const EU = ['eu'];

describe('createTrackedSelector', () => {
  it('memoizes on inputs: no recompute when inputs and tracked versions are stable', () => {
    const atom = createVersionAtom('cts_a');
    const resultFn = jest.fn((value: number) => ({ doubled: value * 2, v: atom.get(US) }));
    const select = createTrackedSelector([(value: number) => value], resultFn);

    const first = select(5);
    expect(first).toEqual({ doubled: 10, v: 0 });
    expect(select(5)).toBe(first);
    expect(select(5)).toBe(first);
    expect(resultFn).toHaveBeenCalledTimes(1);
  });

  it('recomputes when a Redux input changes (normal reselect behavior)', () => {
    const atom = createVersionAtom('cts_b');
    const resultFn = jest.fn((value: number) => {
      atom.get(US);
      return value;
    });
    const select = createTrackedSelector([(value: number) => value], resultFn);

    expect(select(1)).toBe(1);
    expect(select(2)).toBe(2);
    expect(resultFn).toHaveBeenCalledTimes(2);
  });

  it('busts the memo when a tracked store partition bumps, even with unchanged inputs (the fix)', () => {
    const atom = createVersionAtom('cts_c');
    const store = new Map<string, string>([['p', 'v0']]);
    const resultFn = jest.fn((key: string) => {
      atom.get(US);
      return store.get(key);
    });
    const select = createTrackedSelector([(key: string) => key], resultFn);

    expect(select('p')).toBe('v0');
    expect(resultFn).toHaveBeenCalledTimes(1);

    store.set('p', 'v1');
    atom.bump(US);

    expect(select('p')).toBe('v1');
    expect(resultFn).toHaveBeenCalledTimes(2);
  });

  it('does not recompute on an unrelated partition bump', () => {
    const atom = createVersionAtom('cts_d');
    const resultFn = jest.fn((key: string) => {
      atom.get(US);
      return key;
    });
    const select = createTrackedSelector([(key: string) => key], resultFn);

    expect(select('x')).toBe('x');
    atom.bump(EU);
    expect(select('x')).toBe('x');
    expect(resultFn).toHaveBeenCalledTimes(1);
  });

  it('keeps entries for several argument sets, so alternating calls do not thrash', () => {
    const atom = createVersionAtom('cts_multi');
    const resultFn = jest.fn((tenantId: string, round: number) => {
      atom.get(US);
      return `${tenantId}:${round}`;
    });
    const select = createTrackedSelector([(tenantId: string, _round: number) => tenantId, (_tenantId: string, round: number) => round], resultFn);

    expect(select('a', 1)).toBe('a:1');
    expect(select('b', 2)).toBe('b:2');
    expect(resultFn).toHaveBeenCalledTimes(2);

    for (let index = 0; index < 5; index += 1) {
      expect(select('a', 1)).toBe('a:1');
      expect(select('b', 2)).toBe('b:2');
    }
    expect(resultFn).toHaveBeenCalledTimes(2);
  });

  it('evicts least-recently-used once more argument sets are live than the cache holds', () => {
    const resultFn = jest.fn((value: number) => value);
    const select = createTrackedSelector([(value: number) => value], resultFn, { cacheMax: 2 });

    select(1);
    select(2);
    expect(resultFn).toHaveBeenCalledTimes(2);
    expect(select(1)).toBe(1);
    expect(resultFn).toHaveBeenCalledTimes(2);

    select(3);
    expect(resultFn).toHaveBeenCalledTimes(3);
    expect(select(2)).toBe(2);
    expect(resultFn).toHaveBeenCalledTimes(4);
  });

  it('busts only the entry whose partition bumped, leaving the others cached', () => {
    const atom = createVersionAtom('cts_multi_bump');
    const other = createVersionAtom('cts_multi_other');
    const resultFn = jest.fn((which: string) => {
      if (which === 'tracked') atom.get(US);
      else other.get(EU);
      return which;
    });
    const select = createTrackedSelector([(which: string) => which], resultFn);

    select('tracked');
    select('other');
    expect(resultFn).toHaveBeenCalledTimes(2);

    atom.bump(US);
    select('other');
    expect(resultFn).toHaveBeenCalledTimes(2);
    select('tracked');
    expect(resultFn).toHaveBeenCalledTimes(3);
  });

  it('rediscovers dependencies each recompute, so conditional store reads stay correct', () => {
    const us = createVersionAtom('cts_e_us');
    const eu = createVersionAtom('cts_e_eu');
    const resultFn = jest.fn((region: string) => {
      if (region === 'us') return us.get(US);
      return eu.get(EU);
    });
    const select = createTrackedSelector([(region: string) => region], resultFn);

    select('us');
    select('eu');
    expect(resultFn).toHaveBeenCalledTimes(2);

    us.bump(US);
    select('eu');
    expect(resultFn).toHaveBeenCalledTimes(2);

    eu.bump(EU);
    select('eu');
    expect(resultFn).toHaveBeenCalledTimes(3);
  });

  it('forwards its deps to an outer runTracked scope (so useTrackedStores/withTrackedStores subscribes)', () => {
    const atom = createVersionAtom('cts_compose');
    const resultFn = jest.fn((value: number) => {
      atom.get(US);
      return value * 2;
    });
    const select = createTrackedSelector([(value: number) => value], resultFn);

    const first = runTracked(() => select(3));
    expect(first.value).toBe(6);
    expect(first.deps.map((dep) => dep.id)).toEqual(['cts_compose\u0000us']);

    const second = runTracked(() => select(3));
    expect(second.value).toBe(6);
    expect(second.deps.map((dep) => dep.id)).toEqual(['cts_compose\u0000us']);
    expect(resultFn).toHaveBeenCalledTimes(1);
  });

  describeDev('dev guard: store read outside a tracking scope', () => {
    let warn: jest.SpyInstance;
    beforeEach(() => {
      warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(() => warn.mockRestore());

    it('warns once when it reads store deps but runs with no outer scope (unwrapped consumer)', () => {
      const atom = createVersionAtom('cts_guard_a');
      const select = createTrackedSelector([(value: number) => value], (value) => {
        atom.get(US);
        return value;
      });

      select(1);
      select(1);
      select(2);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain('ran outside a tracking scope');
    });

    it('stays silent when run inside a tracking scope (a wrapped consumer)', () => {
      const atom = createVersionAtom('cts_guard_b');
      const select = createTrackedSelector([(value: number) => value], (value) => {
        atom.get(US);
        return value;
      });

      runTracked(() => select(1));
      expect(warn).not.toHaveBeenCalled();
    });

    it('does not warn for a pure Redux selector that reads no store partition', () => {
      const select = createTrackedSelector([(value: number) => value], (value) => value * 2);
      select(1);
      select(2);
      expect(warn).not.toHaveBeenCalled();
    });

    it('uses debugLabel in the warning when provided', () => {
      const atom = createVersionAtom('cts_guard_c');
      const select = createTrackedSelector(
        [(value: number) => value],
        (value) => {
          atom.get(US);
          return value;
        },
        { debugLabel: 'getMyThing' },
      );
      select(1);
      expect(warn.mock.calls[0][0]).toContain('getMyThing');
    });
  });

  it('supports a custom inputEqual (deep-equal inputs)', () => {
    const atom = createVersionAtom('cts_f');
    const resultFn = jest.fn((obj: { id: string }) => {
      atom.get(US);
      return obj.id;
    });
    const select = createTrackedSelector([(obj: { id: string }) => obj], resultFn, {
      inputEqual: (left, right) => JSON.stringify(left) === JSON.stringify(right),
    });

    select({ id: 'a' });
    select({ id: 'a' });
    expect(resultFn).toHaveBeenCalledTimes(1);
    select({ id: 'b' });
    expect(resultFn).toHaveBeenCalledTimes(2);
  });
});
