/**
 * What a store's `useValue` subscribes to, end to end: a read built from derived values wakes only for the entities it
 * names, and a read that takes rows straight off the table wakes for its whole partition, since it could have read
 * anything in it.
 */

import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import { definePartitions } from '../../define_partitions';
import { byEntity } from '../../read/derived_values';
import { createTestRowTable } from '../../testing/row_table';
import { createVersionAtom } from '../../reactivity/version_atom';
import { RowTableSchema } from '../../table/types';
import { installTestRuntime } from '../../testing/runtime';

installTestRuntime();
/* global globalThis */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Row = { sport: string; player_id: string; name: string };
const SCHEMA: RowTableSchema<Row> = {
  table: 'players',
  columns: { sport: { type: 'TEXT' }, player_id: { type: 'TEXT' }, name: { type: 'TEXT' } },
  primaryKey: ['sport', 'player_id'],
  entityId: 'player_id',
};

function store() {
  const table = createTestRowTable(SCHEMA);
  const version = createVersionAtom('entity_reads_test');
  const players = definePartitions<Row, { sport: string }>({
    name: 'players',
    table,
    version,
    key: { fields: ['sport'], where: ({ sport }) => ({ sport }) },
  });
  const { names } = players.defineCaches({ names: byEntity({ max: 64, fromRows: ([row]) => row.name }) });
  const PlayerNames = players.defineRead<{ sport: string; ids: string[] }, string[]>({
    select: ({ ids }, key) => names.atEach(key, ids),
    empty: [],
  });
  const RawNames = players.defineRead<{ sport: string }, string[]>({
    select: (_args, key) => table.find(players.where(key)).map((row) => row.name),
    empty: [],
  });
  const write = (rows: Row[]) =>
    act(() => {
      players.bump({ sport: 'nfl' }, table.overwrite({ sport: 'nfl' }, rows).changes);
    });
  return { PlayerNames, RawNames, write };
}

function renderCounting<T>(useHook: () => T) {
  const probe = { current: undefined as unknown as T, renders: 0 };
  const Component = () => {
    probe.current = useHook();
    probe.renders += 1;
    return null;
  };
  let renderer: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(React.createElement(Component));
  });
  return { probe, unmount: () => act(() => renderer.unmount()) };
}

const nfl = (id: string, name: string): Row => ({ sport: 'nfl', player_id: id, name });
const IDS = ['p1'];

describe('a read built from derived values', () => {
  it('sleeps through a write to another entity and wakes for its own', () => {
    const { PlayerNames, write } = store();
    write([nfl('p1', 'Alice'), nfl('p2', 'Bob')]);
    const { probe, unmount } = renderCounting(() => PlayerNames.useValue({ sport: 'nfl', ids: IDS }).data);
    expect(probe.current).toEqual(['Alice']);
    const settled = probe.renders;

    write([nfl('p1', 'Alice'), nfl('p2', 'Robert')]);
    expect(probe.renders).toBe(settled);

    write([nfl('p1', 'Alicia'), nfl('p2', 'Robert')]);
    expect(probe.current).toEqual(['Alicia']);
    expect(probe.renders).toBe(settled + 1);
    unmount();
  });

  it('shows the partition landing, even for an entity it does not hold', () => {
    const { PlayerNames, write } = store();
    const { probe, unmount } = renderCounting(() => PlayerNames.useValue({ sport: 'nfl', ids: IDS }).data);
    expect(probe.current).toEqual([]);

    write([nfl('p1', 'Alice')]);

    expect(probe.current).toEqual(['Alice']);
    unmount();
  });
});

describe('a read that takes rows straight off the table', () => {
  it('wakes for any write to its partition, since it could have read any row in it', () => {
    const { RawNames, write } = store();
    write([nfl('p1', 'Alice'), nfl('p2', 'Bob')]);
    const { probe, unmount } = renderCounting(() => RawNames.useValue({ sport: 'nfl' }).data);

    write([nfl('p1', 'Alice'), nfl('p2', 'Robert')]);

    expect(probe.current).toEqual(['Alice', 'Robert']);
    unmount();
  });
});
