"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.createPushIngest = createPushIngest;
var _queryCore = require("@tanstack/query-core");
var _collections = require("../collections.js");
var _telemetry = require("../diagnostics/telemetry.js");
var _change_set = require("../table/change_set.js");
/**
 * The push ingest: how a store writes items that arrive by socket push rather than by fetch. Queued items are buffered
 * per partition (a partition is the set of rows one fetch returns and replaces), with only the latest item kept per id,
 * and written shortly after, outside the render that received them, with {@linkcode RowTable.upsert | upsert} in
 * chunks. After a write, the partitions whose rows changed are bumped with their change sets, so only readers of the
 * changed entities re-render. A chunk that fails to write is queued again and retried after a delay, unless a newer
 * item with the same id arrived meanwhile.
 */

// The core package, not `@tanstack/react-query`: the same batcher, without pulling React DOM in behind it.

const DEFAULT_CHUNK = 250;
const DEFAULT_RETRY_DELAY_MS = 1000;

/** How {@linkcode createPushIngest} turns a store's pushed items into rows and tells readers about them. */

/** A store's buffer for pushed items, as {@linkcode createPushIngest} creates it. */

/**
 * Creates the push ingest for a store whose rows (also) arrive by socket push. Items are queued per partition, with
 * only the latest kept per id, and written together shortly after with {@linkcode RowTable.upsert | upsert}, outside
 * the render that received them: a burst of pushes costs one write per row rather than one per push. Readers of the
 * changed entities re-render once the write finishes.
 */
function createPushIngest(config) {
  const {
    name,
    table,
    where,
    idOf,
    toRows,
    bump,
    onWrite
  } = config;
  const chunk = config.chunk ?? DEFAULT_CHUNK;
  const retryDelayMs = config.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const held = new Map();
  const pending = new Map();
  let flushScheduled = false;
  let flushing = false;
  function scheduleFlush(delayMs = 0) {
    if (flushScheduled || flushing) return;
    flushScheduled = true;
    setTimeout(() => {
      flushScheduled = false;
      runFlush().catch(error => {
        (0, _telemetry.reportStoreDegradation)({
          scope: `${name}.flush_aborted`,
          context: 'the push flush threw outside the write, leaving the partitions it had not reached unbumped and their readers stale until the next flush',
          error
        });
      });
    }, delayMs);
  }
  const bufferFor = key => (0, _collections.getOrCreate)(pending, key, () => new Map());

  /** Returns items to the buffer, keeping whatever newer push already sits under the same id. */
  function requeue(key, items) {
    const bucket = bufferFor(key);
    for (const item of items) {
      const id = idOf(item);
      if (!bucket.has(id)) bucket.set(id, item);
    }
  }
  async function runFlush() {
    if (flushing) return;
    flushing = true;
    let failed = false;
    try {
      while (pending.size) {
        const partitions = Array.from(pending.entries()).filter(([key]) => !held.has(key));
        // A held partition stays pending; its release is what schedules the flush that finally writes it.
        if (!partitions.length) break;
        partitions.forEach(([key]) => pending.delete(key));
        const touched = [];
        for (let index = 0; index < partitions.length; index += 1) {
          const [key, byId] = partitions[index];
          const items = Array.from(byId.values());
          const batches = (0, _collections.chunkList)(items, chunk);
          let changes = _change_set.NO_CHANGES;
          let written = 0;
          for (const batch of batches) {
            const rows = toRows(key, batch);
            if (rows.length) {
              try {
                // eslint-disable-next-line no-await-in-loop -- sequential by design: bound the JS thread per frame
                const result = await table.upsert(rows, {
                  chunk
                });
                changes = (0, _change_set.unionChanges)(changes, result.changes);
              } catch (error) {
                const unwritten = items.slice(written);
                requeue(key, unwritten);
                (0, _telemetry.reportStoreDegradation)({
                  scope: `${name}.flush`,
                  context: 'a batch of pushed rows failed to persist; it is requeued and retried after a delay',
                  error,
                  extra: {
                    partitionKey: String(key),
                    rowCount: rows.length,
                    requeued: unwritten.length
                  }
                });
                failed = true;
                break;
              }
            }
            written += batch.length;
          }
          // Only where rows changed: a push repeating what the table holds, or filtering down to nothing, wakes nobody.
          if (!(0, _change_set.isUnchanged)(changes)) touched.push([key, changes]);
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
          _queryCore.notifyManager.batch(() => {
            for (const [key, changes] of touched) bump(key, changes);
          });
        }
        if (failed) break;
      }
    } finally {
      flushing = false;
      // Rows waiting on a hold are the release's to schedule.
      const writable = Array.from(pending.keys()).some(key => !held.has(key));
      if (writable) scheduleFlush(failed ? retryDelayMs : 0);
    }
  }
  function hold(key) {
    held.set(key, (held.get(key) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const depth = (held.get(key) ?? 1) - 1;
      if (depth > 0) held.set(key, depth);else held.delete(key);
      if (!held.has(key)) scheduleFlush();
    };
  }
  function queue(key, item) {
    bufferFor(key).set(idOf(item), item);
    scheduleFlush();
  }
  return {
    queue,
    hold
  };
}

// Exported so the built declaration files keep these names in scope for the doc links above; an import that only a
// doc comment uses is dropped from them.
//# sourceMappingURL=push_ingest.js.map