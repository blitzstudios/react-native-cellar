import { useCallback, useEffect, useMemo, useState } from 'react';
import type { InspectedEntity, InspectedPartition, InspectorEvent, StoreOverview } from '../shared/protocol';
import { heapLabel } from './caches_view';
import { Empty, ErrorBanner, JsonView } from './components';
import { formatClock, formatCount, quoteName } from './format';
import { errorMessage, useLatestEventId, useThrottledEffect } from './use_cellar';
import type { CellarRpc } from './use_cellar';

const LIST_LIMIT = 200;

/** An entity: an id within one partition. The same id in another partition is another entity. */
interface EntityRef {
  partition: string;
  id: string;
}

interface EntityRow extends EntityRef {
  rows: number;
}

const sameRef = (a: EntityRef | undefined, b: EntityRef) => !!a && a.partition === b.partition && a.id === b.id;

const mostEntities = (partitions: readonly InspectedPartition[]) =>
  partitions.reduce<InspectedPartition | undefined>((best, candidate) => (!best || candidate.entities > best.entities ? candidate : best), undefined);

/** A store's entities, each an id within one partition, by how many rows it has; and one of them in full. */
export function EntitiesView({
  mode = 'live',
  rpc,
  store,
  events,
  onQuery,
}: {
  rpc: CellarRpc | null;
  store: StoreOverview;
  events: readonly InspectorEvent[];
  onQuery: (sql: string, params: string) => void;
  mode?: 'live' | 'dump';
}) {
  const [search, setSearch] = useState('');
  const [partitions, setPartitions] = useState<InspectedPartition[]>();
  const [partition, setPartition] = useState<string>();
  const [list, setList] = useState<{ partition: string; rows: EntityRow[]; truncated: boolean }>();
  const [selected, setSelected] = useState<EntityRef>();
  const [error, setError] = useState<string>();
  const entity = quoteName(store.schema.entityColumn);
  const table = quoteName(store.schema.table);

  const loadPartitions = useCallback(async () => {
    if (!rpc) return;
    try {
      const loaded = await rpc.method('partitions').invoke({ store: store.name });
      setPartitions(loaded);
      setPartition((current) => (current !== undefined && loaded.some((candidate) => candidate.key === current) ? current : mostEntities(loaded)?.key));
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, [rpc, store.name]);
  const latestWrite = useLatestEventId(events, (event) => event.kind === 'write' && event.store === store.name);
  useEffect(() => {
    loadPartitions();
  }, [loadPartitions]);
  useThrottledEffect(loadPartitions, latestWrite, 2000, latestWrite > 0);

  const load = useCallback(async () => {
    if (!rpc || partition === undefined) return;
    const needle = search.trim();
    try {
      const result = await rpc.method('query').invoke({
        store: store.name,
        sql: `SELECT ${entity} AS id, COUNT(*) AS rows FROM ${table} WHERE partition_key = ?${needle ? ` AND ${entity} LIKE ?` : ''} GROUP BY ${entity} ORDER BY rows DESC, id`,
        params: needle ? [partition, `%${needle}%`] : [partition],
        limit: LIST_LIMIT,
      });
      const at = (column: string) => result.columns.indexOf(column);
      setList({
        partition,
        rows: result.rows.map((row) => ({ partition, id: String(row[at('id')]), rows: Number(row[at('rows')]) })),
        truncated: result.truncated,
      });
      setError(undefined);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, [rpc, store.name, entity, table, search, partition]);

  useEffect(() => {
    const timer = setTimeout(load, 200);
    return () => clearTimeout(timer);
  }, [load]);

  const select = (ref: EntityRef) => {
    setPartition(ref.partition);
    setSelected(ref);
  };
  const shown = list && list.partition === partition ? list : undefined;

  return (
    <div className="entities-view">
      <div className="toolbar">
        <select className="select" value={partition ?? ''} onChange={(event) => setPartition(event.target.value)} aria-label="Partition" disabled={!partitions?.length}>
          {(partitions ?? []).map((candidate) => (
            <option key={candidate.key} value={candidate.key}>
              {candidate.key} · {formatCount(candidate.entities)}
            </option>
          ))}
        </select>
        <input className="search" placeholder={`Search ${store.schema.entityColumn}`} value={search} onChange={(event) => setSearch(event.target.value)} aria-label="Search entities" />
        {shown ? (
          <span className="muted">
            {formatCount(shown.rows.length)}
            {shown.truncated ? '+' : ''} entities
          </span>
        ) : null}
      </div>
      {error ? <ErrorBanner message={error} onDismiss={() => setError(undefined)} /> : null}
      <div className="entities-body">
        <div className="table-scroll entities-list">
          {partitions && !partitions.length ? (
            <Empty title="No partitions" />
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>{store.schema.entityColumn}</th>
                  <th className="num">Rows</th>
                </tr>
              </thead>
              <tbody>
                {(shown?.rows ?? []).map((row) => (
                  <tr key={row.id} className={`clickable-row${sameRef(selected, row) ? ' row-open' : ''}`} onClick={() => setSelected(row)}>
                    <td>
                      <code>{row.id}</code>
                    </td>
                    <td className="num">{formatCount(row.rows)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="entity-detail">
          {selected ? (
            <EntityDetail
              key={`${selected.partition}\u0000${selected.id}`}
              rpc={rpc}
              store={store}
              entityRef={selected}
              mode={mode}
              events={events}
              onSelect={select}
              onRows={() =>
                onQuery(`SELECT *\nFROM ${table}\nWHERE partition_key = ? AND ${entity} = ?`, JSON.stringify([selected.partition, selected.id]))
              }
            />
          ) : (
            <Empty title="Select an entity" />
          )}
        </div>
      </div>
    </div>
  );
}

function EntityDetail({
  mode,
  rpc,
  store,
  entityRef,
  events,
  onSelect,
  onRows,
}: {
  rpc: CellarRpc | null;
  store: StoreOverview;
  entityRef: EntityRef;
  events: readonly InspectorEvent[];
  onSelect: (ref: EntityRef) => void;
  onRows: () => void;
  mode: 'live' | 'dump';
}) {
  const [entity, setEntity] = useState<InspectedEntity>();
  const [open, setOpen] = useState<number>();
  const [error, setError] = useState<string>();
  const { partition, id } = entityRef;

  const load = useCallback(async () => {
    if (!rpc) return;
    try {
      setEntity(await rpc.method('entity').invoke({ store: store.name, key: partition, id }));
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, [rpc, store.name, partition, id]);

  const writes = useMemo(
    () =>
      events
        .filter((event) => event.kind === 'write' && event.store === store.name && event.partition === partition && (event.entities === 'all' || event.entities.includes(id)))
        .slice(-20)
        .reverse(),
    [events, store.name, partition, id],
  );
  const latest = useLatestEventId(events, (event) => event.kind === 'write' && event.store === store.name && event.partition === partition);
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
        <span className="muted">
          in <code>{partition}</code>
          {mode === 'live' ? ` · ${entity.version ? `changed at v${entity.version}` : 'unchanged this session'}` : null}
        </span>
        <button type="button" className="button button-small" onClick={onRows} title="Query this entity's rows">
          Rows
        </button>
      </header>
      <section>
        <h4>Rows</h4>
        {entity.rows.length ? <JsonView value={entity.rows.length === 1 ? entity.rows[0] : entity.rows} /> : <div className="muted">None</div>}
      </section>
      {mode === 'live' ? (
        <>
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
                  <span className="muted">v{event.version}</span>
                  {event.entities === 'all' ? <span className="muted">every entity</span> : null}
                </li>
              ) : null,
            )}
          </ul>
        ) : (
          <div className="muted">None</div>
        )}
      </section>
        </>
      ) : null}
      {entity.sameIdIn.length ? (
        <section>
          <h4 title="Other entities: the same id in another partition may name something else">Same id in other partitions</h4>
          <div className="entities">
            {entity.sameIdIn.map((other) => (
              <button key={other} type="button" className="chip chip-on" onClick={() => onSelect({ partition: other, id })}>
                {other}
              </button>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
