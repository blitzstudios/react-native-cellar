import { useCallback, useMemo, useState } from 'react';
import type { IngestTiming, InspectorEvent, StoreOverview } from '../shared/protocol';
import { Empty, ErrorBanner, StateBadge, Stat } from './components';
import { heapLabel } from './caches_view';
import { Degradations } from './degradations';
import { formatAgo, formatBytes, formatCount, formatMs, shortStoreName } from './format';
import { errorMessage, useLatestEventId, useNow, useThrottledEffect } from './use_cellar';
import type { CellarRpc } from './use_cellar';

const MINUTE = 60_000;

/** Every store at a glance, where the session's fetch time went, and what degraded. */
export function Overview({
  rpc,
  stores,
  events,
  onSelect,
}: {
  rpc: CellarRpc | null;
  stores: StoreOverview[];
  events: readonly InspectorEvent[];
  onSelect: (store: string) => void;
}) {
  const now = useNow();
  const [timings, setTimings] = useState<IngestTiming[]>();
  const [error, setError] = useState<string>();

  const loadRollup = useCallback(async () => {
    if (!rpc) return;
    try {
      setTimings((await rpc.method('ingest').invoke()).timings);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, [rpc]);
  const latestFetch = useLatestEventId(events, (event) => event.kind === 'fetch');
  useThrottledEffect(loadRollup, `${latestFetch}:${rpc ? 1 : 0}`, 2000, !!rpc);

  const activity = useMemo(() => {
    const byStore = new Map<string, { writesLastMinute: number; lastWrite?: number }>();
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i];
      if (event.kind !== 'write') continue;
      const entry = byStore.get(event.store) ?? { writesLastMinute: 0 };
      entry.lastWrite ??= event.at;
      if (now - event.at <= MINUTE) entry.writesLastMinute += 1;
      byStore.set(event.store, entry);
    }
    return byStore;
  }, [events, now]);

  const fetchStats = useMemo(() => fetchStatsOf(timings ?? []), [timings]);
  const totals = stores.reduce(
    (sum, store) => ({
      rows: sum.rows + store.summary.rows,
      partitions: sum.partitions + store.summary.partitions,
      bytes: sum.bytes + (store.summary.databaseBytes ?? 0),
      heap: sum.heap + (store.summary.caches?.heapBytes ?? 0),
    }),
    { rows: 0, partitions: 0, bytes: 0, heap: 0 },
  );
  const offDatabase = stores.filter((store) => store.summary.binding.state !== 'database');

  return (
    <div className="overview">
      <div className="stats">
        <Stat label="stores" value={formatCount(stores.length)} />
        <Stat label="rows" value={formatCount(totals.rows)} />
        <Stat label="partitions" value={formatCount(totals.partitions)} />
        <Stat label="on disk" value={formatBytes(totals.bytes)} />
        <Stat label="cache heap" value={heapLabel(totals.heap)} title="Estimated from what the caches hold" />
        <Stat label="off their database" value={formatCount(offDatabase.length)} />
      </div>

      {error ? <ErrorBanner message={error} onDismiss={() => setError(undefined)} /> : null}

      <section>
        <h3>Stores</h3>
        {stores.length ? (
          <table className="table clickable">
            <thead>
              <tr>
                <th>Store</th>
                <th>Runs on</th>
                <th className="num">Rows</th>
                <th className="num">Partitions</th>
                <th className="num">On disk</th>
                <th className="num">Cache heap</th>
                <th className="num">Writes / min</th>
                <th>Last write</th>
              </tr>
            </thead>
            <tbody>
              {stores.map((store) => {
                const recent = activity.get(store.name);
                return (
                  <tr key={store.name} onClick={() => onSelect(store.name)}>
                    <td>
                      <strong>{shortStoreName(store.name)}</strong> <span className="muted">{store.schema.table}</span>
                    </td>
                    <td>
                      <StateBadge state={store.summary.binding.state} /> {store.summary.binding.database ? <span className="muted">{store.summary.binding.database}</span> : null}
                    </td>
                    <td className="num">{formatCount(store.summary.rows)}</td>
                    <td className="num">{formatCount(store.summary.partitions)}</td>
                    <td className="num">{formatBytes(store.summary.databaseBytes)}</td>
                    <td className="num" title={`${formatCount(store.summary.caches?.entries ?? 0)} entries in ${store.summary.caches?.count ?? 0} caches`}>
                      {heapLabel(store.summary.caches?.heapBytes)}
                    </td>
                    <td className="num">{recent?.writesLastMinute ?? 0}</td>
                    <td>{formatAgo(recent?.lastWrite, now)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <Empty title="No stores" />
        )}
      </section>

      <section>
        <h3>Fetches <span className="muted small">latest 128</span></h3>
        {fetchStats.length ? (
          <table className="table">
            <thead>
              <tr>
                <th>Store</th>
                <th className="num">Fetches</th>
                <th className="num" title="304 Not Modified, or a body identical to the last">Unchanged</th>
                <th className="num">Avg request</th>
                <th className="num">Avg write</th>
                <th className="num">Slowest</th>
                <th className="num">Total request</th>
                <th className="num">Total write</th>
                <th className="num">Rows written</th>
              </tr>
            </thead>
            <tbody>
              {fetchStats.map((stat) => (
                <tr key={stat.store}>
                  <td>{shortStoreName(stat.store)}</td>
                  <td className="num">{formatCount(stat.fetches)}</td>
                  <td className="num">{formatCount(stat.unchanged)}</td>
                  <td className="num">{formatMs(stat.fetchMs / stat.fetches)}</td>
                  <td className="num">{formatMs(stat.ingestMs / stat.fetches)}</td>
                  <td className="num" title={stat.slowest.partition}>
                    {formatMs(stat.slowest.ms)}
                  </td>
                  <td className="num">{formatMs(stat.fetchMs)}</td>
                  <td className="num">{formatMs(stat.ingestMs)}</td>
                  <td className="num">{formatCount(stat.rows)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="muted">None</div>
        )}
      </section>

      <section>
        <h3>Degradations</h3>
        <Degradations events={events} now={now} />
      </section>
    </div>
  );
}

interface FetchStats {
  store: string;
  fetches: number;
  unchanged: number;
  fetchMs: number;
  ingestMs: number;
  rows: number;
  slowest: { ms: number; partition: string };
}

/** Each store's fetches totalled, with the slowest one; most total time first. */
export function fetchStatsOf(timings: readonly IngestTiming[]): FetchStats[] {
  const byStore = new Map<string, FetchStats>();
  for (const timing of timings) {
    const stat = byStore.get(timing.store) ?? { store: timing.store, fetches: 0, unchanged: 0, fetchMs: 0, ingestMs: 0, rows: 0, slowest: { ms: 0, partition: '' } };
    stat.fetches += 1;
    if (timing.rows < 0) stat.unchanged += 1;
    else stat.rows += timing.rows;
    stat.fetchMs += timing.fetchMs;
    stat.ingestMs += timing.ingestMs;
    const ms = timing.fetchMs + timing.ingestMs;
    if (ms > stat.slowest.ms) stat.slowest = { ms, partition: timing.partition };
    byStore.set(timing.store, stat);
  }
  return Array.from(byStore.values()).sort((a, b) => b.fetchMs + b.ingestMs - (a.fetchMs + a.ingestMs));
}
