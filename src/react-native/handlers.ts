/** Answers the panel's calls, and pushes the stores' events to it as they are recorded. */

import { createRozeniteRpc } from '@rozenite/plugin-bridge';
import type { RozeniteDevToolsClient } from '@rozenite/plugin-bridge';
import type { InspectorEvent } from '@sleeperhq/react-native-cellar/inspector';
import { DUMP_CHUNK_BYTES } from '../shared/protocol';
import type { CellarEventMap, DatabaseDump, DumpChunk } from '../shared/protocol';
import type { CellarWireMethods } from '../shared/wire';
import { clearPartitionEtag, defaultInspector, ingestReport, listCaches, listStores, nitroDump, openDeviceFile, refetchPartition, runQuery, storeOf } from './operations';
import type { CellarInspector, DeviceFile, DumpDatabases, OpenDeviceFile } from './operations';

/** How long events gather before they go to the panel in one message, in ms. */
export const EVENT_FLUSH_MS = 100;
/** The most events one message carries; a busier interval goes out as several. */
export const EVENTS_PER_MESSAGE = 250;

/** Wires `client` up to answer the panel, and returns a function that unwires it. */
export function registerCellarHandlers(
  client: RozeniteDevToolsClient<CellarEventMap>,
  inspector: CellarInspector = defaultInspector,
  dump: DumpDatabases = nitroDump(),
  openFile: OpenDeviceFile = openDeviceFile,
): () => void {
  const rpc = createRozeniteRpc<CellarWireMethods>(client as unknown as RozeniteDevToolsClient);
  const json = async (result: unknown): Promise<string> => JSON.stringify((await result) ?? null);

  let latest: { path: string; file?: Promise<DeviceFile> } | undefined;
  const forgetLatest = (): void => {
    latest?.file?.then((file) => file.close(), () => undefined);
    latest = undefined;
  };
  const dumpAndRemember = async (): Promise<DatabaseDump> => {
    const written = await dump();
    forgetLatest();
    latest = { path: written.path };
    return written;
  };
  const readLatest = async (path: string, offset: number): Promise<DumpChunk> => {
    if (latest?.path !== path) throw new Error('Only the latest dump can be read; dump again.');
    const opening = (latest.file ??= openFile(path));
    try {
      const file = await opening;
      return { base64: await file.read(offset, DUMP_CHUNK_BYTES), size: file.size };
    } catch (error) {
      if (latest?.file === opening) latest.file = undefined;
      throw error;
    }
  };
  const subscriptions = [
    rpc.handle('stores', () => json(listStores(inspector))),
    rpc.handle('partitions', ({ store }) => json(storeOf(inspector, store).partitions())),
    rpc.handle('entity', ({ store, key, id }) => json(storeOf(inspector, store).entity(key, id))),
    rpc.handle('entityChanges', ({ store, key, limit }) => json(storeOf(inspector, store).entityChanges(key, limit))),
    rpc.handle('caches', ({ store, heap }) => json(listCaches(inspector, store, heap))),
    rpc.handle('cacheEntries', ({ store, cache, offset, limit }) => json(storeOf(inspector, store).cacheEntries(cache, { offset, limit }))),
    rpc.handle('query', (params) => json(runQuery(inspector, params))),
    rpc.handle('refetch', (params) => json(refetchPartition(inspector, params))),
    rpc.handle('clearEtag', (params) => json(clearPartitionEtag(inspector, params))),
    rpc.handle('events', ({ afterId }) => json(inspector.recentInspectorEvents(afterId))),
    rpc.handle('ingest', () => json(ingestReport(inspector))),
    rpc.handle('dump', () => json(dumpAndRemember())),
    rpc.handle('dumpName', () => json(dump.fileName)),
    rpc.handle('readDump', ({ path, offset }) => json(readLatest(path, offset))),
  ];

  let pending: InspectorEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = (): void => {
    timer = undefined;
    const events = pending;
    pending = [];
    for (let start = 0; start < events.length; start += EVENTS_PER_MESSAGE) {
      client.send('cellar:events', { json: JSON.stringify(events.slice(start, start + EVENTS_PER_MESSAGE)) });
    }
  };
  const stopListening = inspector.onInspectorEvent((event) => {
    pending.push(event);
    timer ??= setTimeout(flush, EVENT_FLUSH_MS);
  });

  return () => {
    stopListening();
    if (timer !== undefined) clearTimeout(timer);
    pending = [];
    forgetLatest();
    subscriptions.forEach((subscription) => subscription.remove());
    rpc.close();
  };
}
