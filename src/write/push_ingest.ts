/**
 * The push ingest: how a store writes items that arrive by socket push rather than by fetch. Queued items are buffered
 * per partition (a partition is the set of rows one fetch returns and replaces), with only the latest item kept per id,
 * and written shortly after, outside the render that received them, with {@linkcode RowTable.upsert | upsert} in
 * chunks. After a write, the partitions whose rows changed are bumped with their change sets, so only readers of the
 * changed entities re-render. A chunk that fails to write is queued again and retried after a delay, unless a newer
 * item with the same id arrived meanwhile.
 */

// The core package, not `@tanstack/react-query`: the same batcher, without pulling React DOM in behind it.
import { notifyManager } from '@tanstack/query-core';

import { chunkList, getOrCreate } from '../collections';
import { RowShape, RowTable } from '../table/types';
import { reportStoreDegradation } from '../diagnostics/telemetry';
import { ChangeSet, isUnchanged, NO_CHANGES, unionChanges } from '../table/change_set';
import type { PartitionFetchSpec, PartitionKeySpec } from '../define_partitions';

const DEFAULT_CHUNK = 250;
const DEFAULT_RETRY_DELAY_MS = 1000;

/** How {@linkcode createPushIngest} turns a store's pushed items into rows and tells readers about them. */
export interface PushIngestConfig<Item, Row extends RowShape, Key> {
  /** The store's name, used in error reports. */
  name: string;
  /** The store's row table, which the rows are upserted into. It needs a primary key. */
  table: RowTable<Row>;
  /**
   * The column values that pick out a partition's rows in the table, such as `{ league: 'nfl' }`: the store's
   * {@linkcode PartitionKeySpec.where | key.where}.
   */
  where: (key: Key) => Partial<Row>;
  /**
   * The id a queued item is deduplicated by within its partition: when several items with the same id are queued before
   * a write, only the latest is written. Two items that should both be written need different ids, such as a stat
   * line's own id rather than its player's.
   */
  idOf: (item: Item) => string;
  /**
   * Turns a batch of a partition's queued items into table rows. Every row must belong to that partition; an item can
   * produce no rows, and is then skipped.
   */
  toRows: (key: Key, items: readonly Item[]) => Row[];
  /**
   * Tells the partition's readers about a write, with its change set: the entity id (such as a `player_id`) of each row
   * that was new or different. Only readers of the whole partition and of those entities re-render. Not called for a
   * write that changed nothing.
   */
  bump: (key: Key, changes: ChangeSet) => void;
  /**
   * Called for each partition whose rows a write changed, before {@linkcode PushIngestConfig.bump | bump}, such as to
   * delete the partition's ETag so the next fetch downloads a full body instead of getting a 304 that would miss the
   * pushed rows.
   */
  onWrite: (key: Key) => void;
  /** How many rows to write per transaction; 250 by default. The JS thread is given back between transactions. */
  chunk?: number;
  /** How long to wait before retrying items whose write failed, in ms; 1000 by default. */
  retryDelayMs?: number;
}

/** A store's buffer for pushed items, as {@linkcode createPushIngest} creates it. */
export interface PushIngest<Item, Key> {
  /**
   * Queues one pushed item for the partition the key names. Queued items are written together, soon after and outside
   * the current render; an item replaces any queued item with the same id.
   */
  queue: (key: Key, item: Item) => void;
  /**
   * Holds the partition's queued items (they stay queued and unwritten) until the returned function is called, which
   * then writes them. Pass it as the partition's {@linkcode PartitionFetchSpec.holdWrites | fetch.holdWrites}: a fetch
   * replaces the whole partition, so an item written while the request was in flight would be overwritten by the older
   * response. Holds on one partition can overlap, and the items are written once every hold is released; calling a
   * release twice does nothing.
   */
  hold: (key: Key) => () => void;
}

/**
 * Creates the push ingest for a store whose rows (also) arrive by socket push. Items are queued per partition, with
 * only the latest kept per id, and written together shortly after with {@linkcode RowTable.upsert | upsert}, outside
 * the render that received them: a burst of pushes costs one write per row rather than one per push. Readers of the
 * changed entities re-render once the write finishes.
 */
export function createPushIngest<Item, Row extends RowShape, Key>(config: PushIngestConfig<Item, Row, Key>): PushIngest<Item, Key> {
  const { name, table, where, idOf, toRows, bump, onWrite } = config;
  const chunk = config.chunk ?? DEFAULT_CHUNK;
  const retryDelayMs = config.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;

  const held = new Map<Key, number>();
  const pending = new Map<Key, Map<string, Item>>();
  let flushScheduled = false;
  let flushing = false;

  function scheduleFlush(delayMs = 0): void {
    if (flushScheduled || flushing) return;
    flushScheduled = true;
    setTimeout(() => {
      flushScheduled = false;
      runFlush().catch((error) => {
        reportStoreDegradation({
          scope: `${name}.flush_aborted`,
          context: 'the push flush threw outside the write, leaving the partitions it had not reached unbumped and their readers stale until the next flush',
          error,
        });
      });
    }, delayMs);
  }

  const bufferFor = (key: Key): Map<string, Item> => getOrCreate(pending, key, () => new Map<string, Item>());

  /** Returns items to the buffer, keeping whatever newer push already sits under the same id. */
  function requeue(key: Key, items: readonly Item[]): void {
    const bucket = bufferFor(key);
    for (const item of items) {
      const id = idOf(item);
      if (!bucket.has(id)) bucket.set(id, item);
    }
  }

  async function runFlush(): Promise<void> {
    if (flushing) return;
    flushing = true;
    let failed = false;
    try {
      while (pending.size) {
        const partitions = Array.from(pending.entries()).filter(([key]) => !held.has(key));
        // A held partition stays pending; its release is what schedules the flush that finally writes it.
        if (!partitions.length) break;
        partitions.forEach(([key]) => pending.delete(key));
        const touched: Array<[Key, ChangeSet]> = [];
        for (let index = 0; index < partitions.length; index += 1) {
          const [key, byId] = partitions[index];
          const items = Array.from(byId.values());
          const batches = chunkList(items, chunk);
          let changes: ChangeSet = NO_CHANGES;
          let written = 0;
          for (const batch of batches) {
            const rows = toRows(key, batch);
            if (rows.length) {
              try {
                // eslint-disable-next-line no-await-in-loop -- sequential by design: bound the JS thread per frame
                const result = await table.upsert(rows, { chunk });
                changes = unionChanges(changes, result.changes);
              } catch (error) {
                const unwritten = items.slice(written);
                requeue(key, unwritten);
                reportStoreDegradation({
                  scope: `${name}.flush`,
                  context: 'a batch of pushed rows failed to persist; it is requeued and retried after a delay',
                  error,
                  extra: { partitionKey: String(key), rowCount: rows.length, requeued: unwritten.length },
                });
                failed = true;
                break;
              }
            }
            written += batch.length;
          }
          // Only where rows changed: a push repeating what the table holds, or filtering down to nothing, wakes nobody.
          if (!isUnchanged(changes)) touched.push([key, changes]);
          if (failed) {
            for (let rest = index + 1; rest < partitions.length; rest += 1) {
              requeue(partitions[rest][0], Array.from(partitions[rest][1].values()));
            }
            break;
          }
        }

        if (touched.length) {
          for (const [key] of touched) onWrite(key);
          // Batched so a flush that touched several partitions wakes each listener once.
          notifyManager.batch(() => {
            for (const [key, changes] of touched) bump(key, changes);
          });
        }
        if (failed) break;
      }
    } finally {
      flushing = false;
      // Rows waiting on a hold are the release's to schedule.
      const writable = Array.from(pending.keys()).some((key) => !held.has(key));
      if (writable) scheduleFlush(failed ? retryDelayMs : 0);
    }
  }

  function hold(key: Key): () => void {
    held.set(key, (held.get(key) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const depth = (held.get(key) ?? 1) - 1;
      if (depth > 0) held.set(key, depth);
      else held.delete(key);
      if (!held.has(key)) scheduleFlush();
    };
  }

  function queue(key: Key, item: Item): void {
    bufferFor(key).set(idOf(item), item);
    scheduleFlush();
  }

  return { queue, hold };
}

// Exported so the built declaration files keep these names in scope for the doc links above; an import that only a
// doc comment uses is dropped from them.
export type { PartitionFetchSpec, PartitionKeySpec, RowTable };
