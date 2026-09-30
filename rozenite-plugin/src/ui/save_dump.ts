/**
 * Saving the app's databases from the panel: the user picks where first, since a browser shows its file picker only
 * straight from a click, then the app dumps and the file comes over in parts, each written as it arrives.
 */

import { useEffect, useState } from 'react';
import { errorMessage } from './use_cellar';
import type { CellarRpc } from './use_cellar';

export interface SaveProgress {
  saved: number;
  size: number;
}

export interface SavedDump {
  name: string;
  bytes: number;
}

interface WritableFile {
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}

interface PickedFile {
  name: string;
  createWritable(): Promise<WritableFile>;
}

/** The File System Access API's `showSaveFilePicker`, which Chromium has and other browsers don't. */
export type SaveFilePicker = (options: {
  suggestedName: string;
  types: Array<{ description: string; accept: Record<string, string[]> }>;
}) => Promise<PickedFile>;

const SQLITE_TYPE = 'application/x-sqlite3';

export const browserSaveFilePicker = (): SaveFilePicker | undefined => (window as unknown as { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker?.bind(window);

/** `name` with the time before its extension: `sleeper-db-dump.db` → `sleeper-db-dump-2026-09-30-163205.db`. */
export function stampedName(name: string, at: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  const stamp = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
  const dot = name.lastIndexOf('.');
  return dot > 0 ? `${name.slice(0, dot)}-${stamp}${name.slice(dot)}` : `${name}-${stamp}`;
}

function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function download(parts: Uint8Array[], name: string): void {
  const url = URL.createObjectURL(new Blob(parts as BlobPart[], { type: SQLITE_TYPE }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * Asks where to save, dumps the app's databases and writes the file there, reporting progress as parts arrive.
 * Resolves with what was saved, or undefined when the user cancels the picker. Without a picker the file downloads.
 */
export async function saveDump(
  rpc: CellarRpc,
  fileName: string,
  onProgress: (progress: SaveProgress) => void,
  pick: SaveFilePicker | undefined = browserSaveFilePicker(),
): Promise<SavedDump | undefined> {
  const suggestedName = stampedName(fileName);
  let picked: PickedFile | undefined;
  if (pick) {
    try {
      picked = await pick({ suggestedName, types: [{ description: 'SQLite database', accept: { [SQLITE_TYPE]: ['.db'] } }] });
    } catch (error) {
      if ((error as Error | undefined)?.name === 'AbortError') return undefined;
      // A frame that may not show a picker: download instead.
    }
  }

  onProgress({ saved: 0, size: 0 });
  const dump = await rpc.method('dump', { timeoutMs: 120_000 }).invoke();
  onProgress({ saved: 0, size: dump.bytes });
  const writable = await picked?.createWritable();
  const parts: Uint8Array[] = [];
  let offset = 0;
  let size = dump.bytes;
  try {
    do {
      // eslint-disable-next-line no-await-in-loop
      const chunk = await rpc.method('readDump', { timeoutMs: 60_000 }).invoke({ path: dump.path, offset });
      size = chunk.size;
      const bytes = decodeBase64(chunk.base64);
      if (!bytes.length && offset < size) throw new Error(`The dump ended at ${offset} of ${size} bytes.`);
      // eslint-disable-next-line no-await-in-loop
      if (writable) await writable.write(bytes);
      else parts.push(bytes);
      offset += bytes.length;
      onProgress({ saved: offset, size });
    } while (offset < size);
  } catch (error) {
    await writable?.abort().catch(() => undefined);
    throw error;
  }
  if (writable) await writable.close();
  else download(parts, suggestedName);
  return { name: picked?.name ?? suggestedName, bytes: size };
}

/** The sidebar's Save: what it's doing, what it last saved or why it couldn't. */
export function useSaveDump(rpc: CellarRpc | null) {
  const [fileName, setFileName] = useState('cellar-dump.db');
  const [progress, setProgress] = useState<SaveProgress>();
  const [saved, setSaved] = useState<SavedDump>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!rpc) return undefined;
    let current = true;
    rpc
      .method('dumpName')
      .invoke()
      .then(
        (name) => current && setFileName(name),
        () => undefined,
      );
    return () => {
      current = false;
    };
  }, [rpc]);

  const save = async (target: CellarRpc) => {
    setSaved(undefined);
    setError(undefined);
    try {
      const result = await saveDump(target, fileName, setProgress);
      if (result) setSaved(result);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setProgress(undefined);
    }
  };
  const dismiss = () => {
    setSaved(undefined);
    setError(undefined);
  };
  return { progress, saved, error, save, dismiss };
}
