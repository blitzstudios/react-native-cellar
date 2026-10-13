/** How the panel writes numbers, sizes, durations and times. */

import type { StoreOverview } from '../shared/protocol';

export function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatMs(ms: number): string {
  if (ms < 10) return `${ms.toFixed(1)} ms`;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

/** `at` relative to `now`, such as `12s ago`. */
export function formatAgo(at: number | null | undefined, now: number): string {
  if (!at) return '—';
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 1) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m ago`;
}

export function formatClock(at: number): string {
  const date = new Date(at);
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

/** What a fetch's row count means: a 304 and an unchanged body are negative. */
export function formatFetchRows(rows: number): string {
  if (rows === -1) return '304 not modified';
  if (rows === -2) return 'unchanged body';
  return `${formatCount(rows)} rows`;
}

/** A store's name without the `_store` every store's name ends in. */
export function shortStoreName(name: string): string {
  return name.replace(/_store$/, '');
}

/** A string that holds a JSON object or array, parsed; anything else is `undefined`. */
export function parseJsonText(value: unknown): unknown {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!(text.startsWith('{') || text.startsWith('['))) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function isBlob(value: unknown): value is { $blob: true; bytes: number; hex: string } {
  return typeof value === 'object' && value !== null && (value as { $blob?: unknown }).$blob === true;
}

/** A cell's value on one line. */
export function formatCell(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (isBlob(value)) return `<blob ${formatBytes(value.bytes)}>`;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Rows as CSV, with a header row. */
export function toCsv(columns: readonly string[], rows: readonly unknown[][]): string {
  const cell = (value: unknown): string => {
    const text = value === null || value === undefined ? '' : isBlob(value) ? value.hex : typeof value === 'object' ? JSON.stringify(value) : String(value);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [columns.map(cell).join(','), ...rows.map((row) => row.map(cell).join(','))].join('\n');
}

/** One row as an object keyed by column, its JSON text parsed; a repeated column name gets a `(2)`, `(3)`… after it. */
export function rowObject(columns: readonly string[], row: readonly unknown[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  columns.forEach((column, index) => {
    let name = column;
    for (let n = 2; name in out; n += 1) name = `${column} (${n})`;
    const value = row[index] ?? null;
    out[name] = parseJsonText(value) ?? (isBlob(value) ? formatCell(value) : value);
  });
  return out;
}

/** Rows as a JSON array of objects keyed by column. */
export function toJsonRows(columns: readonly string[], rows: readonly unknown[][]): string {
  return JSON.stringify(
    rows.map((row) => Object.fromEntries(columns.map((column, index) => [column, row[index]]))),
    null,
    2,
  );
}

/** The params field's text as bind values: a JSON array, or empty for none. */
export function parseParams(text: string): { params: Array<string | number | null> } | { error: string } {
  const trimmed = text.trim();
  if (!trimmed) return { params: [] };
  try {
    const parsed: unknown = JSON.parse(trimmed.startsWith('[') ? trimmed : `[${trimmed}]`);
    if (!Array.isArray(parsed) || !parsed.every((value) => value === null || typeof value === 'string' || typeof value === 'number')) {
      return { error: 'Params are a JSON array of strings, numbers and nulls.' };
    }
    return { params: parsed as Array<string | number | null> };
  } catch {
    return { error: 'Params are a JSON array, such as ["nfl:2026", 4].' };
  }
}

/** A double-quoted SQL name. */
export function quoteName(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Field names that say what kind of partition a key is, shown first and set apart. */
const LEAD_FIELDS = new Set(['request', 'kind', 'type']);
const NUMERIC = /^-?\d+(\.\d+)?$/;

export interface PartitionLabelParts {
  lead?: string;
  /** Text values bare, then numbers after a label naming them, as `season 2026` or `game 202610515` for `gameId`. */
  parts: Array<{ label?: string; value: string }>;
}

/**
 * A partition key as a short label. Cellar keys a partition as its description's `name=value` pairs joined with `&`, so
 * the names are mostly noise: a value says what it is, except a number. A key in any other shape is one bare part.
 */
export function partitionLabel(key: string): PartitionLabelParts {
  if (!key) return { parts: [] };
  const pairs = key.split('&').map((pair) => {
    const at = pair.indexOf('=');
    return at > 0 ? [decode(pair.slice(0, at)), decode(pair.slice(at + 1))] : undefined;
  });
  if (pairs.some((pair) => !pair)) return { parts: [{ value: key }] };
  let lead: string | undefined;
  const text: PartitionLabelParts['parts'] = [];
  const numbers: PartitionLabelParts['parts'] = [];
  for (const [name, value] of pairs as Array<[string, string]>) {
    if (lead === undefined && LEAD_FIELDS.has(name)) lead = value;
    else if (NUMERIC.test(value)) numbers.push({ label: name.replace(/_?id$/i, '') || name, value });
    else text.push({ value });
  }
  return { ...(lead === undefined ? {} : { lead }), parts: [...text, ...numbers] };
}

/** A partition key's short label as plain text, for places that take no markup. */
export function partitionText(key: string): string {
  const { lead, parts } = partitionLabel(key);
  const words = [...(lead === undefined ? [] : [lead]), ...parts.map((part) => (part.label ? `${part.label} ${part.value}` : part.value))];
  return words.length ? words.join(' · ') : '(no key)';
}

function decode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

const storesRowsOnce = (store: StoreOverview) => store.summary.storedRows !== undefined;

/** The first rows a store stores: from `<table>__rows`, each once, where it has one, rather than the view over it. */
export function allRowsSql(store: StoreOverview): string {
  const { table } = store.schema;
  return `SELECT *\nFROM ${quoteName(storesRowsOnce(store) ? `${table}__rows` : table)}\nLIMIT 100`;
}

/**
 * The rows one partition holds, taking the partition key as its `?`, and with `entity` the entity's id as a second. Where
 * the store stores each row once, they come from `<table>__rows` through `<table>__members` rather than the view.
 */
export function partitionRowsSql(store: StoreOverview, entity = false): string {
  const { table, entityColumn } = store.schema;
  if (!storesRowsOnce(store)) return `SELECT *\nFROM ${quoteName(table)}\nWHERE partition_key = ?${entity ? ` AND ${quoteName(entityColumn)} = ?` : ''}`;
  return (
    `SELECT r.*\nFROM ${quoteName(`${table}__members`)} m\nJOIN ${quoteName(`${table}__rows`)} r ON r.rid = m.rid\n` +
    `WHERE m.partition_key = ?${entity ? ` AND r.${quoteName(entityColumn)} = ?` : ''}`
  );
}
