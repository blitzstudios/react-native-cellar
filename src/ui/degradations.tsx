import { Fragment, useMemo, useState } from 'react';
import type { InspectorEvent } from '../shared/protocol';
import { Callsite, ExtraChips, shortPath, useSymbolicated } from './callsite';
import { Empty } from './components';
import { formatAgo, formatCount } from './format';

type Degradation = Extract<InspectorEvent, { kind: 'degradation' }>;

/** One scope's reports: how many, when, and the latest one's numbers and callsite. */
export interface DegradationGroup {
  scope: string;
  severity: 'error' | 'info';
  count: number;
  firstAt: number;
  lastAt: number;
  latest: Degradation;
}

/** The reports grouped by scope, most recent first. */
export function groupDegradations(events: readonly InspectorEvent[]): DegradationGroup[] {
  const groups = new Map<string, DegradationGroup>();
  for (const event of events) {
    if (event.kind !== 'degradation') continue;
    const group = groups.get(event.scope);
    if (!group) {
      groups.set(event.scope, { scope: event.scope, severity: event.severity, count: event.count ?? 1, firstAt: event.at, lastAt: event.at, latest: event });
      continue;
    }
    group.count = Math.max(group.count + 1, event.count ?? 0);
    group.lastAt = event.at;
    group.latest = event;
  }
  return Array.from(groups.values()).sort((a, b) => b.lastAt - a.lastAt);
}

/** A scope as its rule and its subject: `player_stats_store_ingest.oversized_prime.week:…` → `oversized_prime` and `week:…`. */
export function splitScope(scope: string): { rule: string; subject: string } {
  const parts = scope.split('.');
  if (parts.length < 2) return { rule: scope, subject: '' };
  // `store.rule`, `store.rule.subject`, and `area.rule.subject` all put the rule second.
  return { rule: parts[1], subject: parts.length > 2 ? parts.slice(2).join('.') : parts[0] };
}

/** The first frame of the app's own code in a callsite, once symbolicated, as `file:line`. */
function FirstAppFrame({ stack }: { stack?: string }) {
  const frames = useSymbolicated(stack);
  if (!stack) return <span className="muted">—</span>;
  if (!frames) return <span className="muted">…</span>;
  const frame = frames.find((candidate) => !candidate.library) ?? frames[0];
  if (!frame) return <span className="muted">—</span>;
  return (
    <span title={frame.file}>
      <code>{frame.method}</code> <span className="muted">{shortPath(frame.file)}:{frame.line}</span>
    </span>
  );
}

/** Every scope that has reported, with its count, numbers and callsite. */
export function Degradations({ events, now, store }: { events: readonly InspectorEvent[]; now: number; store?: (scope: string) => boolean }) {
  const [open, setOpen] = useState<string>();
  const groups = useMemo(() => groupDegradations(events).filter((group) => !store || store(group.scope)), [events, store]);
  if (!groups.length) {
    return (
      <Empty title="No degradations reported">
        A degradation is a store losing a benefit it should have had: the native shredder, its own database, a cache that earns its heap, or a partition
        sized to what its reads use.
      </Empty>
    );
  }
  return (
    <table className="table degradations-table">
      <thead>
        <tr>
          <th>Rule</th>
          <th>Subject</th>
          <th className="num">Count</th>
          <th>Numbers</th>
          <th>Callsite</th>
          <th>Last</th>
        </tr>
      </thead>
      <tbody>
        {groups.map((group) => {
          const { rule, subject } = splitScope(group.scope);
          const isOpen = open === group.scope;
          const { latest } = group;
          return (
            <Fragment key={group.scope}>
              <tr className={`clickable-row${group.severity === 'error' ? ' event-error' : ''}`} onClick={() => setOpen(isOpen ? undefined : group.scope)}>
                <td>
                  <span className="disclosure-mark muted">{isOpen ? '▾' : '▸'}</span>
                  <code>{rule}</code>
                  {group.severity === 'info' ? <span className="muted"> notice</span> : null}
                </td>
                <td className="subject" title={group.scope}>
                  <code>{subject}</code>
                </td>
                <td className="num">{formatCount(group.count)}</td>
                <td>
                  <ExtraChips extra={latest.extra} />
                </td>
                <td>
                  <FirstAppFrame stack={latest.callsite} />
                </td>
                <td>{formatAgo(group.lastAt, now)}</td>
              </tr>
              {isOpen ? (
                <tr className="row-detail">
                  <td colSpan={6}>
                    <div className="degradation-detail">
                      <div>
                        <code>{group.scope}</code>
                      </div>
                      <div className="muted">{latest.context}</div>
                      {latest.error ? <pre className="json">{latest.error}</pre> : null}
                      {latest.callsite ? <Callsite stack={latest.callsite} kind={latest.callsiteKind} /> : <div className="muted">No callsite recorded.</div>}
                    </div>
                  </td>
                </tr>
              ) : null}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}
