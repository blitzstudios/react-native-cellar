import { getRozeniteDevToolsClient } from '@rozenite/plugin-bridge';
import { RozeniteChannelProvider, connectFakePair } from '@rozenite/testing';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { SqlJsStatic } from 'sql.js';
import { afterEach, expect, it, vi } from 'vitest';
import { registerCellarHandlers } from '../react-native/handlers';
import { PLUGIN_ID } from '../shared/protocol';
import type { CellarEventMap } from '../shared/protocol';
import CellarPanel from '../ui/panel';
import { NBA, NFL, NFL_GAMES, gamesStore, loadSqlJs } from './fixtures';

vi.mock('sql.js/dist/sql-wasm.wasm?url', async () => {
  const { createRequire } = await import('node:module');
  const path = await import('node:path');
  return { default: path.join(path.dirname(createRequire(import.meta.url).resolve('sql.js')), 'sql-wasm.wasm') };
});

/** A picked file; jsdom's File has no arrayBuffer(). */
const fileOf = (bytes: Uint8Array, name: string) => Object.assign(new File([bytes as BlobPart], name), { arrayBuffer: async () => bytes.slice().buffer });

const closers: Array<() => void> = [];

afterEach(() => {
  cleanup();
  closers.splice(0).forEach((close) => close());
});

async function renderPanel() {
  const { device, panel } = connectFakePair();
  const deviceClient = await getRozeniteDevToolsClient<CellarEventMap>(PLUGIN_ID, { channel: device });
  const unregister = registerCellarHandlers(deviceClient);
  closers.push(() => {
    unregister();
    deviceClient.close();
  });
  render(
    <RozeniteChannelProvider channel={panel} role="panel">
      <CellarPanel />
    </RozeniteChannelProvider>,
  );
}

it('lists the stores, shows a store’s partitions, and queries a partition’s rows', async () => {
  const store = await gamesStore('panel_games_store');
  store.lifecycle.put(NFL, NFL_GAMES);
  await renderPanel();

  const sidebar = await screen.findByRole('navigation');
  fireEvent.click(await within(sidebar).findByTitle('panel_games_store'));

  expect(await screen.findByRole('heading', { name: 'panel_games' })).toBeTruthy();
  expect(await screen.findByText('season=2026&sport=nfl')).toBeTruthy();

  fireEvent.click(screen.getByTitle("Query this partition's rows"));
  expect(await screen.findByText('KC')).toBeTruthy();
  expect(screen.getByText('BUF')).toBeTruthy();
  expect((screen.getByLabelText('Params') as HTMLInputElement).value).toBe('["season=2026&sport=nfl"]');
});

it('shows a refused write as an error, and re-runs a live query when the store writes', async () => {
  const store = await gamesStore('panel_live_store');
  store.lifecycle.put(NFL, NFL_GAMES);
  await renderPanel();

  fireEvent.click(await within(await screen.findByRole('navigation')).findByTitle('panel_live_store'));
  fireEvent.click(await screen.findByRole('tab', { name: 'Query' }));

  const sql = screen.getByLabelText('SQL');
  fireEvent.change(sql, { target: { value: 'DELETE FROM games' } });
  fireEvent.click(screen.getByRole('button', { name: 'Run' }));
  expect((await screen.findByRole('alert')).textContent).toMatch(/only reads run here/i);

  fireEvent.change(sql, { target: { value: 'SELECT team FROM games ORDER BY team' } });
  fireEvent.click(screen.getByRole('button', { name: 'Run' }));
  expect(await screen.findByText('MIA')).toBeTruthy();

  fireEvent.click(screen.getByRole('checkbox', { name: 'Live' }));
  store.lifecycle.put(NFL, [...NFL_GAMES, { team: 'NYJ', sport: 'nfl', score: 3 }]);
  await waitFor(() => expect(screen.getByText('NYJ')).toBeTruthy(), { timeout: 3000 });
});

it('shows every store’s writes in the global activity feed, and a store’s caches in its own tab', async () => {
  const store = await gamesStore('panel_activity_store');
  await renderPanel();
  const sidebar = await screen.findByRole('navigation');
  await within(sidebar).findByTitle('panel_activity_store');
  store.lifecycle.put(NFL, NFL_GAMES);

  fireEvent.click(within(sidebar).getByText('Activity'));
  expect(await screen.findByRole('heading', { name: 'Activity' })).toBeTruthy();
  await waitFor(() => expect(screen.getAllByText('season=2026&sport=nfl').length).toBeGreaterThan(0), { timeout: 3000 });
  expect(screen.getAllByText('panel_activity').length).toBeGreaterThan(0);

  fireEvent.click(within(sidebar).getByTitle('panel_activity_store'));
  fireEvent.click(await screen.findByRole('tab', { name: 'Caches' }));
  expect(await screen.findByText('No caches')).toBeTruthy();
});

it('lists one partition’s entities at a time, and moves to another partition using the same id', async () => {
  const store = await gamesStore('panel_entities_store');
  store.lifecycle.put(NFL, NFL_GAMES);
  store.lifecycle.put(NBA, [{ team: 'MIA', sport: 'nba', score: 1 }]);
  await renderPanel();

  fireEvent.click(await within(await screen.findByRole('navigation')).findByTitle('panel_entities_store'));
  fireEvent.click(await screen.findByRole('tab', { name: 'Entities' }));
  const partition = (await screen.findByLabelText('Partition')) as HTMLSelectElement;
  await waitFor(() => expect(partition.value).toBe('season=2026&sport=nfl'));
  expect(await screen.findByText('KC')).toBeTruthy();
  fireEvent.click(screen.getByText('MIA'));
  expect(await screen.findByRole('heading', { name: 'MIA' })).toBeTruthy();

  fireEvent.click(await screen.findByRole('button', { name: 'season=2026&sport=nba' }));
  await waitFor(() => expect(partition.value).toBe('season=2026&sport=nba'));
  await waitFor(() => expect(screen.queryByText('KC')).toBeNull());
  expect(screen.getAllByText('MIA').length).toBeGreaterThan(0);
});

it('opens a dump from the sidebar, and its x goes back to the app', async () => {
  const store = await gamesStore('panel_dump_live_store');
  store.lifecycle.put(NFL, NFL_GAMES);
  const SQL = (await loadSqlJs()) as unknown as SqlJsStatic;
  const db = new SQL.Database();
  db.run(`
    CREATE TABLE players (partition_key TEXT, player_id TEXT);
    CREATE TABLE players_meta (partition_key TEXT, etag TEXT, partition TEXT);
    INSERT INTO players VALUES ('nfl', '1003');
  `);
  const bytes = db.export();
  db.close();
  await renderPanel();
  const sidebar = await screen.findByRole('navigation');
  await within(sidebar).findByTitle('panel_dump_live_store');

  fireEvent.change(within(sidebar).getByLabelText('Open dump'), { target: { files: [fileOf(bytes, 'tiny-dump.db')] } });
  const close = await within(sidebar).findByRole('button', { name: 'Close dump' }, { timeout: 3000 });
  expect(within(sidebar).getAllByTitle('tiny-dump.db').length).toBeGreaterThan(0);
  expect(within(sidebar).getByTitle('players')).toBeTruthy();
  expect(within(sidebar).queryByTitle('panel_dump_live_store')).toBeNull();

  fireEvent.click(close);
  expect(await within(sidebar).findByTitle('panel_dump_live_store')).toBeTruthy();
  expect(within(sidebar).queryAllByTitle('tiny-dump.db')).toHaveLength(0);
});

it('goes back from a dump that would not open', async () => {
  await renderPanel();
  const sidebar = await screen.findByRole('navigation');
  fireEvent.change(within(sidebar).getByLabelText('Open dump'), { target: { files: [fileOf(new Uint8Array([1, 2, 3]), 'broken.db')] } });
  expect(await screen.findByText(/Couldn't open broken\.db: (?!file\.arrayBuffer)/, {}, { timeout: 3000 })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Back to the app' }));
  expect(screen.queryByText("Couldn't open the dump")).toBeNull();
});

it('has Save and Open in the sidebar, Save once the app is connected', async () => {
  await renderPanel();
  const sidebar = await screen.findByRole('navigation');
  expect(within(sidebar).getByLabelText('Open dump')).toBeTruthy();
  await waitFor(() => expect((within(sidebar).getByRole('button', { name: 'Save dump' }) as HTMLButtonElement).disabled).toBe(false));
});
