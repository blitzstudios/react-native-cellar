import { createEtagRetirement, ETAG_RETIRE_INTERVAL_MS } from '../../write/etag_retirement';

const INTERVAL = ETAG_RETIRE_INTERVAL_MS;

describe('createEtagRetirement', () => {
  let now = 0;

  beforeEach(() => {
    now = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('retires the ETag on the first pushed write, so a partition still resyncs', () => {
    const clearEtag = jest.fn();
    createEtagRetirement(clearEtag, INTERVAL)('games:nfl:1');

    expect(clearEtag).toHaveBeenCalledWith('games:nfl:1');
  });

  it('retires it once across a burst, which is what lets the refetches in between take a 304', () => {
    const clearEtag = jest.fn();
    const retire = createEtagRetirement(clearEtag, INTERVAL);

    // Live scoring lands a write every couple of seconds.
    for (let i = 0; i < 60; i += 1) {
      retire('games:nfl:1');
      now += 2_000;
    }

    expect(clearEtag).toHaveBeenCalledTimes(1);
  });

  it('retires it again once the interval has passed, bounding how long a missed write sits uncorrected', () => {
    const clearEtag = jest.fn();
    const retire = createEtagRetirement(clearEtag, INTERVAL);

    retire('games:nfl:1');
    now += INTERVAL - 1;
    retire('games:nfl:1');
    expect(clearEtag).toHaveBeenCalledTimes(1);

    now += 1;
    retire('games:nfl:1');
    expect(clearEtag).toHaveBeenCalledTimes(2);
  });

  it('tracks partitions separately, so one busy partition does not suppress another', () => {
    const clearEtag = jest.fn();
    const retire = createEtagRetirement(clearEtag, INTERVAL);

    retire('games:nfl:1');
    retire('games:nfl:2');

    expect(clearEtag).toHaveBeenCalledTimes(2);
    expect(clearEtag).toHaveBeenNthCalledWith(1, 'games:nfl:1');
    expect(clearEtag).toHaveBeenNthCalledWith(2, 'games:nfl:2');
  });
});
