import { clearInspectorEvents } from '@sleeperhq/react-native-cellar/inspector';
import { beforeEach, describe, expect, it } from 'vitest';
import { agentToolHandlers, cellarAgentTools } from '../react-native/agent_tool_contracts';
import { defaultInspector } from '../react-native/operations';
import { NBA, NFL, NFL_GAMES, gamesStore } from './fixtures';

const tools = agentToolHandlers(defaultInspector);

beforeEach(() => clearInspectorEvents());

describe('the agent tools', () => {
  it('declares each tool with a kebab-case name, a description and an object schema', () => {
    for (const tool of Object.values(cellarAgentTools)) {
      expect(tool.name).toMatch(/^[a-z]+(-[a-z]+)*$/);
      expect(tool.description.length).toBeGreaterThan(40);
      expect(tool.inputSchema.type).toBe('object');
    }
    expect(Object.keys(cellarAgentTools).sort()).toEqual(Object.keys(tools).sort());
  });

  it('lists the stores with their table and totals', async () => {
    const store = await gamesStore('agent_list_store');
    store.lifecycle.put(NFL, NFL_GAMES);
    const { stores } = await tools.listStores();
    expect(stores.find((candidate) => candidate.name === 'agent_list_store')).toMatchObject({
      table: 'games',
      binding: { state: 'database' },
      rows: 3,
      partitions: 1,
    });
  });

  it('describes a store', async () => {
    await gamesStore('agent_describe_store');
    expect(await tools.describeStore({ store: 'agent_describe_store' })).toMatchObject({
      name: 'agent_describe_store',
      table: 'games',
      entityColumn: 'team',
      primaryKey: ['partition_key', 'sport', 'team'],
      binding: { state: 'database' },
    });
  });

  it('lists partitions matching a key, up to a limit, with the total', async () => {
    const store = await gamesStore('agent_partitions_store');
    store.lifecycle.put(NFL, NFL_GAMES);
    store.lifecycle.put(NBA, [{ team: 'BOS', sport: 'nba', score: 101 }]);
    expect(await tools.listPartitions({ store: 'agent_partitions_store', match: 'nfl' })).toMatchObject({ total: 1, partitions: [{ key: 'season=2026&sport=nfl', rows: 3 }] });
    expect(await tools.listPartitions({ store: 'agent_partitions_store', limit: 1 })).toMatchObject({ total: 2, partitions: [{ key: 'season=2026&sport=nba' }] });
  });

  it('queries, and refuses a write', async () => {
    const store = await gamesStore('agent_query_store');
    store.lifecycle.put(NFL, NFL_GAMES);
    expect(await tools.query({ store: 'agent_query_store', sql: 'SELECT COUNT(*) AS n FROM games' })).toMatchObject({ columns: ['n'], rows: [[3]] });
    await expect(tools.query({ store: 'agent_query_store', sql: 'UPDATE games SET score = 0' })).rejects.toThrow(/only reads run here/i);
  });

  it('filters recent events by store and kind, newest last, up to a limit', async () => {
    const store = await gamesStore('agent_events_store');
    store.lifecycle.put(NFL, NFL_GAMES);
    store.lifecycle.put(NBA, [{ team: 'BOS', sport: 'nba', score: 101 }]);
    const { events } = await tools.recentEvents({ store: 'agent_events_store', kinds: ['write'], limit: 1 });
    expect(events).toEqual([expect.objectContaining({ kind: 'write', store: 'agent_events_store', partition: 'season=2026&sport=nba' })]);
  });

  it('pages a query, lists entity changes and caches', async () => {
    const store = await gamesStore('agent_more_store');
    store.lifecycle.put(NFL, NFL_GAMES);
    expect(await tools.query({ store: 'agent_more_store', sql: 'SELECT team FROM games ORDER BY team', limit: 1, offset: 1 })).toMatchObject({ rows: [['KC']], truncated: true, offset: 1 });
    expect(await tools.entityChanges({ store: 'agent_more_store', key: 'season=2026&sport=nfl' })).toMatchObject({ version: 1, epoch: 1, count: 0 });
    expect(await tools.listCaches({ store: 'agent_more_store' })).toEqual({ caches: [] });
  });

  it('reports ingest timings with totals', async () => {
    expect(await tools.ingestTimings({})).toEqual({ timings: expect.any(Array), rollup: expect.any(Array) });
  });
});
