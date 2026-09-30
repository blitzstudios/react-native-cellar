import { getRozeniteDevToolsClient } from '@rozenite/plugin-bridge';
import { RozeniteChannelProvider, connectFakePair } from '@rozenite/testing';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { registerCellarHandlers } from '../react-native/handlers';
import { PLUGIN_ID } from '../shared/protocol';
import type { CellarEventMap } from '../shared/protocol';
import CellarPanel from '../ui/panel';
import { NFL, NFL_GAMES, gamesStore } from './fixtures';

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
  expect(await screen.findByText('nfl:2026')).toBeTruthy();

  fireEvent.click(screen.getByTitle("Query this partition's rows"));
  expect(await screen.findByText('KC')).toBeTruthy();
  expect(screen.getByText('BUF')).toBeTruthy();
  expect((screen.getByLabelText('Params') as HTMLInputElement).value).toBe('["nfl:2026"]');
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
  await waitFor(() => expect(screen.getAllByText('nfl:2026').length).toBeGreaterThan(0), { timeout: 3000 });
  expect(screen.getAllByText('panel_activity').length).toBeGreaterThan(0);

  fireEvent.click(within(sidebar).getByTitle('panel_activity_store'));
  fireEvent.click(await screen.findByRole('tab', { name: 'Caches' }));
  expect(await screen.findByText('No caches')).toBeTruthy();
});

it('lists a store’s entities and shows one across its partitions', async () => {
  const store = await gamesStore('panel_entities_store');
  store.lifecycle.put(NFL, NFL_GAMES);
  await renderPanel();

  fireEvent.click(await within(await screen.findByRole('navigation')).findByTitle('panel_entities_store'));
  fireEvent.click(await screen.findByRole('tab', { name: 'Entities' }));
  fireEvent.click(await screen.findByText('MIA'));
  expect(await screen.findByRole('heading', { name: 'MIA' })).toBeTruthy();
  expect((await screen.findAllByText('nfl:2026')).length).toBeGreaterThan(0);
});
