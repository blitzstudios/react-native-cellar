/** Timings of the most recent partition fetches, each split into network time and write time. */
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
/** Records one fetch's timing, dropping the oldest past 128. Every partition fetch records one, 304s included. */
export declare function recordIngestTiming(timing: IngestTiming): void;
/**
 * The recorded fetch timings, oldest first. Only the latest 128 are kept, so late in a session the launch's are gone.
 */
export declare function getIngestTimings(): IngestTiming[];
/** Clears the recorded timings, so a measurement or test sees only its own. */
export declare function clearIngestTimings(): void;
/** Fetch timings totalled per store, most time first. 304s count as fetches with no rows. */
export declare function rollupIngestTimings(timings?: readonly IngestTiming[]): IngestRollup[];
//# sourceMappingURL=ingest_timing.d.ts.map