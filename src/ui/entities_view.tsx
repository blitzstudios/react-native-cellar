import { useCallback, useEffect, useMemo, useState } from 'react';
import type { InspectedEntity, InspectorEvent, StoreOverview } from '../shared/protocol';
import { heapLabel } from './caches_view';
import { Empty, ErrorBanner, JsonView } from './components';
import { formatClock, formatCount, quoteName } from './format';
import { errorMessage, useLatestEventId, useThrottledEffect } from './use_cellar';
import type { CellarRpc } from './use_cellar';

const LIST_LIMIT = 200;

interface EntityRow {
  id: string;
  rows: number;
  partitions: number;
}

/** A store's entities, by how many rows each has, and one of them across its partitions and caches. */
export function EntitiesView({
  rpc,
  store,
  events,
  onQuery,
}: {
  rpc: CellarRpc | null;
  store: StoreOverview;
  events: readonly InspectorEvent[];
  onQuery: (sql: string, params: string) => void;
}) {
  const [search, setSearch] = useState('');
  const [list, setList] = useState<{ rows: EntityRow[]; truncated: boolean }>();
  const [selected, setSelected] = useState<string>();
  const [error, setError] = useState<string>();
  const entity = quoteName(store.schema.entityColumn);
  const table = quoteName(store.schema.table);

  const load = useCallback(async () => {
    if (!rpc) return;
    const needle = search.trim();
    try {
      const result = await rpc.method('query').invoke({
        store: store.name,
        sql: `SELECT ${entity} AS id, COUNT(*) AS rows, COUNT(DISTINCT partition_key) AS partitions FROM ${table} ${needle ? `WHERE ${entity} LIKE ?` : ''} GROUP BY ${entity} ORDER BY rows DESC, id`,
        params: needle ? [`%${needle}%`] : [],
        limit: LIST_LIMIT,
      });
      const at = (column: string) => result.columns.indexOf(column);
      setList({
        rows: result.rows.map((row) => ({ id: String(row[at('id')]), rows: Number(row[at('rows')]), partitions: Number(row[at('partitions')]) })),
        truncated: result.truncated,
      });
      setError(undefined);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, [rpc, store.name, entity, table, search]);

  useEffect(() => {
    const timer = setTimeout(load, 200);
    return () => clearTimeout(timer);
  }, [load]);

  return (
    <div className="entities-view">
      <div className="toolbar">
        <input className="search" placeholder={`Search ${store.schema.entityColumn}`} value={search} onChange={(event) => setSearch(event.target.value)} aria-label="Search entities" />
        {list ? (
          <span className="muted">
            {formatCount(list.rows.length)}
            {list.truncated ? '+' : ''} entities
          </span>
        ) : null}
      </div>
      {error ? <ErrorBanner message={error} onDismiss={() => setError(undefined)} /> : null}
      <div className="entities-body">
        <div className="table-scroll entities-list">
          <table className="table">
            <thead>
              <tr>
                <th>{store.schema.entityColumn}</th>
                <th className="num">Rows</th>
                <th className="num">Partitions</th>
              </tr>
            </thead>
            <tbody>
              {(list?.rows ?? []).map((row) => (
                <tr key={row.id} className={`clickable-row${selected === row.id ? ' row-open' : ''}`} onClick={() => setSelected(row.id)}>
                  <td>
                    <code>{row.id}</code>
                  </td>
                  <td className="num">{formatCount(row.rows)}</td>
                  <td className="num">{formatCount(row.partitions)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="entity-detail">
          {selected ? (
            <EntityDetail
              key={selected}
              rpc={rpc}
              store={store}
              id={selected}
              events={events}
              onRows={() => onQuery(`SELECT *\nFROM ${table}\nWHERE ${entity} = ?\nORDER BY partition_key`, JSON.stringify([selected]))}
            />
          ) : (
            <Empty title="Select an entity" />
          )}
        </div>
      </div>
    </div>
  );
}

function EntityDetail({ rpc, store, id, events, onRows }: { rpc: CellarRpc | null; store: StoreOverview; id: string; events: readonly InspectorEvent[]; onRows: () => void }) {
  const [entity, setEntity] = useState<InspectedEntity>();
  const [open, setOpen] = useState<number>();
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    if (!rpc) return;
    try {
      setEntity(await rpc.method('entity').invoke({ store: store.name, id }));
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, [rpc, store.name, id]);

  const writes = useMemo(
    () => events.filter((event) => event.kind === 'write' && event.store === store.name && event.entities !== 'all' && event.entities.includes(id)).slice(-20).reverse(),
    [events, store.name, id],
  );
  const latest = useLatestEventId(events, (event) => event.kind === 'write' && event.store === store.name);
  useEffect(() => {
    load();
  }, [load]);
  useThrottledEffect(load, latest, 1000, latest > 0);

  if (error) return <ErrorBanner message={error} />;
  if (!entity) return <div className="muted pad">…</div>;
  const chosen = open === undefined ? undefined : entity.cacheEntries[open];
  return (
    <div className="entity">
      <header className="entity-header">
        <h3>
          <code>{id}</code>
        </h3>
        <button type="button" className="button button-small" onClick={onRows}>
          Rows
        </button>
      </header>
      <section>
        <h4>Partitions</h4>
        {entity.partitions.length ? (
          <table className="table">
            <thead>
              <tr>
                <th>Partition</th>
                <th className="num">Rows</th>
                <th className="num" title="The partition version at which this entity last changed">
                  Changed at
                </th>
              </tr>
            </thead>
            <tbody>
              {entity.partitions.map((partition) => (
                <tr key={partition.key}>
                  <td>
                    <code>{partition.key}</code>
                  </td>
                  <td className="num">{formatCount(partition.rows)}</td>
                  <td className="num">{partition.version ? `v${partition.version}` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="muted">None</div>
        )}
      </section>
      <section>
        <h4>Cache entries</h4>
        {entity.cacheEntries.length ? (
          <>
            <table className="table">
              <thead>
                <tr>
                  <th>Cache</th>
                  <th>Key</th>
                  <th className="num">Version</th>
                  <th className="num">Heap</th>
                </tr>
              </thead>
              <tbody>
                {entity.cacheEntries.map((entry, index) => (
                  <tr key={`${entry.cache}-${entry.key.join('/')}`} className={`clickable-row${open === index ? ' row-open' : ''}`} onClick={() => setOpen(open === index ? undefined : index)}>
                    <td>
                      <code>{entry.cache}</code>
                    </td>
                    <td>
                      {entry.key.map((part, partIndex) => (
                        <code key={partIndex} className="key-part">
                          {part || '∅'}
                        </code>
                      ))}
                    </td>
                    <td className="num">v{entry.version}</td>
                    <td className="num">{heapLabel(entry.heapBytes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {chosen ? <JsonView value={chosen.value} /> : null}
          </>
        ) : (
          <div className="muted">None</div>
        )}
      </section>
      <section>
        <h4>Recent writes</h4>
        {writes.length ? (
          <ul className="timeline">
            {writes.map((event) =>
              event.kind === 'write' ? (
                <li key={event.id}>
                  <span className="time">{formatClock(event.at)}</span>
                  <code>{event.partition}</code>
                  <span className="muted">v{event.version}</span>
                </li>
              ) : null,
            )}
          </ul>
        ) : (
          <div className="muted">None</div>
        )}
      </section>
    </div>
  );
}
