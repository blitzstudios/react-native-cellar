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

function Icon({ children, size = 15 }: { children: ReactNode; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {children}
    </svg>
  );
}

export function SaveIcon() {
  return (
    <Icon>
      <path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
      <path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7" />
      <path d="M7 3v4a1 1 0 0 0 1 1h7" />
    </Icon>
  );
}

export function CloseIcon() {
  return (
    <Icon size={13}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </Icon>
  );
}

export function OpenIcon() {
  return (
    <Icon>
      <path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />
    </Icon>
  );
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
