import { describe, expect, it } from 'vitest';
import { formatAgo, formatCell, formatFetchRows, parseJsonText, parseParams, toCsv, toJsonRows } from '../ui/format';
import { scopeNamesStore } from '../ui/activity_view';
import { parseFrames, shortPath } from '../ui/callsite';
import { groupDegradations, splitScope } from '../ui/degradations';
import { fetchStatsOf } from '../ui/overview';
import { mergeEvents } from '../ui/use_cellar';
import type { InspectorEvent } from '../shared/protocol';

describe('params', () => {
  it('reads a JSON array, bare values, or nothing', () => {
    expect(parseParams('')).toEqual({ params: [] });
    expect(parseParams('["nfl:2026", 4, null]')).toEqual({ params: ['nfl:2026', 4, null] });
    expect(parseParams('"nfl:2026", 4')).toEqual({ params: ['nfl:2026', 4] });
  });

  it('refuses anything a bind cannot take', () => {
    expect(parseParams('[{"a": 1}]')).toEqual({ error: expect.stringMatching(/strings, numbers and nulls/) });
    expect(parseParams('[nope')).toEqual({ error: expect.stringMatching(/JSON array/) });
  });
});

describe('cells', () => {
  it('writes NULL, blobs and JSON on one line', () => {
    expect(formatCell(null)).toBe('NULL');
    expect(formatCell({ $blob: true, bytes: 2048, hex: 'ab' })).toBe('<blob 2.0 KB>');
    expect(formatCell(3)).toBe('3');
  });

  it('parses only text that holds an object or array', () => {
    expect(parseJsonText('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonText('[1]')).toEqual([1]);
    expect(parseJsonText('12')).toBeUndefined();
    expect(parseJsonText('{nope')).toBeUndefined();
  });

  it('exports rows as CSV, quoting what needs it, and as JSON objects', () => {
    expect(toCsv(['a', 'b'], [['x,y', null], ['say "hi"', 2]])).toBe('a,b\n"x,y",\n"say ""hi""",2');
    expect(JSON.parse(toJsonRows(['a', 'b'], [[1, 'x']]))).toEqual([{ a: 1, b: 'x' }]);
  });
});

describe('times and fetches', () => {
  it('writes how long ago', () => {
    expect(formatAgo(null, 10_000)).toBe('—');
    expect(formatAgo(9_500, 10_000)).toBe('1s ago');
    expect(formatAgo(10_000 - 125_000, 10_000)).toBe('2m ago');
  });

  it('names a 304 and an unchanged body', () => {
    expect(formatFetchRows(-1)).toBe('304 not modified');
    expect(formatFetchRows(-2)).toBe('unchanged body');
    expect(formatFetchRows(1200)).toBe('1,200 rows');
  });
});

describe('degradation scopes', () => {
  it("match the store they name, and not a store whose name they merely start with", () => {
    expect(scopeNamesStore('player_store.in_memory', 'player_store')).toBe(true);
    expect(scopeNamesStore('player_store_ingest.oversized_prime.mlb', 'player_store')).toBe(true);
    expect(scopeNamesStore('partitions.intern_evicted.player', 'player_store')).toBe(true);
    expect(scopeNamesStore('player_stats_store_ingest.oversized_prime.week:proj', 'player_store')).toBe(false);
    expect(scopeNamesStore('player_stats_store.reopened', 'player_store')).toBe(false);
  });
});

describe('the event log', () => {
  const write = (id: number): InspectorEvent => ({ kind: 'write', id, at: id, store: 's', partition: 'p', version: id, entities: 'all', entityCount: null });

  it('appends in order, and merges a backlog that races a push by id', () => {
    expect(mergeEvents([write(1)], [write(2), write(3)]).map((event) => event.id)).toEqual([1, 2, 3]);
    expect(mergeEvents([write(3), write(4)], [write(1), write(2), write(3)]).map((event) => event.id)).toEqual([1, 2, 3, 4]);
  });
});

describe('callsites', () => {
  it('parses JS stack lines and React owner stack lines, skipping the rest', () => {
    const stack = [
      'Error',
      '    at reportStoreDegradation (http://127.0.0.1:8081/index.bundle?platform=ios:1200:17)',
      '    at StatsScreen (http://127.0.0.1:8081/index.bundle?platform=ios:88:5)',
      '    at anonymous (address at http://127.0.0.1:8081/index.bundle?platform=ios:9:1)',
      '    at http://127.0.0.1:8081/index.bundle?platform=ios:3:4',
    ].join('\n');
    expect(parseFrames(stack)).toEqual([
      { method: 'reportStoreDegradation', file: 'http://127.0.0.1:8081/index.bundle?platform=ios', line: 1200, column: 17 },
      { method: 'StatsScreen', file: 'http://127.0.0.1:8081/index.bundle?platform=ios', line: 88, column: 5 },
      { method: 'anonymous', file: 'http://127.0.0.1:8081/index.bundle?platform=ios', line: 9, column: 1 },
      { method: '(anonymous)', file: 'http://127.0.0.1:8081/index.bundle?platform=ios', line: 3, column: 4 },
    ]);
  });

  it('shortens a source path to the repo', () => {
    expect(shortPath('/Users/me/projects/sleeperbot/clients/app-mobile/src/v2/stats/screen.tsx')).toBe('app-mobile/src/v2/stats/screen.tsx');
    expect(shortPath('/x/y/z/w.ts')).toBe('y/z/w.ts');
  });
});

describe('degradation groups', () => {
  const report = (id: number, scope: string, count: number): InspectorEvent => ({ kind: 'degradation', id, at: id, scope, context: 'c', severity: 'info', first: count === 1, count });

  it('groups reports by scope, newest first, counting every report', () => {
    const groups = groupDegradations([report(1, 'a.rule.x', 1), report(2, 'b.rule', 1), report(3, 'a.rule.x', 2)]);
    expect(groups.map((group) => [group.scope, group.count, group.latest.id])).toEqual([
      ['a.rule.x', 2, 3],
      ['b.rule', 1, 2],
    ]);
  });

  it('splits a scope into its rule and subject', () => {
    expect(splitScope('player_store_ingest.oversized_prime.mlb')).toEqual({ rule: 'oversized_prime', subject: 'mlb' });
    expect(splitScope('memo.undersized.player.byTeam')).toEqual({ rule: 'undersized', subject: 'player.byTeam' });
    expect(splitScope('player_stats_store.in_memory')).toEqual({ rule: 'in_memory', subject: 'player_stats_store' });
  });
});

describe('fetch stats', () => {
  it('totals each store, counts unchanged bodies, and names the slowest', () => {
    const at = (store: string, partition: string, fetchMs: number, ingestMs: number, rows: number) => ({ store, partition, fetchMs, ingestMs, rows, chars: 1, at: 0 });
    expect(fetchStatsOf([at('p', 'nfl', 100, 20, 10), at('p', 'nba', 50, 0, -1), at('s', 'w=1', 10, 5, 3)])).toEqual([
      { store: 'p', fetches: 2, unchanged: 1, fetchMs: 150, ingestMs: 20, rows: 10, slowest: { ms: 120, partition: 'nfl' } },
      { store: 's', fetches: 1, unchanged: 0, fetchMs: 10, ingestMs: 5, rows: 3, slowest: { ms: 15, partition: 'w=1' } },
    ]);
  });
});
