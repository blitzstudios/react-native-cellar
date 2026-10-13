import { useCallback, useMemo, useState } from 'react';
import type { InspectorEvent } from '../shared/protocol';
import { ExtraChips } from './callsite';
import { DegradationDetail, ScopeSubject, reportNumbers, splitScope } from './degradations';
import { DetailPane, Empty, JsonView, KindBadge, PartitionLabel } from './components';
import { formatClock, formatCount, formatFetchRows, formatMs, partitionText, shortStoreName } from './format';

const KINDS: InspectorEvent['kind'][] = ['write', 'fetch', 'binding', 'degradation'];
/** How many events the list draws; the rest are a filter away. */
const SHOWN_MAX = 1000;

const matchesPartition = (key: string, needle: string) => key.toLowerCase().includes(needle) || partitionText(key).toLowerCase().includes(needle);

function matchesText(event: InspectorEvent, needle: string): boolean {
  switch (event.kind) {
    case 'write':
      return matchesPartition(event.partition, needle) || (event.entities !== 'all' && event.entities.some((id) => id.toLowerCase().includes(needle)));
    case 'fetch':
      return matchesPartition(event.partition, needle);
    case 'binding':
      return (event.binding.database ?? '').toLowerCase().includes(needle) || event.binding.state.includes(needle);
    case 'degradation':
      return event.scope.toLowerCase().includes(needle) || event.context.toLowerCase().includes(needle) || (event.error ?? '').toLowerCase().includes(needle);
  }
}

/**
 * Whether a degradation scope is about `store`: Cellar scopes a store's reports as `player_store.in_memory` or
 * `player_store_ingest.…`, and its partition engine's as `partitions.intern_evicted.player`. A bare prefix won't do,
 * since `player_stats_store.…` starts with `player`.
 */
export function scopeNamesStore(scope: string, store: string): boolean {
  const short = store.replace(/_store$/, '');
  return scope.startsWith(`${store}.`) || scope.startsWith(`${store}_ingest.`) || scope.endsWith(`.${short}`);
}

/**
 * What the stores did, newest first: every store's, or one store's (a store's view passes `store`). Degradation reports
 * name a scope rather than a store, so a store's view shows those whose scope names it.
 */
export function ActivityView({ events, store }: { events: readonly InspectorEvent[]; store?: string }) {
  const [kinds, setKinds] = useState<Set<InspectorEvent['kind']>>(() => new Set(KINDS));
  const [text, setText] = useState('');
  const [paused, setPaused] = useState<readonly InspectorEvent[]>();
  const [clearedAt, setClearedAt] = useState(0);
  const [open, setOpen] = useState<number>();

  const source = paused ?? events;
  const shown = useMemo(() => {
    const needle = text.trim().toLowerCase();
    const matching: InspectorEvent[] = [];
    for (let i = source.length - 1; i >= 0 && matching.length < SHOWN_MAX; i -= 1) {
      const event = source[i];
      if (event.id <= clearedAt) break;
      if (!kinds.has(event.kind)) continue;
      if (store && ('store' in event ? event.store !== store : !scopeNamesStore(event.scope, store))) continue;
      if (needle && !matchesText(event, needle)) continue;
      matching.push(event);
    }
    return matching;
  }, [source, kinds, text, store, clearedAt]);
  const selected = open === undefined ? undefined : shown.find((event) => event.id === open);
  const close = useCallback(() => setOpen(undefined), []);

  const toggle = (kind: InspectorEvent['kind']) =>
    setKinds((current) => {
      const next = new Set(current);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });

  return (
    <div className="activity-view">
      <div className="toolbar">
        {KINDS.map((kind) => (
          <button key={kind} type="button" className={`chip chip-${kind}${kinds.has(kind) ? ' chip-on' : ''}`} onClick={() => toggle(kind)} aria-pressed={kinds.has(kind)}>
            {kind}
          </button>
        ))}
        <input className="search" placeholder="Filter by partition, entity id or scope" value={text} onChange={(event) => setText(event.target.value)} aria-label="Filter events" />
        <span className="spacer" />
        <button type="button" className="button button-small" onClick={() => setPaused(paused ? undefined : events)}>
          {paused ? 'Resume' : 'Pause'}
        </button>
        <button type="button" className="button button-small" onClick={() => setClearedAt(events.length ? events[events.length - 1].id : 0)}>
          Clear
        </button>
      </div>
      {paused ? <div className="paused">Paused · {formatCount(events.length - paused.length)} new</div> : null}
      {!shown.length ? (
        <Empty title="No events" />
      ) : (
        <div className="split">
          <div className="table-scroll">
            <table className="table events">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Kind</th>
                  {store ? null : <th>Store</th>}
                  <th>What happened</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((event) => (
                  <EventRow key={event.id} event={event} showStore={!store} open={selected?.id === event.id} onToggle={() => setOpen(selected?.id === event.id ? undefined : event.id)} />
                ))}
              </tbody>
            </table>
          </div>
          {selected ? (
            <DetailPane title={<KindBadge kind={selected.kind} />} meta={`${formatClock(selected.at)}${'store' in selected ? ` · ${shortStoreName(selected.store)}` : ''}`} onClose={close}>
              <EventDetail event={selected} />
            </DetailPane>
          ) : null}
        </div>
      )}
    </div>
  );
}

function EventRow({ event, showStore, open, onToggle }: { event: InspectorEvent; showStore: boolean; open: boolean; onToggle: () => void }) {
  return (
    <tr
      className={`clickable-row event event-${event.kind}${event.kind === 'degradation' && event.severity === 'error' ? ' event-error' : ''}${open ? ' row-open' : ''}`}
      onClick={onToggle}
    >
      <td className="time">{formatClock(event.at)}</td>
      <td>
        <KindBadge kind={event.kind} />
      </td>
      {showStore ? <td>{'store' in event ? shortStoreName(event.store) : <span className="muted">—</span>}</td> : null}
      <td>
        <EventSummary event={event} />
      </td>
    </tr>
  );
}

function EventDetail({ event }: { event: InspectorEvent }) {
  switch (event.kind) {
    case 'write':
      return (
        <>
          <dl className="facts">
            <dt>Partition</dt>
            <dd>
              <PartitionLabel partitionKey={event.partition} />
              <div>
                <code className="wrap muted small">{event.partition}</code>
              </div>
            </dd>
            <dt>Version</dt>
            <dd>v{event.version}</dd>
            <dt>Changed</dt>
            <dd>{event.entityCount === null ? 'every entity' : `${formatCount(event.entityCount)} ${event.entityCount === 1 ? 'entity' : 'entities'}`}</dd>
          </dl>
          {event.entities !== 'all' && event.entities.length ? (
            <section>
              <h4>Entities</h4>
              <div className="entities">
                {event.entities.map((id) => (
                  <code key={id}>{id}</code>
                ))}
                {event.entityCount !== null && event.entityCount > event.entities.length ? (
                  <span className="muted">and {formatCount(event.entityCount - event.entities.length)} more</span>
                ) : null}
              </div>
            </section>
          ) : null}
        </>
      );
    case 'fetch':
      return (
        <dl className="facts">
          <dt>Partition</dt>
          <dd>
            <PartitionLabel partitionKey={event.partition} />
            <div>
              <code className="wrap muted small">{event.partition}</code>
            </div>
          </dd>
          <dt>Rows</dt>
          <dd>{formatFetchRows(event.rows)}</dd>
          <dt>Request</dt>
          <dd>{formatMs(event.fetchMs)}</dd>
          <dt>Write</dt>
          <dd>{formatMs(event.ingestMs)}</dd>
          {event.chars !== null ? (
            <>
              <dt>Body</dt>
              <dd>{formatCount(event.chars)} chars</dd>
            </>
          ) : null}
        </dl>
      );
    case 'binding':
      return <JsonView value={event.binding} />;
    case 'degradation':
      return <DegradationDetail report={event} />;
  }
}

function EventSummary({ event }: { event: InspectorEvent }) {
  switch (event.kind) {
    case 'write':
      return (
        <span>
          <PartitionLabel partitionKey={event.partition} /> → v{event.version} ·{' '}
          {event.entityCount === null ? 'every entity' : `${formatCount(event.entityCount)} ${event.entityCount === 1 ? 'entity' : 'entities'} changed`}
        </span>
      );
    case 'fetch':
      return (
        <span>
          <PartitionLabel partitionKey={event.partition} /> · {formatFetchRows(event.rows)} · request {formatMs(event.fetchMs)} · write {formatMs(event.ingestMs)}
          {event.chars !== null ? ` · ${formatCount(event.chars)} chars` : ''}
        </span>
      );
    case 'binding':
      return (
        <span>
          now on {event.binding.state === 'database' ? 'its database' : event.binding.state === 'memory' ? 'the in-memory fallback' : 'nothing'}
          {event.binding.database ? (
            <>
              {' '}
              (<code>{event.binding.database}</code>)
            </>
          ) : null}
          {event.binding.reopens ? ` · ${event.binding.reopens} reopen${event.binding.reopens === 1 ? '' : 's'}` : ''}
        </span>
      );
    case 'degradation':
      return (
        <span>
          <code>{splitScope(event.scope).rule}</code> <ScopeSubject subject={splitScope(event.scope).subject} />{' '}
          {event.severity !== 'error' ? <span className="muted">{event.severity === 'info' ? 'notice' : 'advice'}</span> : null}
 <ExtraChips extra={reportNumbers(event)} />
        </span>
      );
  }
}
