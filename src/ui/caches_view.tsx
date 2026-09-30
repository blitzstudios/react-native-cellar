import { useCallback, useEffect, useState } from 'react';
import type { InspectedCache, StoreOverview } from '../shared/protocol';
import { Empty, ErrorBanner } from './components';
import { formatAgo, formatCount } from './format';
import { errorMessage, useNow } from './use_cellar';
import type { CellarRpc } from './use_cellar';

/** How often the counts are read again while the tab is open, in ms: they move on every read, not only on writes. */
const REFRESH_MS = 1500;

/** A cache's hits as a share of its lookups, or `null` before its first lookup. */
export function hitRate(cache: InspectedCache): number | null {
  const lookups = cache.hits + cache.stale + cache.absent;
  return lookups ? cache.hits / lookups : null;
}

/** What a cache's counts say about its size, if anything worth saying. */
export function cacheVerdict(cache: InspectedCache): string | undefined {
  if (!cache.hits && cache.stale + cache.absent >= 50) return 'never hit: whatever reads it already holds the value';
  if (cache.rereads > 0) return `${formatCount(cache.rereads)} evicted keys read again: a larger max would have answered them`;
  return undefined;
}

/** The store's caches — values kept on the JS heap, per partition or per entity — and how each is earning its keep. */
export function CachesView({ rpc, store }: { rpc: CellarRpc | null; store: StoreOverview }) {
  const [caches, setCaches] = useState<InspectedCache[]>();
  const [error, setError] = useState<string>();
  const now = useNow(REFRESH_MS);

  const load = useCallback(async () => {
    if (!rpc) return;
    try {
      setCaches(await rpc.method('caches').invoke({ store: store.name }));
      setError(undefined);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, [rpc, store.name]);

  useEffect(() => {
    load();
  }, [load, now]);

  return (
    <div className="caches-view">
      <div className="toolbar">
        <span className="muted">
          Values the store keeps on the JS heap, built from its rows and kept until a write changes them. Counted since each cache was built; a store rebuilds
          its caches when it moves to another database.
        </span>
      </div>
      {error ? <ErrorBanner message={error} onDismiss={() => setError(undefined)} /> : null}
      {caches && !caches.length ? (
        <Empty title="No caches">This store declares no caches, or none has been built yet.</Empty>
      ) : (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Cache</th>
                <th>Per</th>
                <th>Keyed by</th>
                <th>Entries</th>
                <th className="num">Hit rate</th>
                <th className="num">Hits</th>
                <th className="num" title="Built at an older version, before a write">Stale</th>
                <th className="num" title="Never built, or evicted">Absent</th>
                <th className="num">Evicted</th>
                <th className="num" title="Evicted keys asked for again">Re-read</th>
                <th className="num">Builds</th>
                <th className="num" title="Builds that isEqual found unchanged, so readers kept the same object">Kept</th>
                <th>Since</th>
              </tr>
            </thead>
            <tbody>
              {(caches ?? []).map((cache) => {
                const rate = hitRate(cache);
                const verdict = cacheVerdict(cache);
                const fill = cache.max ? Math.min(1, cache.entries / cache.max) : 0;
                return (
                  <tr key={cache.name} className={verdict ? 'row-warning' : undefined} title={verdict}>
                    <td>
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
                    <td className="num">{rate === null ? '—' : `${Math.round(rate * 100)}%`}</td>
                    <td className="num">{formatCount(cache.hits)}</td>
                    <td className="num">{formatCount(cache.stale)}</td>
                    <td className="num">{formatCount(cache.absent)}</td>
                    <td className="num">{formatCount(cache.evictions)}</td>
                    <td className="num">{formatCount(cache.rereads)}</td>
                    <td className="num">{formatCount(cache.builds)}</td>
                    <td className="num">{formatCount(cache.reused)}</td>
                    <td>{formatAgo(cache.since, now)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
