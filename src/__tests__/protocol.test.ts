import { createRozeniteRpc, getRozeniteDevToolsClient, isHandlerError } from '@rozenite/plugin-bridge';
import type { RozeniteDevToolsClient } from '@rozenite/plugin-bridge';
import { connectFakePair, waitForMessage } from '@rozenite/testing';
import { clearInspectorEvents } from '@sleeperhq/react-native-cellar/inspector';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerCellarHandlers } from '../react-native/handlers';
import { PLUGIN_ID } from '../shared/protocol';
import type { CellarEventMap, CellarMethods } from '../shared/protocol';
import { NBA, NFL, NFL_GAMES, gamesStore } from './fixtures';

async function connect() {
  const { device, panel } = connectFakePair();
  const deviceClient = await getRozeniteDevToolsClient<CellarEventMap>(PLUGIN_ID, { channel: device });
  const panelClient = await getRozeniteDevToolsClient<CellarEventMap>(PLUGIN_ID, { channel: panel });
  const unregister = registerCellarHandlers(deviceClient);
  const rpc = createRozeniteRpc<CellarMethods>(panelClient as unknown as RozeniteDevToolsClient);
  return {
    rpc,
    panelClient,
    close: () => {
      rpc.close();
      unregister();
      deviceClient.close();
      panelClient.close();
    },
  };
}

let session: Awaited<ReturnType<typeof connect>>;

beforeEach(async () => {
  clearInspectorEvents();
  session = await connect();
});

afterEach(() => session.close());

describe('the calls the panel makes', () => {
  it('lists every store with its schema and totals', async () => {
    const store = await gamesStore('protocol_list_store');
    store.lifecycle.put(NFL, NFL_GAMES);

    const stores = await session.rpc.method('stores').invoke();
    const listed = stores.find((candidate) => candidate.name === 'protocol_list_store');
    expect(listed).toMatchObject({
      schema: { table: 'games', entityColumn: 'team', reads: ['teams'] },
      summary: { binding: { state: 'database', database: 'sql.js:protocol_list_store' }, rows: 3, partitions: 1 },
    });
  });

  it("reads a store's partitions", async () => {
    const store = await gamesStore('protocol_partitions_store');
    store.lifecycle.put(NFL, NFL_GAMES);
    store.lifecycle.put(NBA, [{ team: 'BOS', sport: 'nba', score: 101 }]);
    store.lifecycle.setEtag(NFL, 'W/"3"');

    expect(await session.rpc.method('partitions').invoke({ store: 'protocol_partitions_store' })).toEqual([
      { key: 'nba:2026', partition: NBA, rows: 1, version: 1, etag: null, fetchedAt: null },
      { key: 'nfl:2026', partition: NFL, rows: 3, version: 1, etag: 'W/"3"', fetchedAt: null },
    ]);
  });

  it('runs a read-only query with params and a limit', async () => {
    const store = await gamesStore('protocol_query_store');
    store.lifecycle.put(NFL, NFL_GAMES);

    const result = await session.rpc
      .method('query')
      .invoke({ store: 'protocol_query_store', sql: 'SELECT team, score FROM games WHERE partition_key = ? ORDER BY team', params: ['nfl:2026'], limit: 2 });
    expect(result).toMatchObject({ columns: ['team', 'score'], rows: [['BUF', 24], ['KC', 27]], truncated: true });
  });

  it("sends a refused write back as the handler's error", async () => {
    await gamesStore('protocol_refusing_store');
    const call = session.rpc.method('query').invoke({ store: 'protocol_refusing_store', sql: 'DELETE FROM games' });
    const error = await call.catch((caught: unknown) => caught);
    expect(isHandlerError(error)).toBe(true);
    expect(isHandlerError(error) && error.remote.message).toMatch(/only reads run here/i);
  });

  it('names the stores there are when asked for one that is not', async () => {
    await gamesStore('protocol_named_store');
    const error = await session.rpc
      .method('partitions')
      .invoke({ store: 'nope_store' })
      .catch((caught: unknown) => caught);
    expect(isHandlerError(error) && error.remote.message).toMatch(/Unknown store "nope_store"\. Stores: .*protocol_named_store/);
  });

  it('clears an ETag, and says a store without fetches cannot refetch', async () => {
    const store = await gamesStore('protocol_etag_store');
    store.lifecycle.put(NFL, NFL_GAMES);
    store.lifecycle.setEtag(NFL, 'W/"3"');

    await session.rpc.method('clearEtag').invoke({ store: 'protocol_etag_store', key: 'nfl:2026' });
    expect((await session.rpc.method('partitions').invoke({ store: 'protocol_etag_store' }))[0].etag).toBeNull();
    expect(await session.rpc.method('refetch').invoke({ store: 'protocol_etag_store', key: 'nfl:2026' })).toBe(false);
  });
});

describe('events', () => {
  it('pushes writes to the panel in one batch, and answers the backlog', async () => {
    const store = await gamesStore('protocol_events_store');
    const pushed = waitForMessage<CellarEventMap, 'cellar:events'>(session.panelClient, 'cellar:events', { timeoutMs: 1000 }, ({ events }) => events.some((event) => event.kind === 'write'));
    store.lifecycle.put(NFL, NFL_GAMES);
    store.lifecycle.put(NBA, [{ team: 'BOS', sport: 'nba', score: 101 }]);

    const { events } = await pushed;
    expect(events.filter((event) => event.kind === 'write').map((event) => event.kind === 'write' && event.partition)).toEqual(['nfl:2026', 'nba:2026']);

    const backlog = await session.rpc.method('events').invoke({});
    expect(backlog.map((event) => event.kind)).toEqual(['binding', 'write', 'write']);
    const newest = backlog[backlog.length - 1];
    expect(await session.rpc.method('events').invoke({ afterId: newest.id })).toEqual([]);
  });

  it('stops pushing once unregistered', async () => {
    const store = await gamesStore('protocol_quiet_store');
    session.close();
    const { device, panel } = connectFakePair();
    const panelClient = await getRozeniteDevToolsClient<CellarEventMap>(PLUGIN_ID, { channel: panel });
    const deviceClient = await getRozeniteDevToolsClient<CellarEventMap>(PLUGIN_ID, { channel: device });
    registerCellarHandlers(deviceClient)();
    const pushed = waitForMessage<CellarEventMap, 'cellar:events'>(panelClient, 'cellar:events', { timeoutMs: 300 });
    store.lifecycle.put(NFL, NFL_GAMES);
    await expect(pushed).rejects.toThrow();
    session = await connect();
  });
});
