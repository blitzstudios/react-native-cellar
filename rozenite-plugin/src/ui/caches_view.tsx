import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { InspectedCache, InspectedCacheEntries, StoreOverview } from '../shared/protocol';
import { Empty, ErrorBanner, JsonView } from './components';
import { formatAgo, formatBytes, formatCount } from './format';
import { errorMessage, useNow } from './use_cellar';
import type { CellarRpc } from './use_cellar';

/** How often the counts are read again while the tab is open, in ms: they move on every read, not only on writes. */
const REFRESH_MS = 1500;
const ENTRIES_PAGE = 25;

/** A cache's hits as a share of its lookups, or `null` before its first lookup. */
export function hitRate(cache: InspectedCache): number | null {
  const lookups = cache.hits + cache.stale + cache.absent;
  return lookups ? cache.hits / lookups : null;
}

/** What a cache's counts say about its size, if anything worth saying. */
export function cacheVerdict(cache: InspectedCache): string | undefined {
  if (!cache.hits && cache.stale + cache.absent >= 50) return 'never hit';
  if (cache.rereads > 0) return `${formatCount(cache.rereads)} evicted keys re-read`;
  return undefined;
}

export function heapLabel(bytes: number | undefined, partial?: boolean): string {
  if (bytes === undefined) return '—';
  return `${partial ? '≥ ' : '≈ '}${formatBytes(bytes)}`;
}

export function CachesView({ rpc, store }: { rpc: CellarRpc | null; store: StoreOverview }) {
  const [caches, setCaches] = useState<InspectedCache[]>();
  const [error, setError] = useState<string>();
  const [open, setOpen] = useState<string>();
  const now = useNow(REFRESH_MS);

  const load = useCallback(async () => {
    if (!rpc) return;
    try {
      setCaches(await rpc.method('caches').invoke({ store: store.name, heap: true }));
      setError(undefined);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, [rpc, store.name]);

  useEffect(() => {
    load();
  }, [load, now]);

  const list = caches ?? [];
  const totals = list.reduce(
    (sum, cache) => ({ entries: sum.entries + cache.entries, heap: sum.heap + (cache.heapBytes ?? 0), partial: sum.partial || !!cache.heapPartial }),
    { entries: 0, heap: 0, partial: false },
  );

  return (
    <div className="caches-view">
      {error ? <ErrorBanner message={error} onDismiss={() => setError(undefined)} /> : null}
      {caches && !caches.length ? (
        <Empty title="No caches" />
      ) : (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Cache</th>
                <th>Per</th>
                <th>Keyed by</th>
                <th>Entries</th>
                <th className="num">Heap</th>
                <th className="num">Hit rate</th>
                <th className="num">Hits</th>
                <th className="num" title="Built at an older version, before a write">
                  Stale
                </th>
                <th className="num" title="Never built, or evicted">
                  Absent
                </th>
                <th className="num">Evicted</th>
                <th className="num" title="Evicted keys asked for again">
                  Re-read
                </th>
                <th className="num">Builds</th>
                <th className="num" title="Builds that isEqual found unchanged">
                  Kept
                </th>
                <th>Since</th>
              </tr>
            </thead>
            <tbody>
              {list.map((cache) => {
                const rate = hitRate(cache);
                const verdict = cacheVerdict(cache);
                const fill = cache.max ? Math.min(1, cache.entries / cache.max) : 0;
                const isOpen = open === cache.cache;
                return (
                  <CacheRows key={cache.name} isOpen={isOpen} rpc={rpc} store={store} cache={cache} onToggle={() => setOpen(isOpen ? undefined : cache.cache)}>
                    <td>
                      <span className="disclosure-mark muted">{isOpen ? '▾' : '▸'}</span>
                      <code>{cache.cache}</code>
                      {verdict ? <div className="warning small">{verdict}</div> : null}
                    </td>
                    <td>{cache.kind}</td>
                    <td className="muted">{cache.keyedBy}</td>
                    <td>
                      <div className="meter" title={`${cache.entries} of ${cache.max}`}>
                        <div className="meter-fill" style={{ width: `${fill * 100}%` }} />
                      </div>
                      <span className="small">
                        {formatCount(cache.entries)} / {formatCount(cache.max)}
                      </span>
                    </td>
                    <td className="num">{heapLabel(cache.heapBytes, cache.heapPartial)}</td>
                    <td className="num">{rate === null ? '—' : `${Math.round(rate * 100)}%`}</td>
                    <td className="num">{formatCount(cache.hits)}</td>
                    <td className="num">{formatCount(cache.stale)}</td>
                    <td className="num">{formatCount(cache.absent)}</td>
                    <td className="num">{formatCount(cache.evictions)}</td>
                    <td className="num">{formatCount(cache.rereads)}</td>
                    <td className="num">{formatCount(cache.builds)}</td>
                    <td className="num">{formatCount(cache.reused)}</td>
                    <td>{formatAgo(cache.since, now)}</td>
                  </CacheRows>
                );
              })}
            </tbody>
            {list.length > 1 ? (
              <tfoot>
                <tr>
                  <td colSpan={3}>Total</td>
                  <td className="small">{formatCount(totals.entries)}</td>
                  <td className="num">{heapLabel(totals.heap, totals.partial)}</td>
                  <td colSpan={9} />
                </tr>
              </tfoot>
            ) : null}
          </table>
        </div>
      )}
    </div>
  );
}

function CacheRows({
  isOpen,
  onToggle,
  rpc,
  store,
  cache,
  children,
}: {
  isOpen: boolean;
  onToggle: () => void;
  rpc: CellarRpc | null;
  store: StoreOverview;
  cache: InspectedCache;
  children: ReactNode;
}) {
  const verdict = cacheVerdict(cache);
  return (
    <>
      <tr className={`clickable-row${verdict ? ' row-warning' : ''}${isOpen ? ' row-open' : ''}`} onClick={onToggle}>
        {children}
      </tr>
      {isOpen ? (
        <tr className="row-detail">
          <td colSpan={14}>
            <CacheEntries rpc={rpc} store={store} cache={cache} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

/** A cache's entries, most recently used first, a page at a time. */
function CacheEntries({ rpc, store, cache }: { rpc: CellarRpc | null; store: StoreOverview; cache: InspectedCache }) {
  const [page, setPage] = useState<InspectedCacheEntries>();
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<number>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!rpc) return;
    rpc
      .method('cacheEntries')
      .invoke({ store: store.name, cache: cache.cache, offset, limit: ENTRIES_PAGE })
      .then(setPage, (caught) => setError(errorMessage(caught)));
  }, [rpc, store.name, cache.cache, offset, cache.builds, cache.evictions]);

  if (error) return <div className="error-text">{error}</div>;
  if (!page) return <div className="muted">…</div>;
  if (!page.total) return <div className="muted">Empty</div>;
  const chosen = selected === undefined ? undefined : page.entries[selected];
  return (
    <div className="cache-entries">
      <div className="toolbar compact">
        <span className="muted">
          {formatCount(offset + 1)}–{formatCount(offset + page.entries.length)} of {formatCount(page.total)}
        </span>
        <button type="button" className="button button-small" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - ENTRIES_PAGE))}>
          ‹ Prev
        </button>
        <button type="button" className="button button-small" disabled={offset + page.entries.length >= page.total} onClick={() => setOffset(offset + ENTRIES_PAGE)}>
          Next ›
        </button>
      </div>
      <div className="cache-entries-body">
        <table className="table entries-table">
          <thead>
            <tr>
              <th>Key</th>
              <th className="num">Version</th>
              <th className="num">Heap</th>
            </tr>
          </thead>
          <tbody>
            {page.entries.map((entry, index) => (
              <tr key={`${entry.key.join('/')}-${index}`} className={`clickable-row${selected === index ? ' row-open' : ''}`} onClick={() => setSelected(selected === index ? undefined : index)}>
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
        <div className="entry-value">{chosen ? <JsonView value={chosen.value} /> : <div className="muted pad">Select an entry</div>}</div>
      </div>
    </div>
  );
}
