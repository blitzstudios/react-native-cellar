import { PRIME_IDLE, type PrimeState } from '../prime_state';
import { DATA_RESULT_KEYS, makeResult, readStatus } from '../store_result';

const LOADING: PrimeState = { isInitialLoading: true, isFetching: true, isError: false };
const FAILED: PrimeState = { isInitialLoading: false, isFetching: false, isError: true };

describe('readStatus', () => {
  it('is success when disabled, regardless of the fetch state', () => {
    expect(readStatus(false, false, LOADING)).toBe('success');
    expect(readStatus(false, false, PRIME_IDLE)).toBe('success');
    expect(readStatus(false, false, FAILED)).toBe('success');
  });

  it('is success once data is present, even mid-fetch or after a failed refetch', () => {
    expect(readStatus(true, true, LOADING)).toBe('success');
    expect(readStatus(true, true, FAILED)).toBe('success');
  });

  it('is loading only while enabled, empty, and the fetch is in flight', () => {
    expect(readStatus(true, false, LOADING)).toBe('loading');
  });

  it('is error when the fetch failed with nothing to show', () => {
    expect(readStatus(true, false, FAILED)).toBe('error');
  });

  it('is success when empty with no fetch owning the partition (push-fed)', () => {
    expect(readStatus(true, false, PRIME_IDLE)).toBe('success');
  });
});

describe('DATA_RESULT_KEYS', () => {
  it('names every field a result is built with, since the lint rule allows exactly these', () => {
    expect(Object.keys(makeResult('x', 'success')).sort()).toEqual([...DATA_RESULT_KEYS].sort());
  });
});

describe('the lint plugin', () => {
  it('knows the same DataResult fields the core builds, so its rule cannot drift from the type', () => {
    // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires -- a plain CommonJS plugin
    const plugin = require('../../eslint-plugin') as { DATA_RESULT_KEYS: readonly string[] };
    expect([...plugin.DATA_RESULT_KEYS].sort()).toEqual([...DATA_RESULT_KEYS].sort());
  });
});
