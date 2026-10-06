import { devWarnings } from '../../testing/dev_mode';
import { resetOnceGuards } from '../../diagnostics/once_guard';
import { reportStoreDegradation } from '../../diagnostics/telemetry';
import { configureCellar, INERT_ERRORS } from '../../runtime';

describe('reportStoreDegradation', () => {
  let captureException: jest.Mock;
  let captureMessage: jest.Mock;
  let warn: jest.SpyInstance;
  let random: jest.SpyInstance;

  beforeEach(() => {
    resetOnceGuards();
    captureException = jest.fn();
    captureMessage = jest.fn();
    configureCellar({ errors: { captureException, captureMessage } });
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    // Sampling is on by default, so every assertion about a report needs the dice fixed.
    random = jest.spyOn(Math, 'random').mockReturnValue(0);
  });

  afterEach(() => {
    configureCellar({ errors: INERT_ERRORS });
    warn.mockRestore();
    random.mockRestore();
  });

  it('reports with a queryable tag and a per-site fingerprint', () => {
    const error = new Error('unsupported op on this build');
    reportStoreDegradation({ scope: 'row_table.native_shred.leaderboard', context: 'shred fell back to JS', error, extra: { table: 'leaderboard' } });

    expect(captureException).toHaveBeenCalledTimes(1);
    const [reported, ctx] = captureException.mock.calls[0];
    expect(reported).toBe(error);
    expect(ctx.tags).toEqual({ cellar_degradation: 'row_table.native_shred.leaderboard' });
    expect(ctx.fingerprint).toEqual(['cellar-degradation', 'row_table.native_shred.leaderboard']);
    expect(ctx.extra).toEqual({ context: 'shred fell back to JS', table: 'leaderboard' });
  });

  it('reports each site once per session', () => {
    for (let index = 0; index < 5; index += 1) {
      reportStoreDegradation({ scope: 'row_table.native_shred.leaderboard', context: 'shred fell back to JS', error: new Error(`attempt ${index}`) });
    }
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(devWarnings(1));
    expect(captureException.mock.calls[0][0].message).toBe('attempt 0');
  });

  it('samples info reports at the sink’s rate, and never errors', () => {
    configureCellar({ errors: { captureException, captureMessage, infoSampleRate: 0.01 } });
    random.mockReturnValue(0.5);
    reportStoreDegradation({ scope: 'player_stats_store.oversized_prime.week', context: 'large', severity: 'info' });
    reportStoreDegradation({ scope: 'row_table.native_shred.week', context: 'fell back' });
    expect(captureMessage).not.toHaveBeenCalled();
    expect(captureException).toHaveBeenCalledTimes(1);

    random.mockReturnValue(0.005);
    reportStoreDegradation({ scope: 'player_stats_store.oversized_prime.season', context: 'large', severity: 'info' });
    expect(captureMessage).toHaveBeenCalledTimes(1);
  });

  it('dedups per site, not globally', () => {
    reportStoreDegradation({ scope: 'row_table.native_shred.leaderboard', context: 'a' });
    reportStoreDegradation({ scope: 'row_table.native_shred.schedule', context: 'b' });
    expect(captureException).toHaveBeenCalledTimes(2);
  });

  it('synthesizes an Error when the thrown value is not one', () => {
    reportStoreDegradation({ scope: 'leaderboard_store.flush', context: 'flush failed', error: 'a string throw' });
    const [reported] = captureException.mock.calls[0];
    expect(reported).toBeInstanceOf(Error);
    expect(reported.message).toBe('leaderboard_store.flush: flush failed');
  });

  it('does not throw when the host configured no reporter, and still says so where anyone can see it', () => {
    configureCellar({ errors: INERT_ERRORS });
    expect(() => reportStoreDegradation({ scope: 'row_table.native_shred.item', context: 'shred fell back to JS' })).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(devWarnings(1));
  });

  describe('sampling', () => {
    it('drops the session the sample misses, so a fleet-wide cause cannot flood the quota', () => {
      random.mockReturnValue(0.5);
      reportStoreDegradation({ scope: 'row_table.native_shred.leaderboard', context: 'shred fell back to JS', sampleRate: 0.01 });
      expect(captureException).not.toHaveBeenCalled();
    });

    it('still warns locally when the sample misses: development has no quota to protect', () => {
      random.mockReturnValue(0.5);
      reportStoreDegradation({ scope: 'row_table.native_shred.leaderboard', context: 'shred fell back to JS', sampleRate: 0.01 });
      expect(warn).toHaveBeenCalledTimes(devWarnings(1));
    });

    it('marks the site seen even when the sample misses, so the rate is a share of sessions not of occurrences', () => {
      random.mockReturnValue(0.5);
      reportStoreDegradation({ scope: 'row_table.native_shred.leaderboard', context: 'first', sampleRate: 0.01 });
      random.mockReturnValue(0);
      reportStoreDegradation({ scope: 'row_table.native_shred.leaderboard', context: 'second', sampleRate: 0.01 });
      expect(captureException).not.toHaveBeenCalled();
    });

    it('reports every session by default, so a fallback that should be rare is not quietly thinned out', () => {
      random.mockReturnValue(0.999999);
      reportStoreDegradation({ scope: 'row_table.native_shred.leaderboard', context: 'shred fell back to JS' });
      expect(captureException).toHaveBeenCalledTimes(1);
    });
  });

  describe('severity', () => {
    it("sends a chosen degradation as a message, not an exception on somebody's error budget", () => {
      reportStoreDegradation({ scope: 'cellar_kill_switch.item', context: 'the kill switch disabled this store', severity: 'info', sampleRate: 1 });

      expect(captureException).not.toHaveBeenCalled();
      expect(captureMessage).toHaveBeenCalledTimes(1);
      const [message, ctx] = captureMessage.mock.calls[0];
      expect(message).toBe('cellar_kill_switch.item: the kill switch disabled this store');
      expect(ctx.level).toBe('info');
      expect(ctx.fingerprint).toEqual(['cellar-notice']);
    });

    it('groups an error by its kind across stores, keeping the store in its tag', () => {
      reportStoreDegradation({ scope: 'player_store.in_memory', group: 'store.in_memory', context: 'moved to memory', error: new Error('boom') });
      reportStoreDegradation({ scope: 'schedule_store.in_memory', group: 'store.in_memory', context: 'moved to memory', error: new Error('boom') });

      expect(captureException.mock.calls.map(([, ctx]) => ctx.fingerprint)).toEqual([
        ['cellar-degradation', 'store.in_memory'],
        ['cellar-degradation', 'store.in_memory'],
      ]);
      expect(captureException.mock.calls.map(([, ctx]) => ctx.tags.cellar_degradation)).toEqual(['player_store.in_memory', 'schedule_store.in_memory']);
    });

    it('defaults to an exception, so an unexpected fallback keeps its stack', () => {
      const error = new Error('no native module');
      reportStoreDegradation({ scope: 'row_table.native_shred.item', context: 'shred fell back to JS', error, sampleRate: 1 });
      expect(captureMessage).not.toHaveBeenCalled();
      expect(captureException).toHaveBeenCalledWith(error, expect.anything());
    });

    it('sends a storage failure as a notice, since the device is out of space or won’t open the file', () => {
      reportStoreDegradation({ scope: 'a.in_memory', context: 'moved to memory', error: new Error('disk I/O error') });

      expect(captureException).not.toHaveBeenCalled();
      expect(captureMessage.mock.calls[0][1].level).toBe('info');
    });

    it('sends nothing below the sink’s minimum severity', () => {
      configureCellar({ errors: { captureException, captureMessage, minSeverity: 'info' } });
      reportStoreDegradation({ scope: 'a.advice', context: 'advice', severity: 'verbose' });
      reportStoreDegradation({ scope: 'a.notice', context: 'notice', severity: 'info' });

      expect(captureMessage).toHaveBeenCalledTimes(1);
      expect(captureMessage.mock.calls[0][0]).toBe('a.notice: notice');
    });
  });
});
