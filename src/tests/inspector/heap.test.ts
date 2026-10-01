import { estimateHeap, estimateInto, estimateIntoSliced, previewValue } from '../../inspector/heap';

describe('estimateHeap', () => {
  it('grows with what a value holds, and counts a shared object once', () => {
    const player = { id: '4046', name: 'Patrick Mahomes', team: 'KC' };
    const one = estimateHeap([player]);
    const twice = estimateHeap([player, player]);
    const two = estimateHeap([player, { ...player }]);
    expect(one.bytes).toBeGreaterThan(0);
    expect(twice.bytes - one.bytes).toBe(8);
    expect(two.bytes).toBeGreaterThan(twice.bytes);
    expect(two.objects).toBe(3);
  });

  it('counts characters past Latin-1 at two bytes each', () => {
    expect(estimateHeap('é'.repeat(10)).bytes - estimateHeap('e'.repeat(10)).bytes).toBe(0);
    expect(estimateHeap('名'.repeat(10)).bytes - estimateHeap('e'.repeat(10)).bytes).toBe(10);
  });

  it('walks Maps and Sets, and survives a cycle', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(estimateHeap(new Map([['k', { v: 1 }]])).objects).toBe(2);
    expect(estimateHeap(new Set([{ v: 1 }, { v: 2 }])).objects).toBe(3);
    expect(estimateHeap(cyclic).objects).toBe(1);
  });
});

describe('estimateIntoSliced', () => {
  const rows = Array.from({ length: 20_000 }, (_, i) => ({ id: String(i), team: 'KC', stats: { pts: i, yds: i * 2 } }));

  it('reaches the estimate a single walk does, counting an object shared between values once', async () => {
    const values = [rows, rows.slice(0, 100)];
    const sliced = { bytes: 0, objects: 0, partial: false };
    await estimateIntoSliced(values, sliced, new Set(), undefined, 0);
    const single = { bytes: 0, objects: 0, partial: false };
    const seen = new Set<object>();
    estimateInto(values[0], single, seen);
    estimateInto(values[1], single, seen);
    expect(sliced).toEqual(single);
  });

  it('yields to the event loop between slices', async () => {
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 0);
    await estimateIntoSliced([rows], { bytes: 0, objects: 0, partial: false }, new Set(), undefined, 0);
    clearInterval(timer);
    expect(ticks).toBeGreaterThan(0);
  });

  it('stops at its object limit and says the estimate is partial', async () => {
    const estimate = { bytes: 0, objects: 0, partial: false };
    await estimateIntoSliced([rows], estimate, new Set(), 1000, 0);
    expect(estimate).toMatchObject({ objects: 1000, partial: true });
  });
});

describe('previewValue', () => {
  it('marks what JSON cannot carry and cuts what is too long', () => {
    class Row {
      id = 1;
    }
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(previewValue({ map: new Map([['a', 1]]), set: new Set([2]), row: new Row(), fn: function named() {}, cyclic })).toEqual({
      map: { $type: 'Map', size: 1, entries: [['a', 1]] },
      set: { $type: 'Set', size: 1, values: [2] },
      row: { $type: 'Row', id: 1 },
      fn: { $type: 'function', name: 'named' },
      cyclic: { self: { $type: 'ref', note: 'a reference back to a value above' } },
    });
    expect(previewValue(Array.from({ length: 5 }, (_, i) => i), { items: 2 })).toEqual([0, 1, { $more: 3 }]);
    expect(previewValue('x'.repeat(10), { chars: 4 })).toBe('xxxx… (10 chars)');
    expect(previewValue({ a: { b: { c: 1 } } }, { depth: 2 })).toEqual({ a: { b: { $type: 'Object', $more: 'deeper than the preview goes' } } });
  });
});
