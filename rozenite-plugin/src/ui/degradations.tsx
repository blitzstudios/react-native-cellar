import { Fragment, useMemo, useState } from 'react';
import type { InspectorEvent } from '../shared/protocol';
import { Callsite, ExtraChips, shortPath, useSymbolicated } from './callsite';
import { Empty } from './components';
import { formatClock } from './format';

type Degradation = Extract<InspectorEvent, { kind: 'degradation' }>;

/** A scope as its rule and its subject: `player_stats_store_ingest.oversized_prime.week:…` → `oversized_prime` and `week:…`. */
export function splitScope(scope: string): { rule: string; subject: string } {
  const parts = scope.split('.');
  if (parts.length < 2) return { rule: scope, subject: '' };
  // `store.rule`, `store.rule.subject`, and `area.rule.subject` all put the rule second.
  return { rule: parts[1], subject: parts.length > 2 ? parts.slice(2).join('.') : parts[0] };
}

/**
 * A report's numbers without what its row already says: names that appear in its scope (the store, the partition) are
 * dropped, and a limit is folded into the number it limits, as `rows 9,422 / 5,000`.
 */
export function reportNumbers(event: Degradation): Record<string, string | number | boolean | null> | undefined {
  if (!event.extra) return undefined;
  const extra = event.extra;
  // `rows` pairs with `rowLimit` as well as `rowsLimit`.
  const limitOf = (key: string) => extra[`${key}Limit`] ?? extra[`${key.replace(/s$/, '')}Limit`];
  const limits = (key: string) => key.endsWith('Limit') && [key.slice(0, -5), `${key.slice(0, -5)}s`].some((base) => base in extra);
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(extra)) {
    if (limits(key)) continue;
    if (typeof value === 'string' && event.scope.includes(value)) continue;
    const limit = limitOf(key);
    out[key] = typeof value === 'number' && typeof limit === 'number' ? `${value.toLocaleString('en-US')} / ${limit.toLocaleString('en-US')}` : value;
  }
  return Object.keys(out).length ? out : undefined;
}

/** The first frame of the app's own code in a callsite, once symbolicated, as `file:line`. */
function FirstAppFrame({ stack }: { stack?: string }) {
  const frames = useSymbolicated(stack);
  if (!stack) return <span className="muted">—</span>;
  if (!frames) return <span className="muted">…</span>;
  const frame = frames.find((candidate) => !candidate.library);
  if (!frame) return <span className="muted">no app code</span>;
  return (
    <span title={frame.file}>
      <code>{frame.method}</code> <span className="muted">{shortPath(frame.file)}:{frame.line}</span>
    </span>
  );
}

/** Every degradation report, newest first, each on its own row. */
export function Degradations({ events, after = 0 }: { events: readonly InspectorEvent[]; after?: number }) {
  const [open, setOpen] = useState<number>();
  const reports = useMemo(() => events.filter((event): event is Degradation => event.kind === 'degradation' && event.id > after).reverse(), [events, after]);
  if (!reports.length) return <Empty title="None" />;
  return (
    <table className="table degradations-table">
      <thead>
        <tr>
          <th>Time</th>
          <th>Rule</th>
          <th>Subject</th>
          <th>Numbers</th>
          <th>Callsite</th>
        </tr>
      </thead>
      <tbody>
        {reports.map((report) => {
          const { rule, subject } = splitScope(report.scope);
          const isOpen = open === report.id;
          return (
            <Fragment key={report.id}>
              <tr className={`clickable-row${report.severity === 'error' ? ' event-error' : ''}`} onClick={() => setOpen(isOpen ? undefined : report.id)}>
                <td className="time">
                  <span className="disclosure-mark muted">{isOpen ? '▾' : '▸'}</span>
                  {formatClock(report.at)}
                </td>
                <td>
                  <code>{rule}</code>
                  {report.severity !== 'error' ? <span className="muted"> {report.severity === 'info' ? 'notice' : 'advice'}</span> : null}
                </td>
                <td className="subject" title={report.scope}>
                  <code>{subject}</code>
                </td>
                <td>
                  <ExtraChips extra={reportNumbers(report)} />
                </td>
                <td>
                  <FirstAppFrame stack={report.callsite} />
                </td>
              </tr>
              {isOpen ? (
                <tr className="row-detail">
                  <td colSpan={5}>
                    <div className="degradation-detail">
                      <code>{report.scope}</code>
                      <div className="muted">{report.context}</div>
                      {report.error ? <pre className="json">{report.error}</pre> : null}
                      {report.callsite ? <Callsite stack={report.callsite} kind={report.callsiteKind} /> : null}
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
