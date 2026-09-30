/** The panel's connection to the app: the RPC calls, the store list, and the event log as it grows. */

import { createRozeniteRpc, isHandlerError, isProtocolError, useRozeniteDevToolsClient } from '@rozenite/plugin-bridge';
import type { RozeniteDevToolsClient } from '@rozenite/plugin-bridge';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PLUGIN_ID } from '../shared/protocol';
import type { CellarEventMap, InspectorEvent, StoreOverview } from '../shared/protocol';
import { parsingRpc } from '../shared/wire';
import type { CellarRpc, CellarWireMethods } from '../shared/wire';

/** How many events the panel keeps; the app keeps fewer, so this is room for a long session in the panel. */
export const PANEL_EVENT_CAPACITY = 5000;
/** How often the store list is re-read while writes keep arriving, at most, in ms. */
const STORE_REFRESH_MS = 2000;
/** How often the panel asks again while the app hasn't answered, in ms. */
const RETRY_MS = 2000;

export type ConnectionState = 'connecting' | 'connected' | 'unavailable';

export type { CellarRpc };

export interface CellarConnection {
  state: ConnectionState;
  /** Why the last call to the app failed, while it isn't answering. */
  problem?: string;
  rpc: CellarRpc | null;
  stores: StoreOverview[];
  /** Every event seen, oldest first. */
  events: InspectorEvent[];
  /** Reads the store list again now. */
  refreshStores: () => void;
}

/** A failed call's message, as the panel shows it. */
export function errorMessage(error: unknown): string {
  if (isHandlerError(error)) return error.remote.message;
  if (isProtocolError(error)) {
    return error.code === 'ACK_TIMEOUT' ? 'The app is not answering. Is it running, with useCellarDevTools() mounted?' : `${error.code}: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/** Merges `incoming` into `events` by id, keeping order and the newest `PANEL_EVENT_CAPACITY`. */
export function mergeEvents(events: readonly InspectorEvent[], incoming: readonly InspectorEvent[]): InspectorEvent[] {
  if (!incoming.length) return events as InspectorEvent[];
  const last = events.length ? events[events.length - 1].id : 0;
  // Events arrive in order almost always; only a backlog racing a push needs the slow path.
  const merged = incoming.every((event) => event.id > last) && incoming.every((event, i) => i === 0 || event.id > incoming[i - 1].id)
    ? [...events, ...incoming]
    : Array.from(new Map([...events, ...incoming].map((event) => [event.id, event])).values()).sort((a, b) => a.id - b.id);
  return merged.length > PANEL_EVENT_CAPACITY ? merged.slice(merged.length - PANEL_EVENT_CAPACITY) : merged;
}

export function useCellarConnection(): CellarConnection {
  const client = useRozeniteDevToolsClient<CellarEventMap>({ pluginId: PLUGIN_ID });
  const wire = useMemo(() => (client ? createRozeniteRpc<CellarWireMethods>(client as unknown as RozeniteDevToolsClient) : null), [client]);
  useEffect(() => () => wire?.close(), [wire]);
  const rpc = useMemo(() => (wire ? parsingRpc(wire) : null), [wire]);

  const [state, setState] = useState<ConnectionState>('connecting');
  const [problem, setProblem] = useState<string>();
  const [stores, setStores] = useState<StoreOverview[]>([]);
  const [events, setEvents] = useState<InspectorEvent[]>([]);
  const lastRefresh = useRef(0);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const loadStores = useCallback(async (): Promise<boolean> => {
    if (!rpc) return false;
    try {
      const next = await rpc.method('stores', { ackTimeoutMs: 1500, retries: 0 }).invoke();
      lastRefresh.current = Date.now();
      setStores(next);
      setState('connected');
      setProblem(undefined);
      return true;
    } catch (error) {
      setState('unavailable');
      setProblem(errorMessage(error));
      return false;
    }
  }, [rpc]);

  // Until the app answers, keep asking; once it does, take the events it recorded before the panel opened.
  useEffect(() => {
    if (!rpc) return;
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const connect = async () => {
      if (cancelled) return;
      if (!(await loadStores())) {
        retry = setTimeout(connect, RETRY_MS);
        return;
      }
      try {
        const backlog = await rpc.method('events').invoke({ afterId: 0 });
        if (!cancelled) setEvents((current) => mergeEvents(current, backlog));
      } catch {
        /* the pushes that follow still arrive */
      }
    };
    connect();
    return () => {
      cancelled = true;
      if (retry) clearTimeout(retry);
    };
  }, [rpc, loadStores]);

  const scheduleRefresh = useCallback(
    (now = false) => {
      if (refreshTimer.current) return;
      const wait = now ? 0 : Math.max(0, lastRefresh.current + STORE_REFRESH_MS - Date.now());
      refreshTimer.current = setTimeout(() => {
        refreshTimer.current = undefined;
        loadStores();
      }, wait);
    },
    [loadStores],
  );
  useEffect(() => () => refreshTimer.current && clearTimeout(refreshTimer.current), []);

  useEffect(() => {
    if (!client) return;
    const subscription = client.onMessage('cellar:events', ({ json }) => {
      const incoming = JSON.parse(json) as InspectorEvent[];
      setEvents((current) => mergeEvents(current, incoming));
      if (incoming.some((event) => event.kind !== 'degradation')) scheduleRefresh(incoming.some((event) => event.kind === 'binding'));
    });
    return () => subscription.remove();
  }, [client, scheduleRefresh]);

  return { state, problem, rpc, stores, events, refreshStores: () => scheduleRefresh(true) };
}

/** The current time, ticking every `intervalMs`, for relative times that keep up. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** The id of the latest event `matches` picks out, or 0: what a view re-reads on. */
export function useLatestEventId(events: readonly InspectorEvent[], matches: (event: InspectorEvent) => boolean): number {
  for (let i = events.length - 1; i >= 0; i -= 1) if (matches(events[i])) return events[i].id;
  return 0;
}

/**
 * Calls `run` when `trigger` changes, at most once per `intervalMs`: a burst of writes re-reads once at its start and
 * once at its end, rather than once per write.
 */
export function useThrottledEffect(run: () => void, trigger: unknown, intervalMs: number, enabled = true): void {
  const last = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef(run);
  latest.current = run;
  useEffect(() => {
    if (!enabled) return;
    const wait = last.current + intervalMs - Date.now();
    if (wait <= 0) {
      last.current = Date.now();
      latest.current();
      return;
    }
    if (timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = undefined;
      last.current = Date.now();
      latest.current();
    }, wait);
  }, [trigger, intervalMs, enabled]);
  useEffect(() => () => timer.current && clearTimeout(timer.current), []);
}
