import type { Read } from '../../read/surface';
import { pairRead } from '../../read/facade';
import { makeResult } from '../../store_result';

describe('pairRead', () => {
  type Args = { region: string; cohort: string; ids?: readonly string[] };

  /** A read as `definePartitions` publishes one, recording what each half is handed. */
  const fakeRead = () => {
    const calls: { get: unknown[]; use: unknown[] } = { get: [], use: [] };
    const read: Read<Args, string> = {
      getValue: (args) => {
        calls.get.push(args);
        return 'got';
      },
      useValue: (args, options) => {
        calls.use.push([args, options]);
        return makeResult('used', 'success');
      },
    };
    return { read, calls };
  };

  it('hands both halves the params, unchanged', () => {
    const { read, calls } = fakeRead();
    const pair = pairRead(() => read);

    pair.getValue({ params: { region: 'us', cohort: 'PHI' } });
    pair.useValue({ params: { region: 'us', cohort: 'PHI' } });

    expect(calls.get).toEqual([{ region: 'us', cohort: 'PHI' }]);
    expect(calls.use).toEqual([[{ region: 'us', cohort: 'PHI' }, undefined]]);
  });

  it('passes `options` to the hook half', () => {
    const { read, calls } = fakeRead();
    const pair = pairRead(() => read);

    pair.useValue({ params: { region: 'us', cohort: 'PHI' }, options: { enabled: false } });

    expect(calls.use).toEqual([[{ region: 'us', cohort: 'PHI' }, { enabled: false }]]);
  });

  it('hands over a param without a value as it is, since the read itself waits for it and fetches nothing meanwhile', () => {
    const { read, calls } = fakeRead();
    const pair = pairRead(() => read);

    pair.getValue({ params: { region: 'us', cohort: null, ids: [] } });

    expect(calls.get).toEqual([{ region: 'us', cohort: null, ids: [] }]);
  });

  it('resolves the read per call, so a backend swapped at runtime is picked up', () => {
    const first = fakeRead();
    const second = fakeRead();
    let current = first;
    const pair = pairRead(() => current.read);

    pair.getValue({ params: { region: 'us', cohort: '1' } });
    current = second;
    pair.getValue({ params: { region: 'us', cohort: '2' } });

    expect(first.calls.get).toEqual([{ region: 'us', cohort: '1' }]);
    expect(second.calls.get).toEqual([{ region: 'us', cohort: '2' }]);
  });
});
