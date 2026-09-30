import { useCallback, useMemo, useState } from 'react';
import type { IngestRollup, InspectorEvent, StoreOverview } from '../shared/protocol';
import { Empty, ErrorBanner, StateBadge, Stat } from './components';
import { formatAgo, formatBytes, formatClock, formatCount, formatMs, shortStoreName } from './format';
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
  const [rollup, setRollup] = useState<IngestRollup[]>();
  const [error, setError] = useState<string>();

  const loadRollup = useCallback(async () => {
    if (!rpc) return;
    try {
      setRollup((await rpc.method('ingest').invoke()).rollup);
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

  const degradations = useMemo(() => events.filter((event) => event.kind === 'degradation').slice(-50).reverse(), [events]);
  const totals = stores.reduce(
    (sum, store) => ({ rows: sum.rows + store.summary.rows, partitions: sum.partitions + store.summary.partitions, bytes: sum.bytes + (store.summary.databaseBytes ?? 0) }),
    { rows: 0, partitions: 0, bytes: 0 },
  );
  const offDatabase = stores.filter((store) => store.summary.binding.state !== 'database');

  return (
    <div className="overview">
      <div className="stats">
        <Stat label="stores" value={formatCount(stores.length)} />
        <Stat label="rows" value={formatCount(totals.rows)} />
        <Stat label="partitions" value={formatCount(totals.partitions)} />
        <Stat label="on disk" value={formatBytes(totals.bytes)} title="The stores' own databases, added up" />
        <Stat label="off their database" value={formatCount(offDatabase.length)} title="Stores on the in-memory fallback or unbound" />
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
                <th className="num">Size</th>
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
                    <td className="num">{recent?.writesLastMinute ?? 0}</td>
                    <td>{formatAgo(recent?.lastWrite, now)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <Empty title="No stores declared">The app hasn't declared any Cellar stores yet, or declares them in modules that haven't loaded.</Empty>
        )}
      </section>

      <section>
        <h3>Fetch time by store</h3>
        <p className="muted">The latest 128 partition fetches, split into the request and writing the rows, to tell a slow network from a slow write.</p>
        {rollup?.length ? (
          <table className="table">
            <thead>
              <tr>
                <th>Store</th>
                <th className="num">Fetches</th>
                <th className="num">Request</th>
                <th className="num">Write</th>
                <th className="num">Rows</th>
                <th className="num">Characters</th>
              </tr>
            </thead>
            <tbody>
              {rollup.map((roll) => (
                <tr key={roll.store}>
                  <td>{shortStoreName(roll.store)}</td>
                  <td className="num">{formatCount(roll.fetches)}</td>
                  <td className="num">{formatMs(roll.fetchMs)}</td>
                  <td className="num">{formatMs(roll.ingestMs)}</td>
                  <td className="num">{formatCount(roll.rows)}</td>
                  <td className="num">{formatCount(roll.chars)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="muted">No fetches recorded yet.</div>
        )}
      </section>

      <section>
        <h3>Degradations</h3>
        {degradations.length ? (
          <ul className="degradations">
            {degradations.map((event) =>
              event.kind === 'degradation' ? (
                <li key={event.id} className={event.severity === 'error' ? 'degradation-error' : 'degradation-info'}>
                  <div>
                    <span className="time">{formatClock(event.at)}</span> <code>{event.scope}</code>
                    {event.severity === 'info' ? <span className="muted"> (notice)</span> : null}
                    {event.first ? null : <span className="muted"> · repeat</span>}
                  </div>
                  <div className="muted">{event.context}</div>
                  {event.error ? <div className="error-text">{event.error}</div> : null}
                </li>
              ) : null,
            )}
          </ul>
        ) : (
          <div className="muted">None reported. Each is a store losing a benefit it should have had, such as the native shredder or its own database.</div>
        )}
      </section>
    </div>
  );
}
