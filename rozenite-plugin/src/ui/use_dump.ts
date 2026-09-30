/** Loading a database dump into the panel: from the `?dump=` URL the dump opener serves it at, or from a picked file. */

import { useCallback, useEffect, useState } from 'react';
import initSqlJs from 'sql.js';
import type { SqlJsStatic } from 'sql.js';
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import type { StoreOverview } from '../shared/protocol';
import type { CellarRpc } from '../shared/wire';
import { createDumpRpc } from './dump_rpc';

export interface LoadedDump {
  name: string;
  bytes: number;
  rpc: CellarRpc;
  stores: StoreOverview[];
}

let engine: Promise<SqlJsStatic> | undefined;
const sqlJs = () => (engine ??= initSqlJs({ locateFile: () => wasmUrl }));

export function useDump() {
  const [dump, setDump] = useState<LoadedDump>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();

  const load = useCallback(async (name: string, read: () => Promise<ArrayBuffer>) => {
    setLoading(true);
    setError(undefined);
    try {
      const [SQL, buffer] = await Promise.all([sqlJs(), read()]);
      const { rpc, stores } = createDumpRpc(SQL, new Uint8Array(buffer), name);
      setDump({ name, bytes: buffer.byteLength, rpc, stores });
    } catch (caught) {
      setError(`Couldn't open ${name}: ${caught instanceof Error ? caught.message : String(caught)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  const openFile = useCallback((file: File) => load(file.name, () => file.arrayBuffer()), [load]);

  // The dump opener serves the file beside the panel and names it in the URL.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const url = params.get('dump');
    if (!url) return;
    const name = params.get('name') ?? url.split('/').pop() ?? 'dump.db';
    load(name, async () => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return response.arrayBuffer();
    });
  }, [load]);

  const close = () => {
    setDump(undefined);
    setError(undefined);
    const url = new URL(window.location.href);
    if (url.searchParams.has('dump')) {
      url.searchParams.delete('dump');
      url.searchParams.delete('name');
      window.history.replaceState(null, '', url);
    }
  };
  return { dump, loading, error, openFile, close, dismissError: () => setError(undefined) };
}
