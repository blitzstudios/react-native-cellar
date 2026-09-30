import { describe, expect, it } from 'vitest';
import { formatAgo, formatCell, formatFetchRows, parseJsonText, parseParams, toCsv, toJsonRows } from '../ui/format';
import { scopeNamesStore } from '../ui/activity_view';
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
