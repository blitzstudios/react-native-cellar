/** Timings of the most recent partition fetches, each split into network time and write time. */

import { recordInspectorEvent } from '../inspector/events';
import type { WriteSteps } from '../table/change_set';

const CAPACITY = 128;

/** The timing of one partition fetch, which shows whether a slow load was the network or the write. */
export interface IngestTiming {
  /** The store's query root. */
  store: string;
  /** The partition's key. */
  partition: string;
  /** How long the request took, in ms. */
  fetchMs: number;
  /** How long writing the rows took, in ms. */
  ingestMs: number;
  /** The response body's length in characters; null for a 304. */
  chars: number | null;
  /** How many rows were written: `-1` for a 304, `-2` for a body identical to the last one. */
  rows: number;
  /** When the write finished, as a `Date.now()` timestamp. */
  at: number;
  /** Where the write's time went, for a body that was written. */
  steps?: WriteSteps;
}

/** One store's totals over the recorded fetches, which show where a session's fetch and write time went. */
export interface IngestRollup {
  /** The store's query root. */
  store: string;
  /** How many fetches, 304s included. */
  fetches: number;
  /** Total request time, in ms. */
  fetchMs: number;
  /** Total write time, in ms. */
  ingestMs: number;
  /** Total response size, in characters. */
  chars: number;
  /** Total rows written. */
  rows: number;
}

const ring: IngestTiming[] = [];

/** Records one fetch's timing, dropping the oldest past 128. Every partition fetch records one, 304s included. */
export function recordIngestTiming(timing: IngestTiming): void {
  ring.push(timing);
  if (ring.length > CAPACITY) ring.shift();
  recordInspectorEvent({ kind: 'fetch', ...timing, store: timing.store.replace(/_ingest$/, '') });
}

/**
 * The recorded fetch timings, oldest first. Only the latest 128 are kept, so late in a session the launch's are gone.
 */
export function getIngestTimings(): IngestTiming[] {
  return ring.slice();
}

/** Clears the recorded timings, so a measurement or test sees only its own. */
export function clearIngestTimings(): void {
  ring.length = 0;
}

const totalMs = (roll: IngestRollup): number => roll.fetchMs + roll.ingestMs;

/** Fetch timings totalled per store, most time first. 304s count as fetches with no rows. */
export function rollupIngestTimings(timings: readonly IngestTiming[] = ring): IngestRollup[] {
  const byStore = new Map<string, IngestRollup>();
  for (const timing of timings) {
    const roll = byStore.get(timing.store) ?? { store: timing.store, fetches: 0, fetchMs: 0, ingestMs: 0, chars: 0, rows: 0 };
    roll.fetches += 1;
    roll.fetchMs += timing.fetchMs;
    roll.ingestMs += timing.ingestMs;
    roll.chars += timing.chars ?? 0;
    if (timing.rows > 0) roll.rows += timing.rows;
    byStore.set(timing.store, roll);
  }
  return [...byStore.values()].sort((left, right) => totalMs(right) - totalMs(left));
}
