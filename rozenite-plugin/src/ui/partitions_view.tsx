import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import type { InspectedPartition, InspectorEvent, StoreOverview } from '../shared/protocol';
import { Empty, ErrorBanner, JsonView, KindBadge, SortHeader } from './components';
import { formatAgo, formatClock, formatCount, formatFetchRows, formatMs } from './format';
import { errorMessage, useLatestEventId, useNow, useThrottledEffect } from './use_cellar';
import type { CellarRpc } from './use_cellar';

type SortKey = 'key' | 'rows' | 'version' | 'fetchedAt';

const compare: Record<SortKey, (a: InspectedPartition, b: InspectedPartition) => number> = {
  key: (a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }),
  rows: (a, b) => a.rows - b.rows,
  version: (a, b) => a.version - b.version,
  fetchedAt: (a, b) => (a.fetchedAt ?? 0) - (b.fetchedAt ?? 0),
};

/** What happened to one partition lately, newest first. */
function partitionEvents(events: readonly InspectorEvent[], store: string, key: string): InspectorEvent[] {
  const found: InspectorEvent[] = [];
  for (let i = events.length - 1; i >= 0 && found.length < 20; i -= 1) {
    const event = events[i];
    if ((event.kind === 'write' || event.kind === 'fetch') && event.store === store && event.partition === key) found.push(event);
  }
  return found;
}

export function PartitionsView({
  rpc,
  store,
  events,
  onQueryPartition,
}: {
  rpc: CellarRpc | null;
  store: StoreOverview;
  events: readonly InspectorEvent[];
  onQueryPartition: (key: string) => void;
}) {
  const [partitions, setPartitions] = useState<InspectedPartition[]>();
  const [error, setError] = useState<string>();
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; descending: boolean }>({ key: 'key', descending: false });
  const [expanded, setExpanded] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const now = useNow();

  const load = useCallback(async () => {
    if (!rpc) return;
    try {
      setPartitions(await rpc.method('partitions').invoke({ store: store.name }));
      setError(undefined);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, [rpc, store.name]);

  useEffect(() => {
    setPartitions(undefined);
    setExpanded(undefined);
    load();
  }, [load]);

  const latest = useLatestEventId(events, (event) => (event.kind === 'write' || event.kind === 'binding' || event.kind === 'fetch') && event.store === store.name);
  useThrottledEffect(load, latest, 1000, latest > 0);

  const act = async (label: string, action: () => Promise<unknown>) => {
    try {
      await action();
      setNotice(label);
      setTimeout(() => setNotice(undefined), 2000);
      load();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };

  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const matching = (partitions ?? []).filter(
      (partition) => !needle || partition.key.toLowerCase().includes(needle) || JSON.stringify(partition.partition ?? '').toLowerCase().includes(needle),
    );
    const sorted = [...matching].sort(compare[sort.key]);
    return sort.descending ? sorted.reverse() : sorted;
  }, [partitions, filter, sort]);

  const onSort = (key: SortKey) => setSort((current) => ({ key, descending: current.key === key ? !current.descending : key !== 'key' }));
  const totalRows = (partitions ?? []).reduce((sum, partition) => sum + partition.rows, 0);

  return (
    <div className="partitions-view">
      <div className="toolbar">
        <input className="search" placeholder="Filter by key or description" value={filter} onChange={(event) => setFilter(event.target.value)} aria-label="Filter partitions" />
        <span className="muted">
          {partitions ? `${formatCount(shown.length)} of ${formatCount(partitions.length)} partitions · ${formatCount(totalRows)} rows` : 'Loading…'}
        </span>
        {notice ? <span className="notice">{notice}</span> : null}
        <span className="spacer" />
        <button type="button" className="button button-small" onClick={load}>
          Refresh
        </button>
      </div>
      {error ? <ErrorBanner message={error} onDismiss={() => setError(undefined)} /> : null}
      {partitions && !partitions.length ? (
        <Empty title="No partitions yet">Nothing has been fetched or written into this store this session, and its database holds no rows.</Empty>
      ) : (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <SortHeader label="Partition" sortKey="key" sort={sort} onSort={onSort} />
                <SortHeader label="Rows" sortKey="rows" sort={sort} onSort={onSort} align="right" />
                <SortHeader label="Version" sortKey="version" sort={sort} onSort={onSort} align="right" />
                <th>ETag</th>
                <SortHeader label="Fetched" sortKey="fetchedAt" sort={sort} onSort={onSort} />
                <th />
              </tr>
            </thead>
            <tbody>
              {shown.map((partition) => {
                const open = expanded === partition.key;
                return (
                  <Fragment key={partition.key}>
                    <tr className={open ? 'row-open' : undefined}>
                      <td>
                        <button type="button" className="disclosure" onClick={() => setExpanded(open ? undefined : partition.key)} aria-expanded={open}>
                          <span className="disclosure-mark">{open ? '▾' : '▸'}</span>
                          <code>{partition.key}</code>
                        </button>
                      </td>
                      <td className="num">{formatCount(partition.rows)}</td>
                      <td className="num">{partition.version}</td>
                      <td className="etag" title={partition.etag ?? undefined}>
                        {partition.etag ?? <span className="muted">none</span>}
                      </td>
                      <td title={partition.fetchedAt ? new Date(partition.fetchedAt).toLocaleString() : 'Not fetched this session'}>
                        {partition.fetchedAt ? formatAgo(partition.fetchedAt, now) : <span className="muted">not this session</span>}
                      </td>
                      <td className="actions">
                        <button type="button" className="button button-small" onClick={() => onQueryPartition(partition.key)} title="Query this partition's rows">
                          Rows
                        </button>
                        <button
                          type="button"
                          className="button button-small"
                          title="Fetch this partition again, sending its ETag"
                          onClick={() =>
                            act('Refetching', async () => {
                              const refetched = await rpc?.method('refetch').invoke({ store: store.name, key: partition.key });
                              if (refetched === false) throw new Error('This store does not fetch its partitions.');
                            })
                          }
                        >
                          Refetch
                        </button>
                        <button
                          type="button"
                          className="button button-small"
                          disabled={!partition.etag}
                          title="Delete the ETag, so the next fetch downloads the whole body"
                          onClick={() => act('ETag cleared', () => rpc!.method('clearEtag').invoke({ store: store.name, key: partition.key }))}
                        >
                          Clear ETag
                        </button>
                      </td>
                    </tr>
                    {open ? (
                      <tr className="row-detail">
                        <td colSpan={6}>
                          <div className="partition-detail">
                            <section>
                              <h4>Description</h4>
                              {partition.partition === undefined ? <div className="muted">Not recorded.</div> : <JsonView value={partition.partition} />}
                            </section>
                            <section>
                              <h4>Recent activity</h4>
                              <PartitionTimeline events={partitionEvents(events, store.name, partition.key)} />
                            </section>
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function PartitionTimeline({ events }: { events: InspectorEvent[] }) {
  if (!events.length) return <div className="muted">No writes or fetches since the app started recording.</div>;
  return (
    <ul className="timeline">
      {events.map((event) => (
        <li key={event.id}>
          <span className="time">{formatClock(event.at)}</span>
          <KindBadge kind={event.kind} />
          {event.kind === 'write' ? (
            <span>
              v{event.version} · {event.entityCount === null ? 'every entity' : `${formatCount(event.entityCount)} changed`}
            </span>
          ) : event.kind === 'fetch' ? (
            <span>
              {formatFetchRows(event.rows)} · request {formatMs(event.fetchMs)} · write {formatMs(event.ingestMs)}
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
