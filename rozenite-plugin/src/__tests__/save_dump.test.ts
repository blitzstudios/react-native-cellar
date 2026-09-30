import { createRozeniteRpc, getRozeniteDevToolsClient } from '@rozenite/plugin-bridge';
import type { RozeniteDevToolsClient } from '@rozenite/plugin-bridge';
import { connectFakePair } from '@rozenite/testing';
import { afterEach, expect, it } from 'vitest';
import { registerCellarHandlers } from '../react-native/handlers';
import type { DeviceFile } from '../react-native/operations';
import { DUMP_CHUNK_BYTES, PLUGIN_ID } from '../shared/protocol';
import type { CellarEventMap, DatabaseDump } from '../shared/protocol';
import { parsingRpc } from '../shared/wire';
import type { CellarWireMethods } from '../shared/wire';
import { saveDump, stampedName } from '../ui/save_dump';
import type { SaveFilePicker, SaveProgress } from '../ui/save_dump';

const closers: Array<() => void> = [];
afterEach(() => closers.splice(0).forEach((close) => close()));

/** A dump of `size` bytes, each its offset mod 251, so a misplaced part shows. */
async function connect(size: number) {
  const bytes = Uint8Array.from({ length: size }, (_, index) => index % 251);
  const written: DatabaseDump = { name: 'test-dump.db', path: '/device/test-dump.db', bytes: size, tables: [] };
  const opened: string[] = [];
  let closed = 0;
  const openFile = async (path: string): Promise<DeviceFile> => {
    opened.push(path);
    return {
      size,
      read: async (offset, length) => Buffer.from(bytes.subarray(offset, offset + length)).toString('base64'),
      close: () => {
        closed += 1;
      },
    };
  };
  const dump = Object.assign(async () => written, { fileName: 'test-dump.db' });

  const { device, panel } = connectFakePair();
  const deviceClient = await getRozeniteDevToolsClient<CellarEventMap>(PLUGIN_ID, { channel: device });
  const panelClient = await getRozeniteDevToolsClient<CellarEventMap>(PLUGIN_ID, { channel: panel });
  const unregister = registerCellarHandlers(deviceClient, undefined, dump, openFile);
  const wire = createRozeniteRpc<CellarWireMethods>(panelClient as unknown as RozeniteDevToolsClient);
  closers.push(() => {
    wire.close();
    unregister();
    deviceClient.close();
    panelClient.close();
  });
  return { rpc: parsingRpc(wire), bytes, opened, closedCount: () => closed };
}

function pickerInto(chunks: Uint8Array[], name = 'picked.db'): { pick: SaveFilePicker; suggested: string[]; closed: () => boolean } {
  const suggested: string[] = [];
  let closed = false;
  return {
    suggested,
    closed: () => closed,
    pick: async ({ suggestedName }) => {
      suggested.push(suggestedName);
      return {
        name,
        createWritable: async () => ({
          write: async (data) => {
            chunks.push(data);
          },
          close: async () => {
            closed = true;
          },
          abort: async () => undefined,
        }),
      };
    },
  };
}

it('writes the whole dump into the picked file, part by part, in order', async () => {
  const size = DUMP_CHUNK_BYTES * 2 + 123;
  const { rpc, bytes, opened } = await connect(size);
  const chunks: Uint8Array[] = [];
  const picker = pickerInto(chunks);
  const progress: SaveProgress[] = [];

  const saved = await saveDump(rpc, await rpc.method('dumpName').invoke(), (step) => progress.push(step), picker.pick);

  expect(saved).toEqual({ name: 'picked.db', bytes: size });
  expect(picker.suggested[0]).toMatch(/^test-dump-\d{4}-\d{2}-\d{2}-\d{6}\.db$/);
  expect(chunks).toHaveLength(3);
  const joined = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    joined.set(chunk, at);
    at += chunk.length;
  }
  expect(joined).toEqual(bytes);
  expect(picker.closed()).toBe(true);
  expect(opened).toEqual(['/device/test-dump.db']);
  expect(progress.at(-1)).toEqual({ saved: size, size });
});

it('does nothing when the picker is cancelled', async () => {
  const { rpc, opened } = await connect(10);
  const cancel: SaveFilePicker = () => Promise.reject(Object.assign(new Error('The user aborted a request.'), { name: 'AbortError' }));
  expect(await saveDump(rpc, 'test-dump.db', () => undefined, cancel)).toBeUndefined();
  expect(opened).toEqual([]);
});

it('reads only the latest dump, and lets go of a file once the next dump replaces it', async () => {
  const { rpc, closedCount } = await connect(10);
  await expect(rpc.method('readDump').invoke({ path: '/device/other.db', offset: 0 })).rejects.toBeTruthy();
  const first = await rpc.method('dump').invoke();
  expect((await rpc.method('readDump').invoke({ path: first.path, offset: 0 })).size).toBe(10);
  await rpc.method('dump').invoke();
  expect(closedCount()).toBe(1);
});

it('stamps the time before the extension', () => {
  expect(stampedName('sleeper-db-dump.db', new Date(2026, 8, 30, 16, 32, 5))).toBe('sleeper-db-dump-2026-09-30-163205.db');
  expect(stampedName('dump', new Date(2026, 0, 2, 3, 4, 5))).toBe('dump-2026-01-02-030405');
});
