import { useState } from 'react';
import type { ReactNode } from 'react';
import type { InspectedSummary } from '../shared/protocol';
import { formatBytes, formatCell, isBlob, parseJsonText } from './format';

type BindingState = InspectedSummary['binding']['state'];

const STATE_LABEL: Record<BindingState, string> = { database: 'database', memory: 'in memory', unbound: 'unbound' };
const STATE_TITLE: Record<BindingState, string> = {
  database: 'Its own database',
  memory: 'In-memory fallback',
  unbound: 'Unbound: reads are empty',
};

export function StateBadge({ state }: { state: BindingState }) {
  return (
    <span className={`badge badge-${state}`} title={STATE_TITLE[state]}>
      {STATE_LABEL[state]}
    </span>
  );
}

export function KindBadge({ kind }: { kind: string }) {
  return <span className={`badge badge-kind badge-kind-${kind}`}>{kind}</span>;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-title">{title}</div>
      {children ? <div className="empty-body">{children}</div> : null}
    </div>
  );
}

export function ErrorBanner({ message, onDismiss }: { message: string; onDismiss?: () => void }) {
  return (
    <div className="error-banner" role="alert">
      <span>{message}</span>
      {onDismiss ? (
        <button type="button" className="link" onClick={onDismiss}>
          dismiss
        </button>
      ) : null}
    </div>
  );
}

export function JsonView({ value }: { value: unknown }) {
  return <pre className="json">{JSON.stringify(value, null, 2)}</pre>;
}

/** A cell's whole value: JSON pretty-printed, a blob as hex, text as it is. */
export function ValueDetail({ column, value, onClose }: { column: string; value: unknown; onClose: () => void }) {
  const json = parseJsonText(value);
  const [copied, setCopied] = useState(false);
  const text = json !== undefined ? JSON.stringify(json, null, 2) : isBlob(value) ? value.hex : formatCell(value);
  return (
    <aside className="value-detail">
      <header>
        <span className="value-detail-title">{column}</span>
        <span className="muted">
          {value === null ? 'NULL' : isBlob(value) ? `blob · ${formatBytes(value.bytes)}${value.bytes > 64 ? ' (first 64 bytes)' : ''}` : json !== undefined ? 'JSON' : typeof value}
        </span>
        <span className="spacer" />
        <button
          type="button"
          className="button button-small"
          onClick={() => {
            navigator.clipboard?.writeText(text).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            });
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button type="button" className="button button-small" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </header>
      <pre className="json">{text}</pre>
    </aside>
  );
}

export function Stat({ label, value, title }: { label: string; value: ReactNode; title?: string }) {
  return (
    <div className="stat" title={title}>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

/** A column header that sorts by its key when clicked. */
export function SortHeader<K extends string>({
  label,
  sortKey,
  sort,
  onSort,
  align,
}: {
  label: string;
  sortKey: K;
  sort: { key: K; descending: boolean };
  onSort: (key: K) => void;
  align?: 'right';
}) {
  const active = sort.key === sortKey;
  return (
    <th className={align === 'right' ? 'num' : undefined} aria-sort={active ? (sort.descending ? 'descending' : 'ascending') : 'none'}>
      <button type="button" className="sort" onClick={() => onSort(sortKey)}>
        {label}
        <span className="sort-mark">{active ? (sort.descending ? '▼' : '▲') : ''}</span>
      </button>
    </th>
  );
}
