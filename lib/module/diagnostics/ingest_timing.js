"use strict";

/** Timings of the most recent partition fetches, each split into network time and write time. */

import { recordInspectorEvent } from "../inspector/events.js";
const CAPACITY = 128;

/** The timing of one partition fetch, which shows whether a slow load was the network or the write. */

/** One store's totals over the recorded fetches, which show where a session's fetch and write time went. */

const ring = [];

/** Records one fetch's timing, dropping the oldest past 128. Every partition fetch records one, 304s included. */
export function recordIngestTiming(timing) {
  ring.push(timing);
  if (ring.length > CAPACITY) ring.shift();
  recordInspectorEvent({
    kind: 'fetch',
    ...timing,
    store: timing.store.replace(/_ingest$/, '')
  });
}

/**
 * The recorded fetch timings, oldest first. Only the latest 128 are kept, so late in a session the launch's are gone.
 */
export function getIngestTimings() {
  return ring.slice();
}

/** Clears the recorded timings, so a measurement or test sees only its own. */
export function clearIngestTimings() {
  ring.length = 0;
}
const totalMs = roll => roll.fetchMs + roll.ingestMs;

/** Fetch timings totalled per store, most time first. 304s count as fetches with no rows. */
export function rollupIngestTimings(timings = ring) {
  const byStore = new Map();
  for (const timing of timings) {
    const roll = byStore.get(timing.store) ?? {
      store: timing.store,
      fetches: 0,
      fetchMs: 0,
      ingestMs: 0,
      chars: 0,
      rows: 0
    };
    roll.fetches += 1;
    roll.fetchMs += timing.fetchMs;
    roll.ingestMs += timing.ingestMs;
    roll.chars += timing.chars ?? 0;
    if (timing.rows > 0) roll.rows += timing.rows;
    byStore.set(timing.store, roll);
  }
  return [...byStore.values()].sort((left, right) => totalMs(right) - totalMs(left));
}
//# sourceMappingURL=ingest_timing.js.map