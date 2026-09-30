import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { InspectedQueryResult, InspectorEvent, StoreOverview } from '../shared/protocol';
import { ErrorBanner, ValueDetail } from './components';
import { formatAgo, formatCount, formatMs, parseParams, quoteName, toCsv, toJsonRows } from './format';
import { ResultGrid } from './result_grid';
import type { SelectedCell } from './result_grid';
import { errorMessage, useLatestEventId, useNow, useThrottledEffect } from './use_cellar';
import type { CellarRpc } from './use_cellar';

/** What the editor holds for one store, kept while the panel switches between stores and tabs. */
export interface QueryDraft {
  sql: string;
  params: string;
  limit: number;
  live: boolean;
}

export const LIMITS = [100, 500, 2000, 10000];
const HISTORY_KEY = 'cellar-plugin:history';
const HISTORY_MAX = 30;
/** How often a live query re-runs while its store keeps writing, at most, in ms. */
const LIVE_INTERVAL_MS = 1000;

export function defaultDraft(store: StoreOverview): QueryDraft {
  return { sql: `SELECT *\nFROM ${quoteName(store.schema.table)}\nLIMIT 100`, params: '', limit: 500, live: false };
}

interface Snippet {
  label: string;
  sql: string;
  params?: string;
}

function snippetsFor(store: StoreOverview): Snippet[] {
  const { table, metaTable, entityColumn } = store.schema;
  const t = quoteName(table);
  const master = store.summary.binding.state === 'memory' ? 'sqlite_temp_master' : 'sqlite_master';
  return [
    { label: 'Rows in one partition', sql: `SELECT *\nFROM ${t}\nWHERE partition_key = ?`, params: '[""]' },
    { label: 'Rows per partition', sql: `SELECT partition_key, COUNT(*) AS rows, COUNT(DISTINCT ${quoteName(entityColumn)}) AS entities\nFROM ${t}\nGROUP BY partition_key\nORDER BY rows DESC` },
    { label: `One ${entityColumn} across partitions`, sql: `SELECT *\nFROM ${t}\nWHERE ${quoteName(entityColumn)} = ?\nORDER BY partition_key`, params: '[""]' },
    { label: 'ETags and descriptions', sql: `SELECT *\nFROM ${quoteName(metaTable)}\nORDER BY partition_key` },
    { label: 'Table and index definitions', sql: `SELECT type, name, sql\nFROM ${master}\nWHERE tbl_name IN (?, ?)`, params: JSON.stringify([table, metaTable]) },
    { label: 'Query plan', sql: `EXPLAIN QUERY PLAN\nSELECT *\nFROM ${t}\nWHERE partition_key = ?`, params: '[""]' },
    { label: 'Columns as SQLite sees them', sql: `PRAGMA table_xinfo(${quoteName(table)})` },
  ];
}

interface HistoryEntry {
  store: string;
  sql: string;
  params: string;
}

function readHistory(): HistoryEntry[] {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]') as HistoryEntry[];
  } catch {
    return [];
  }
}

function remember(entry: HistoryEntry): HistoryEntry[] {
  const next = [entry, ...readHistory().filter((item) => !(item.store === entry.store && item.sql === entry.sql && item.params === entry.params))].slice(0, HISTORY_MAX);
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  } catch {
    /* storage is full or off; the history is a convenience */
  }
  return next;
}

export function QueryView({
  rpc,
  store,
  events,
  draft,
  onDraftChange,
  runToken,
}: {
  rpc: CellarRpc | null;
  store: StoreOverview;
  events: readonly InspectorEvent[];
  draft: QueryDraft;
  onDraftChange: (draft: QueryDraft) => void;
  /** Changes when another view asks for the draft to run now, such as a partition's "Rows" action. */
  runToken: number;
}) {
  const [result, setResult] = useState<InspectedQueryResult>();
  const [error, setError] = useState<string>();
  const [running, setRunning] = useState(false);
  const [ranAt, setRanAt] = useState<number>();
  const [runs, setRuns] = useState(0);
  const [selected, setSelected] = useState<SelectedCell>();
  const [history, setHistory] = useState(readHistory);
  const [copied, setCopied] = useState<string>();
  const inFlight = useRef(false);
  const now = useNow();

  const run = useCallback(
    async (quiet = false, page?: number) => {
      if (!rpc || inFlight.current) return;
      const parsed = parseParams(draft.params);
      if ('error' in parsed) {
        setError(parsed.error);
        return;
      }
      inFlight.current = true;
      setRunning(true);
      try {
        // A fresh run starts at the first page; a live re-run keeps the page it is on.
        const offset = page ?? (quiet ? (result?.offset ?? 0) : 0);
        const next = await rpc
          .method('query', { timeoutMs: 60_000 })
          .invoke({ store: store.name, sql: draft.sql, params: parsed.params, limit: draft.limit, offset });
        setResult(next);
        setError(undefined);
        setRanAt(Date.now());
        setRuns((count) => count + 1);
        if (!quiet) setSelected(undefined);
        if (!quiet && page === undefined) setHistory(remember({ store: store.name, sql: draft.sql, params: draft.params }));
      } catch (caught) {
        setError(errorMessage(caught));
        if (!quiet) setResult(undefined);
      } finally {
        inFlight.current = false;
        setRunning(false);
      }
    },
    [rpc, store.name, draft, result?.offset],
  );

  useEffect(() => {
    if (runToken) run();
    // Only a new token runs the draft; a draft edit waits for the user.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runToken]);

  const latestWrite = useLatestEventId(events, (event) => (event.kind === 'write' || event.kind === 'binding') && event.store === store.name);
  useThrottledEffect(() => run(true), latestWrite, LIVE_INTERVAL_MS, draft.live && runs > 0 && !error);

  const snippets = useMemo(() => snippetsFor(store), [store]);
  const storeHistory = history.filter((entry) => entry.store === store.name);
  const set = (patch: Partial<QueryDraft>) => onDraftChange({ ...draft, ...patch });

  const copy = (label: string, text: string) => {
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(label);
      setTimeout(() => setCopied(undefined), 1200);
    });
  };

  const selectedValue = result && selected ? result.rows[selected.row]?.[selected.column] : undefined;

  return (
    <div className="query-view">
      <div className="editor">
        <textarea
          className="sql"
          spellCheck={false}
          value={draft.sql}
          aria-label="SQL"
          onChange={(event) => set({ sql: event.target.value })}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              run();
            } else if (event.key === 'Tab') {
              event.preventDefault();
              const target = event.currentTarget;
              const { selectionStart, selectionEnd, value } = target;
              set({ sql: `${value.slice(0, selectionStart)}  ${value.slice(selectionEnd)}` });
              requestAnimationFrame(() => target.setSelectionRange(selectionStart + 2, selectionStart + 2));
            }
          }}
        />
        <div className="editor-bar">
          <button type="button" className="button button-primary" onClick={() => run()} disabled={!rpc || running} title="Run (⌘↵)">
            {running ? 'Running…' : 'Run'}
          </button>
          <label className="field">
            <span>Params</span>
            <input
              className="params"
              value={draft.params}
              placeholder='["nfl:2026"]'
              spellCheck={false}
              aria-label="Params"
              onChange={(event) => set({ params: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === 'Enter') run();
              }}
            />
          </label>
          <label className="field">
            <span>Limit</span>
            <select value={draft.limit} onChange={(event) => set({ limit: Number(event.target.value) })} aria-label="Limit">
              {LIMITS.map((limit) => (
                <option key={limit} value={limit}>
                  {formatCount(limit)}
                </option>
              ))}
            </select>
          </label>
          <label className="toggle" title="Run again whenever this store writes">
            <input type="checkbox" checked={draft.live} onChange={(event) => set({ live: event.target.checked })} />
            <span>Live</span>
          </label>
          <span className="spacer" />
          <select
            className="menu"
            value=""
            aria-label="Snippets"
            onChange={(event) => {
              const snippet = snippets[Number(event.target.value)];
              if (snippet) set({ sql: snippet.sql, params: snippet.params ?? '' });
            }}
          >
            <option value="">Snippets…</option>
            {snippets.map((snippet, index) => (
              <option key={snippet.label} value={index}>
                {snippet.label}
              </option>
            ))}
          </select>
          <select
            className="menu"
            value=""
            aria-label="History"
            disabled={!storeHistory.length}
            onChange={(event) => {
              const entry = storeHistory[Number(event.target.value)];
              if (entry) set({ sql: entry.sql, params: entry.params });
            }}
          >
            <option value="">History…</option>
            {storeHistory.map((entry, index) => (
              <option key={index} value={index}>
                {entry.sql.replace(/\s+/g, ' ').slice(0, 80)}
              </option>
            ))}
          </select>
        </div>
      </div>

      {error ? <ErrorBanner message={error} onDismiss={() => setError(undefined)} /> : null}

      {result ? (
        <div className="result">
          <div className="result-bar">
            <span>
              {result.offset || result.truncated
                ? `Rows ${formatCount(result.offset + 1)}–${formatCount(result.offset + result.rows.length)}`
                : `${formatCount(result.rows.length)} ${result.rows.length === 1 ? 'row' : 'rows'}`}
              {result.truncated ? <span className="muted"> · more follow</span> : null}
            </span>
            <button type="button" className="button button-small" disabled={running || !result.offset} onClick={() => run(false, Math.max(0, result.offset - draft.limit))}>
              ‹ Prev
            </button>
            <button type="button" className="button button-small" disabled={running || !result.truncated} onClick={() => run(false, result.offset + draft.limit)}>
              Next ›
            </button>
            <span className="muted">· {formatMs(result.durationMs)}</span>
            {ranAt ? <span className="muted">· {draft.live ? `live, ran ${formatAgo(ranAt, now)}` : `ran ${formatAgo(ranAt, now)}`}</span> : null}
            <span className="spacer" />
            <button type="button" className="button button-small" disabled={!result.rows.length} onClick={() => copy('json', toJsonRows(result.columns, result.rows))}>
              {copied === 'json' ? 'Copied' : 'Copy JSON'}
            </button>
            <button type="button" className="button button-small" disabled={!result.rows.length} onClick={() => copy('csv', toCsv(result.columns, result.rows))}>
              {copied === 'csv' ? 'Copied' : 'Copy CSV'}
            </button>
          </div>
          <div className="result-body">
            {result.rows.length ? (
              <ResultGrid columns={result.columns} rows={result.rows} selected={selected} onSelect={setSelected} firstRow={result.offset + 1} />
            ) : (
              <div className="muted pad">No rows.</div>
            )}
            {selected && result.rows[selected.row] ? (
              <ValueDetail column={result.columns[selected.column]} value={selectedValue ?? null} onClose={() => setSelected(undefined)} />
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
