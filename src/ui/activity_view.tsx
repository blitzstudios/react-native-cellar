import { useMemo, useState } from 'react';
import type { InspectorEvent } from '../shared/protocol';
import { Empty, KindBadge } from './components';
import { formatClock, formatCount, formatFetchRows, formatMs, shortStoreName } from './format';

const KINDS: InspectorEvent['kind'][] = ['write', 'fetch', 'binding', 'degradation'];
/** How many events the list draws; the rest are a filter away. */
const SHOWN_MAX = 1000;

function matchesText(event: InspectorEvent, needle: string): boolean {
  switch (event.kind) {
    case 'write':
      return event.partition.toLowerCase().includes(needle) || (event.entities !== 'all' && event.entities.some((id) => id.toLowerCase().includes(needle)));
    case 'fetch':
      return event.partition.toLowerCase().includes(needle);
    case 'binding':
      return (event.binding.database ?? '').toLowerCase().includes(needle) || event.binding.state.includes(needle);
    case 'degradation':
      return event.scope.toLowerCase().includes(needle) || event.context.toLowerCase().includes(needle) || (event.error ?? '').toLowerCase().includes(needle);
  }
}

/**
 * What the stores did, newest first: every store's, or one store's (a store's view passes `store`). Degradation reports
 * name a scope rather than a store, so a store's view shows those whose scope starts with its name.
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
      if (store && ('store' in event ? event.store !== store : !event.scope.startsWith(store.replace(/_store$/, '')))) continue;
      if (needle && !matchesText(event, needle)) continue;
      matching.push(event);
    }
    return matching;
  }, [source, kinds, text, store, clearedAt]);

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
      {paused ? <div className="paused">Paused — {formatCount(events.length - paused.length)} newer events are waiting.</div> : null}
      {!shown.length ? (
        <Empty title="Nothing yet">
          Writes, fetches, moves between databases and degradation reports show up here as they happen. The app records them in development builds only.
        </Empty>
      ) : (
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
                <EventRow key={event.id} event={event} showStore={!store} open={open === event.id} onToggle={() => setOpen(open === event.id ? undefined : event.id)} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function EventRow({ event, showStore, open, onToggle }: { event: InspectorEvent; showStore: boolean; open: boolean; onToggle: () => void }) {
  const expandable = (event.kind === 'write' && event.entities !== 'all' && event.entities.length > 0) || event.kind === 'degradation';
  return (
    <>
      <tr className={`event event-${event.kind}${event.kind === 'degradation' && event.severity === 'error' ? ' event-error' : ''}`} onClick={expandable ? onToggle : undefined}>
        <td className="time">{formatClock(event.at)}</td>
        <td>
          <KindBadge kind={event.kind} />
        </td>
        {showStore ? <td>{'store' in event ? shortStoreName(event.store) : <span className="muted">—</span>}</td> : null}
        <td>
          <EventSummary event={event} />
          {expandable ? <span className="disclosure-mark muted"> {open ? '▾' : '▸'}</span> : null}
        </td>
      </tr>
      {open ? (
        <tr className="row-detail">
          <td colSpan={showStore ? 4 : 3}>
            {event.kind === 'write' && event.entities !== 'all' ? (
              <div className="entities">
                {event.entities.map((id) => (
                  <code key={id}>{id}</code>
                ))}
                {event.entityCount !== null && event.entityCount > event.entities.length ? (
                  <span className="muted">and {formatCount(event.entityCount - event.entities.length)} more</span>
                ) : null}
              </div>
            ) : event.kind === 'degradation' ? (
              <div className="degradation-detail">
                <div>{event.context}</div>
                {event.error ? <pre className="json">{event.error}</pre> : null}
              </div>
            ) : null}
          </td>
        </tr>
      ) : null}
    </>
  );
}

function EventSummary({ event }: { event: InspectorEvent }) {
  switch (event.kind) {
    case 'write':
      return (
        <span>
          <code>{event.partition}</code> → v{event.version} ·{' '}
          {event.entityCount === null ? 'every entity' : `${formatCount(event.entityCount)} ${event.entityCount === 1 ? 'entity' : 'entities'} changed`}
        </span>
      );
    case 'fetch':
      return (
        <span>
          <code>{event.partition}</code> · {formatFetchRows(event.rows)} · request {formatMs(event.fetchMs)} · write {formatMs(event.ingestMs)}
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
          <code>{event.scope}</code> {event.severity === 'info' ? <span className="muted">(notice)</span> : null}
          {event.first ? null : <span className="muted"> · repeat</span>}
          <span className="muted"> · {event.context.length > 120 ? `${event.context.slice(0, 120)}…` : event.context}</span>
        </span>
      );
  }
}
