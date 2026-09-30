import './panel.css';
import { useEffect, useMemo, useState } from 'react';
import type { StoreOverview } from '../shared/protocol';
import { ActivityView } from './activity_view';
import { Empty, StateBadge } from './components';
import { formatBytes, formatCount, quoteName, shortStoreName } from './format';
import { Overview } from './overview';
import { PartitionsView } from './partitions_view';
import { QueryView, defaultDraft } from './query_view';
import type { QueryDraft } from './query_view';
import { SchemaView } from './schema_view';
import { useCellarConnection, useLatestEventId } from './use_cellar';

type Tab = 'partitions' | 'query' | 'activity' | 'schema';
const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'partitions', label: 'Partitions' },
  { id: 'query', label: 'Query' },
  { id: 'activity', label: 'Activity' },
  { id: 'schema', label: 'Schema' },
];

export default function CellarPanel() {
  const { state, problem, rpc, stores, events, refreshStores } = useCellarConnection();
  const [selected, setSelected] = useState<string>();
  const [tab, setTab] = useState<Tab>('partitions');
  const [drafts, setDrafts] = useState<Record<string, QueryDraft>>({});
  const [runTokens, setRunTokens] = useState<Record<string, number>>({});

  const store = stores.find((candidate) => candidate.name === selected);
  useEffect(() => {
    if (selected && stores.length && !store) setSelected(undefined);
  }, [selected, stores, store]);

  const draftOf = (target: StoreOverview) => drafts[target.name] ?? defaultDraft(target);
  const setDraft = (target: StoreOverview, draft: QueryDraft) => setDrafts((current) => ({ ...current, [target.name]: draft }));

  const queryPartition = (target: StoreOverview, key: string) => {
    setDraft(target, { ...draftOf(target), sql: `SELECT *\nFROM ${quoteName(target.schema.table)}\nWHERE partition_key = ?`, params: JSON.stringify([key]) });
    setRunTokens((current) => ({ ...current, [target.name]: (current[target.name] ?? 0) + 1 }));
    setTab('query');
  };

  return (
    <div className="panel">
      <nav className="sidebar">
        <div className="brand">
          <span className="brand-name">Cellar</span>
          <span className={`connection connection-${state}`} title={problem ?? state}>
            {state === 'connected' ? 'live' : state === 'connecting' ? 'connecting' : 'waiting for app'}
          </span>
        </div>
        <button type="button" className={`nav-item${store ? '' : ' nav-item-active'}`} onClick={() => setSelected(undefined)}>
          <span className="nav-name">Overview</span>
        </button>
        <div className="nav-heading">Stores</div>
        {stores.map((candidate) => (
          <StoreNavItem key={candidate.name} store={candidate} events={events} active={candidate.name === selected} onSelect={() => setSelected(candidate.name)} />
        ))}
        <span className="spacer" />
        <button type="button" className="button button-small nav-refresh" onClick={refreshStores} disabled={!rpc}>
          Refresh stores
        </button>
      </nav>

      <main className="main">
        {state !== 'connected' && !stores.length ? (
          <Empty title={state === 'connecting' ? 'Connecting to the app…' : 'Waiting for the app'}>
            <p>{problem ?? 'Open the app with Rozenite enabled.'}</p>
            <p>
              The app calls <code>useCellarDevTools()</code> from <code>@sleeperhq/rozenite-plugin-cellar</code> once, near its root, in a development build.
            </p>
          </Empty>
        ) : !store ? (
          <Overview rpc={rpc} stores={stores} events={events} onSelect={(name) => setSelected(name)} />
        ) : (
          <div className="store">
            <header className="store-header">
              <h2>{shortStoreName(store.name)}</h2>
              <StateBadge state={store.summary.binding.state} />
              <span className="muted">
                <code>{store.schema.table}</code> · {formatCount(store.summary.rows)} rows · {formatCount(store.summary.partitions)} partitions
                {store.summary.databaseBytes !== undefined ? ` · ${formatBytes(store.summary.databaseBytes)}` : ''}
              </span>
            </header>
            <div className="tabs" role="tablist">
              {TABS.map((item) => (
                <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} className={`tab${tab === item.id ? ' tab-active' : ''}`} onClick={() => setTab(item.id)}>
                  {item.label}
                </button>
              ))}
            </div>
            <div className="tab-body">
              {tab === 'partitions' ? (
                <PartitionsView rpc={rpc} store={store} events={events} onQueryPartition={(key) => queryPartition(store, key)} />
              ) : tab === 'query' ? (
                <QueryView
                  key={store.name}
                  rpc={rpc}
                  store={store}
                  events={events}
                  draft={draftOf(store)}
                  onDraftChange={(draft) => setDraft(store, draft)}
                  runToken={runTokens[store.name] ?? 0}
                />
              ) : tab === 'activity' ? (
                <ActivityView events={events} store={store.name} />
              ) : (
                <SchemaView rpc={rpc} store={store} />
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

function StoreNavItem({ store, events, active, onSelect }: { store: StoreOverview; events: Parameters<typeof useLatestEventId>[0]; active: boolean; onSelect: () => void }) {
  const lastWrite = useLatestEventId(events, (event) => event.kind === 'write' && event.store === store.name);
  const pulse = useMemo(() => lastWrite, [lastWrite]);
  return (
    <button type="button" className={`nav-item${active ? ' nav-item-active' : ''}`} onClick={onSelect} title={store.name}>
      <span className={`dot dot-${store.summary.binding.state}`} />
      <span className="nav-name">{shortStoreName(store.name)}</span>
      <span className="nav-meta">{formatCount(store.summary.rows)}</span>
      {pulse ? <span key={pulse} className="pulse" aria-hidden /> : null}
    </button>
  );
}
